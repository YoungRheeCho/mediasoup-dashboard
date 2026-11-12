/**
 * Metric-Collector가 1초마다 보내는 서버 자원 값 (origin 전용).
 *
 *   POST /api/central/sysinfo   수집기 → origin. 매번 전체 상태를 보낸다 (이전 값에 덧붙이지 않고 통째로 바꾼다).
 *   GET  /api/central/sysinfo   지금 들고 있는 값 (확인용)
 *
 * 값은 모두 수집기가 누적 카운터의 "직전 전송 이후 Δ"로 계산한 1초 구간 값이다.
 *  - nodes[].cpuPct            노드 CPU 사용률 (%) = 1 − Δidle/Δtotal (/proc/stat)
 *  - nodes[].cpuPeakPct        그 1초 안의 0.1초 구간 CPU 사용률 중 최대 (%)
 *  - nodes[].qdiscDropsPerSec  물리 NIC root qdisc drop (1초 동안의 합)
 *  - pods[].cpuPct             컨테이너 CPU 사용률, CPU 한도 대비 (%) = Δusage / Δt / limit. 한도가 없으면 null
 *  - pods[].cpuPeakPct         그 1초 안의 0.1초 구간 사용률(한도 대비) 중 최대 (%). 옛 수집기는 안 보냄 → null
 *  - pods[].throttledMs        1초 동안 throttle로 멈춘 시간의 합 (ms) = Δthrottled_usec / 1000
 *  - pods[].throttledPct       1초 동안의 CPU 주기 중 throttle된 비율 (%) = Δnr_throttled / Δnr_periods
 *  - ageMs                     수집기가 그 agent에서 마지막으로 값을 받은 뒤 지난 시간 (agent 스트림 끊김 판단)
 *
 * DB에 저장하지 않는다. 메모리에 마지막 한 번만 둔다.
 */

import { HttpError } from '../http/server.js';
import type { HttpServer } from '../http/server.js';

/** 이 시간보다 오래 새 POST가 없으면 수집기가 끊긴 것으로 본다. */
export const SYSINFO_STALE_MS = 3000;
/** agent 값이 이만큼 오래됐으면 (ageMs) 그 항목만 끊긴 것으로 본다. */
const ENTRY_STALE_MS = 3000;
const MAX_ENTRIES = 1024;
const MAX_NAME = 253; // k8s 이름 최대 길이

export type SysinfoNode = {
	/** k8s 노드 이름 */
	name: string;
	cpuPct: number | null;
	/** 그 1초 안의 0.1초 구간 사용률 중 최대. 옛 수집기는 보내지 않는다 (null) */
	cpuPeakPct: number | null;
	qdiscDropsPerSec: number | null;
	ageMs: number | null;
};

export type SysinfoPod = {
	/** pod 이름. edge 대시보드의 MSDASH_SERVER_ID(= pod 이름)와 같아야 화면에서 맞춰진다 */
	name: string;
	/** 이 pod가 떠 있는 k8s 노드 이름 */
	node: string | null;
	cpuPct: number | null;
	/** 그 1초 안의 0.1초 구간 사용률(한도 대비) 중 최대. 옛 수집기는 보내지 않는다 (null) */
	cpuPeakPct: number | null;
	throttledMs: number | null;
	throttledPct: number | null;
	ageMs: number | null;
};

export type SysinfoMessage = {
	/** 수집기 시각 (unix ms). 참고용, 끊김 판단은 origin이 받은 시각으로 한다 */
	t: number | null;
	nodes: SysinfoNode[];
	pods: SysinfoPod[];
};

export class SysinfoError extends Error {}

/** 들어온 JSON을 검사한다. 형식이 틀리면 SysinfoError (→ 400). 숫자 칸 하나가 이상하면 그 칸만 null. */
export function parseSysinfo(input: unknown): SysinfoMessage {
	if (!isObject(input)) {
		throw new SysinfoError('body must be a JSON object');
	}

	const nodes = list(input.nodes, 'nodes');
	const pods = list(input.pods, 'pods');

	return {
		t: num(input.t),
		nodes: dedupe(
			nodes.map((n, i) => {
				if (!isObject(n)) {
					throw new SysinfoError(`nodes[${i}] must be an object`);
				}

				return {
					name: name(n.name, `nodes[${i}].name`),
					cpuPct: pct(n.cpuPct),
					cpuPeakPct: pct(n.cpuPeakPct),
					qdiscDropsPerSec: nonNeg(n.qdiscDropsPerSec),
					ageMs: nonNeg(n.ageMs),
				};
			})
		),
		pods: dedupe(
			pods.map((p, i) => {
				if (!isObject(p)) {
					throw new SysinfoError(`pods[${i}] must be an object`);
				}

				return {
					name: name(p.name, `pods[${i}].name`),
					node: p.node === undefined || p.node === null ? null : name(p.node, `pods[${i}].node`),
					cpuPct: nonNeg(p.cpuPct), // 한도를 잠깐 넘는 순간이 있어 100% 위도 그대로 둔다
					cpuPeakPct: nonNeg(p.cpuPeakPct),
					throttledMs: nonNeg(p.throttledMs),
					throttledPct: pct(p.throttledPct),
					ageMs: nonNeg(p.ageMs),
				};
			})
		),
	};
}

export type SysinfoView = ReturnType<SysinfoStore['view']>;

export class SysinfoStore {
	#last: SysinfoMessage | null = null;
	#receivedAt = 0;
	#count = 0;

	receive(input: unknown, now = Date.now()): SysinfoMessage {
		const msg = parseSysinfo(input);

		this.#last = msg;
		this.#receivedAt = now;
		this.#count++;

		return msg;
	}

	/**
	 * 지금 쓸 수 있는 값. 수집기가 끊겼으면(connected=false) 항목을 비운다.
	 * 항목별로 agent가 끊겼으면(ageMs가 오래됨) stale=true이고 값은 null로 바꾼다 — 오래된 값을 지금 값처럼 보이지 않게.
	 */
	view(now = Date.now()) {
		const age = this.#last ? now - this.#receivedAt : null;
		const connected = age !== null && age <= SYSINFO_STALE_MS;
		const msg = connected ? this.#last! : null;
		const staleEntry = (a: number | null) => a !== null && a > ENTRY_STALE_MS;

		return {
			/** 한 번이라도 받은 적이 있는지 (수집기를 아직 안 붙였으면 false) */
			seen: this.#last !== null,
			connected,
			receivedAt: this.#last ? this.#receivedAt : null,
			ageMs: age,
			messages: this.#count,
			nodes: (msg?.nodes ?? []).map(n =>
				staleEntry(n.ageMs) ? { ...n, cpuPct: null, cpuPeakPct: null, qdiscDropsPerSec: null, stale: true } : { ...n, stale: false }
			),
			pods: (msg?.pods ?? []).map(p =>
				staleEntry(p.ageMs) ? { ...p, cpuPct: null, cpuPeakPct: null, throttledMs: null, throttledPct: null, stale: true } : { ...p, stale: false }
			),
		};
	}
}

export function registerSysinfoRoutes(http: HttpServer, store: SysinfoStore): void {
	http.route('POST', '/api/central/sysinfo', req => {
		try {
			const msg = store.receive(req.body);

			return { body: { ok: true, serverTime: Date.now(), nodes: msg.nodes.length, pods: msg.pods.length } };
		} catch (error) {
			if (error instanceof SysinfoError) {
				throw new HttpError(400, error.message);
			}

			throw error;
		}
	});
	http.route('GET', '/api/central/sysinfo', () => ({ body: store.view() }));
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function list(v: unknown, field: string): unknown[] {
	if (v === undefined || v === null) {
		return [];
	}

	if (!Array.isArray(v)) {
		throw new SysinfoError(`${field} must be an array`);
	}

	if (v.length > MAX_ENTRIES) {
		throw new SysinfoError(`${field} has more than ${MAX_ENTRIES} entries`);
	}

	return v;
}

function name(v: unknown, field: string): string {
	if (typeof v !== 'string' || v.length === 0 || v.length > MAX_NAME) {
		throw new SysinfoError(`${field} must be a non-empty string`);
	}

	return v;
}

function num(v: unknown): number | null {
	return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function nonNeg(v: unknown): number | null {
	const n = num(v);

	return n !== null && n >= 0 ? n : null;
}

function pct(v: unknown): number | null {
	const n = nonNeg(v);

	return n !== null && n <= 100.5 ? Math.min(n, 100) : null;
}

/** 같은 이름이 두 번 오면 뒤의 것을 쓴다. */
function dedupe<T extends { name: string }>(rows: T[]): T[] {
	return [...new Map(rows.map(r => [r.name, r])).values()];
}
