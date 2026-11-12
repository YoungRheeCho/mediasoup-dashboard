import type * as http from 'node:http';

import type { Collector } from '../collector/collector.js';
import type { Config } from '../config.js';
import type { ClusterView, K8sDiscovery } from '../k8s/discovery.js';
import type { OriginLivenessMonitor } from '../liveness/originMonitor.js';
import { createLogger } from '../log.js';
import type { SysinfoStore, SysinfoView } from './sysinfo.js';

const logger = createLogger('central');

/**
 * 통합 3D 화면(origin)의 데이터.
 *
 * edge들이 1초마다 heartbeat에 실어 보내는 실시간 값(live)과 origin 자신의 수집값을 합쳐
 * 서버·노드·시청자 전체를 하나의 응답으로 만든다. DB를 읽지 않는다 (1초 갱신이라 메모리 값만 쓴다).
 *
 *  - GET /api/central/snapshot : 현재 상태 한 번
 *  - GET /api/central/stream   : SSE. 1초마다 같은 형식을 밀어 준다 (이력은 싣지 않는다).
 *  - GET /api/central/history  : 그래프 이력 (30분, 1초 간격 1800개). 화면은 처음에 한 번 받고 이후 1초 값을 이어 붙인다.
 *                                ?viewer=<id> 를 붙이면 그 시청자의 이력도 함께 준다.
 *
 * 그래프 이력은 origin 메모리에만 둔다. origin 대시보드를 재시작하면 그 시점부터 다시 쌓인다.
 *
 * 자원 값(CPU·qdisc·throttle)의 출처 (resourceSource):
 *  - 'collector' : Metric-Collector가 한 번이라도 보냈으면 그 값만 쓴다.
 *                  edge CPU = 컨테이너 CPU(한도 대비), 노드 CPU = 노드 /proc/stat, qdisc drop, throttle.
 *                  수집기가 끊기면 값은 null("—")로 둔다 (다른 출처로 바꿔 끼우지 않는다).
 *  - 'sidecar'   : 수집기를 붙이지 않은 환경(로컬 등). edge CPU = worker CPU 합, 노드 CPU = 사이드카가 잰 /proc/stat.
 *                  qdisc drop·throttle은 없음(null).
 */

/** 이 화면에서 mock(예시 값)으로 채우는 항목. 화면이 MOCK 표시를 붙이고, docs/mock-data.md에 같은 목록이 있다. */
export const CENTRAL_MOCK_FIELDS: Record<string, string> = {
	'viewer.latePct': 'LATE 비율: 지표 정의가 정해지지 않아 loss와 viewer id로 만든 예시 값 (C1)',
	'edge.loadBalancingReason': '로드 밸런싱 사유: 실제 배정 규칙을 몰라 "배정 전 시청자 수"만 표시 (C3)',
	'viewer.name': '시청자 이름: 서버가 transport에 peerId를 넣지 않으면 mock 이름 (M1, nameMock=true인 시청자만)',
	'viewer.freezeCount': 'freeze·fps: 브라우저 보고가 없는 시청자는 mock (M2, clientReported=false인 시청자만)',
};

const STEP_MS = 1000;
const POINTS = 1800; // 30분, 1초 간격
const STALE_AFTER_S = 5; // 1초 신호가 이만큼 끊기면 화면에 "신호 지연"
/**
 * 이만큼 신호가 없던 edge는 3D 화면에서 뺀다 (기존 Edges 화면에는 남는다).
 * Pod 이름을 edge id로 쓰면 재시작마다 id가 바뀌어, 옛 id가 "신호 끊김"으로 계속 쌓이는 것을 막는다.
 */
const HIDE_AFTER_S = 600;

/** 1초 이력 한 칸. 값이 없으면 null */
type EdgeRec = { cpu: number | null; peak: number | null; viewers: number | null; thrMs: number | null; egressBps: number | null };
type NodeRec = { cpu: number | null; peak: number | null; drop: number | null; viewers: number | null };
type ViewerRec = { loss: number | null; rtt: number | null; fps: number | null; layer: number | null; freezing: number | null; bitrateBps: number | null };
type Slot<T> = { key: number; rec: T };

export type CentralViewer = {
	id: string;
	edgeId: string;
	roomId: string;
	name: string;
	nameMock: boolean;
	connectedAt: number | null;
	lossPct: number | null;
	rttMs: number | null;
	bitrateBps: number | null;
	layer: number | null;
	state: string | null;
	freezeCount: number | null;
	fps: number | null;
	clientReported: boolean;
	/** 지금 영상이 멈춰 있음 (브라우저 보고가 있는 시청자만) → 3D에서 연결선이 끊어진다 */
	freezing: boolean;
	/** MOCK (C1) */
	latePct: number;
};

export type CentralSnapshot = ReturnType<CentralView['snapshot']>;
export type CentralHistory = ReturnType<CentralView['history']>;

type Resources = {
	source: 'collector' | 'sidecar';
	pods: Map<string, SysinfoView['pods'][number]>;
	nodes: Map<string, SysinfoView['nodes'][number]>;
};

export class CentralView {
	readonly #edgeHist = new Map<string, Slot<EdgeRec>[]>();
	readonly #nodeHist = new Map<string, Slot<NodeRec>[]>();
	readonly #viewerHist = new Map<string, Slot<ViewerRec>[]>();
	readonly #clients = new Set<http.ServerResponse>();
	#timer: NodeJS.Timeout | null = null;
	#last: CentralSnapshot | null = null;

	constructor(
		private readonly opts: {
			config: Config;
			monitor: OriginLivenessMonitor;
			collector: () => Collector;
			k8s: K8sDiscovery | null;
			/** Metric-Collector가 보내는 노드·컨테이너 CPU, qdisc drop, throttle (없으면 null) */
			sysinfo?: SysinfoStore | null;
		}
	) {}

	start(): void {
		if (this.#timer) {
			return;
		}

		this.#timer = setInterval(() => this.#tick(), 1000);
		this.#tick();
	}

	stop(): void {
		if (this.#timer) {
			clearInterval(this.#timer);
			this.#timer = null;
		}

		for (const res of this.#clients) {
			res.end();
		}

		this.#clients.clear();
	}

	/** 정적 파일보다 먼저 SSE 경로를 처리한다. 처리했으면 true. */
	handleStream(req: http.IncomingMessage, res: http.ServerResponse): boolean {
		const url = new URL(req.url ?? '/', 'http://localhost');

		if (req.method !== 'GET' || url.pathname !== '/api/central/stream') {
			return false;
		}

		res.writeHead(200, {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-store',
			connection: 'keep-alive',
			'x-accel-buffering': 'no',
		});
		res.write('retry: 2000\n\n');
		this.#clients.add(res);
		req.on('close', () => this.#clients.delete(res));

		const snap = this.#last ?? this.snapshot();

		res.write(`data: ${JSON.stringify(snap)}\n\n`);

		return true;
	}

	#tick(): void {
		try {
			this.sample(Date.now());

			const snap = this.snapshot();

			this.#last = snap;

			if (this.#clients.size === 0) {
				return;
			}

			const payload = `data: ${JSON.stringify(snap)}\n\n`;

			for (const res of this.#clients) {
				res.write(payload);
			}
		} catch (error) {
			logger.warn('central tick failed: %s', (error as Error).stack ?? error);
		}
	}

	/** 1초마다 이력에 현재 값을 넣는다 (같은 초에 두 번 불리면 덮어쓴다). */
	sample(now: number): void {
		const key = Math.floor(now / STEP_MS);
		const res = this.#resources(now);
		const edges = this.#edges(now, res);
		const viewers = this.#viewers(edges);
		const egress = new Map<string, number>();

		for (const v of viewers) {
			if (v.bitrateBps !== null) {
				egress.set(v.edgeId, (egress.get(v.edgeId) ?? 0) + v.bitrateBps);
			}
		}

		for (const e of edges) {
			push(this.#edgeHist, e.id, key, {
				cpu: e.cpuPct,
				peak: e.cpuPeakPct,
				viewers: e.viewerCount,
				thrMs: e.throttledMs,
				egressBps: e.state === 'lost' || !e.liveSupported ? null : (egress.get(e.id) ?? 0),
			});
		}

		for (const n of this.#nodes(now, res)) {
			push(this.#nodeHist, n.name, key, { cpu: n.cpuPct, peak: n.cpuPeakPct, drop: n.qdiscDropPerSec, viewers: n.viewerCount });
		}

		for (const v of viewers) {
			push(this.#viewerHist, v.id, key, {
				loss: v.lossPct,
				rtt: v.rttMs,
				fps: v.fps,
				layer: v.layer,
				freezing: v.clientReported ? (v.freezing ? 1 : 0) : null,
				bitrateBps: v.bitrateBps,
			});
		}

		// 30분 넘게 값이 안 들어온 대상(퇴장한 시청자, 사라진 edge·노드)은 지운다
		for (const map of [this.#edgeHist, this.#nodeHist, this.#viewerHist] as Map<string, Slot<unknown>[]>[]) {
			for (const [id, list] of map) {
				if (!list.length || key - list[list.length - 1]!.key >= POINTS) {
					map.delete(id);
				}
			}
		}
	}

	/**
	 * 그래프 이력. 배열 길이 POINTS, 마지막 칸 = endSec(현재 초), 값이 없는 초는 null.
	 * viewerId를 주면 그 시청자 이력도 넣는다 (시청자 전체를 매번 보내면 커서 하나씩).
	 */
	history(now = Date.now(), viewerId?: string | null) {
		const endSec = Math.floor(now / STEP_MS);
		type Cols<T> = Record<keyof T, (number | null)[]>;
		const cols = <T extends Record<string, number | null>>(list: Slot<T>[] | undefined, fields: (keyof T & string)[]): Cols<T> => {
			const out = Object.fromEntries(fields.map(f => [f, new Array<number | null>(POINTS).fill(null)])) as Cols<T>;

			for (const { key, rec } of list ?? []) {
				const i = POINTS - 1 - (endSec - key);

				if (i >= 0 && i < POINTS) {
					for (const f of fields) {
						out[f][i] = rec[f] ?? null;
					}
				}
			}

			return out;
		};
		const all = <T extends Record<string, number | null>>(map: Map<string, Slot<T>[]>, fields: (keyof T & string)[]): Record<string, Cols<T>> =>
			Object.fromEntries([...map.keys()].map(id => [id, cols(map.get(id), fields)]));

		return {
			stepSec: STEP_MS / 1000,
			points: POINTS,
			/** 마지막 칸의 시각 (unix 초) */
			endSec,
			edges: all(this.#edgeHist, ['cpu', 'peak', 'viewers', 'thrMs', 'egressBps']),
			nodes: all(this.#nodeHist, ['cpu', 'peak', 'drop', 'viewers']),
			viewers:
				viewerId && this.#viewerHist.has(viewerId)
					? { [viewerId]: cols(this.#viewerHist.get(viewerId), ['loss', 'rtt', 'fps', 'layer', 'freezing', 'bitrateBps']) }
					: {},
		};
	}

	/** 자원 값 출처. 수집기 값이 한 번이라도 왔으면 수집기만 쓴다 (위 주석 참고). */
	#resources(now: number): Resources {
		const v = this.opts.sysinfo?.view(now) ?? null;

		if (!v?.seen) {
			return { source: 'sidecar', pods: new Map(), nodes: new Map() };
		}

		return { source: 'collector', pods: new Map(v.pods.map(p => [p.name, p])), nodes: new Map(v.nodes.map(n => [n.name, n])) };
	}

	snapshot(now = Date.now()) {
		const res = this.#resources(now);
		const edges = this.#edges(now, res);
		const nodes = this.#nodes(now, res);
		const latest = this.opts.collector().latest;
		const origin = latest?.mode === 'origin' ? latest : null;
		const sending = origin ? origin.broadcasterSamples.filter(b => (b.bitrateBps ?? 0) > 0).length : 0;
		const viewers = this.#viewers(edges);

		return {
			v: 1,
			generatedAt: now,
			mockFields: CENTRAL_MOCK_FIELDS,
			origin: {
				id: this.opts.config.serverId,
				nodeName: this.opts.config.nodeName,
				collectorOk: this.opts.collector().status.ok,
				broadcasters: { sending, idle: origin ? origin.broadcasterSamples.length - sending : 0 },
				rooms: origin?.rooms.length ?? 0,
			},
			/** CPU·qdisc·throttle 출처: 'collector'(Metric-Collector) | 'sidecar'(수집기 없음, qdisc·throttle 없음) */
			resourceSource: res.source,
			nodes,
			edges,
			viewers,
			cluster: this.#cluster(),
			/** Metric-Collector에서 받은 그대로 (POST /api/central/sysinfo). 화면 값은 위 edges·nodes에 이미 반영됨 */
			sysinfo: this.opts.sysinfo?.view(now) ?? null,
		};
	}

	/** edge들이 1초마다 보낸 시청자 목록을 합친다 */
	#viewers(edges: { id: string; state: string }[]): CentralViewer[] {
		const viewers: CentralViewer[] = [];

		for (const e of edges) {
			// 신호가 끊긴(lost) edge의 시청자는 마지막 값이 오래돼 믿을 수 없으므로 빼고, 서버 라벨로 끊김을 보여 준다.
			// 잠깐 지연(stale)일 때는 마지막 값을 그대로 둔다.
			if (e.state === 'lost') {
				continue;
			}

			for (const v of this.opts.monitor.liveOf(e.id)?.viewers ?? []) {
				const lossPct = v.lossRatio === null ? null : round(v.lossRatio * 100, 2);

				viewers.push({
					id: v.id,
					edgeId: e.id,
					roomId: v.roomId,
					name: v.name ?? `viewer-${v.id.slice(0, 4)}`,
					nameMock: v.name === null || v.nameMock,
					connectedAt: v.connectedAt,
					lossPct,
					rttMs: v.rttMs === null ? null : Math.round(v.rttMs),
					bitrateBps: v.bitrateBps,
					layer: v.spatialLayer,
					state: v.transportState,
					freezeCount: v.freezeCount,
					fps: v.fps === null ? null : round(v.fps, 1),
					clientReported: v.clientReported,
					freezing: v.freezing === true,
					latePct: mockLatePct(v.id, v.lossRatio),
				});
			}
		}

		return viewers;
	}

	#edges(now: number, res = this.#resources(now)) {
		const pods = this.opts.k8s?.view.pods ?? [];

		return this.opts.monitor
			.statuses(now)
			.filter(s => s.state !== 'lost' || (s.ageSeconds !== null && s.ageSeconds < HIDE_AFTER_S))
			.map(s => {
			const live = this.opts.monitor.liveOf(s.edgeId);
			// 노드: edge가 직접 알려 준 값(NODE_NAME) → k8s Pod 목록에서 같은 이름의 Pod → 모름
			const pod = pods.find(p => p.role === 'edge' && p.name === s.edgeId);
			const stale = s.state !== 'lost' && s.ageSeconds !== null && s.ageSeconds >= STALE_AFTER_S;
			// 수집기의 pod 이름 = edge id (MSDASH_SERVER_ID = Pod 이름)
			const sys = res.pods.get(s.edgeId) ?? null;
			const workerCpu = live?.cpuPct === null || live?.cpuPct === undefined ? null : round(live.cpuPct, 1);

			return {
				id: s.edgeId,
				state: stale ? ('stale' as const) : s.state,
				reason: stale ? `${s.ageSeconds}초 동안 실시간 신호 없음` : s.reason,
				ageSeconds: s.ageSeconds,
				nodeName: live?.nodeName ?? pod?.nodeName ?? sys?.node ?? null,
				dashboardUrl: s.dashboardUrl,
				/** collector: 컨테이너 CPU(한도 대비, 100을 잠깐 넘을 수 있음) / sidecar: worker CPU 합 */
				cpuPct: res.source === 'collector' ? (sys?.cpuPct == null ? null : round(sys.cpuPct, 1)) : workerCpu,
				/** 그 1초 안의 0.1초 구간 CPU 사용률 중 최대. 수집기만 준다 (없으면 null) */
				cpuPeakPct: res.source === 'collector' && sys?.cpuPeakPct != null ? round(sys.cpuPeakPct, 1) : null,
				workerCpuPct: workerCpu,
				/** 직전 1초 동안 throttle로 멈춘 시간(ms)과 주기 비율(%). 수집기가 없으면 null */
				throttledMs: sys?.throttledMs == null ? null : round(sys.throttledMs, 1),
				throttledPct: sys?.throttledPct == null ? null : round(sys.throttledPct, 1),
				hostCpuPct: live?.hostCpuPct ?? null,
				workerCount: live?.workerCount ?? null,
				viewerCount: s.state === 'lost' ? 0 : live ? live.viewers.length : s.viewerCount,
				collectMs: live?.collectMs ?? null,
				skippedCycles: live?.skippedCycles ?? null,
				eventLoopLagMs: live?.eventLoopLagMs ?? null,
				/** false면 옛 edge(1초 실시간 값을 보내지 않음): 시청자 목록이 비어 있다 */
				liveSupported: live !== null,
			};
		});
	}

	/**
	 * 노드 목록: k8s 조회 결과 + 수집기가 보낸 노드 + edge/origin이 알려 준 노드 이름.
	 * CPU·qdisc: 수집기 값. 수집기가 없으면 CPU는 그 노드의 Pod(사이드카)가 잰 /proc/stat 값, qdisc는 null.
	 */
	#nodes(now: number, res = this.#resources(now)) {
		const edges = this.#edges(now, res);
		const cpuReports = new Map<string, number[]>();
		const add = (node: string | null, cpu: number | null) => {
			if (node && cpu !== null) {
				cpuReports.set(node, [...(cpuReports.get(node) ?? []), cpu]);
			}
		};
		const latest = this.opts.collector().latest;

		add(this.opts.config.nodeName, latest?.collector.hostCpuPct ?? null);

		for (const e of edges) {
			add(e.nodeName, e.hostCpuPct);
		}

		const k8s = this.opts.k8s?.view;
		const names = new Set<string>();

		if (k8s?.nodes.length) {
			k8s.nodes.forEach(n => names.add(n.name));
		}

		res.nodes.forEach(n => names.add(n.name));
		edges.forEach(e => names.add(e.nodeName ?? '(노드 정보 없음)'));

		if (this.opts.config.nodeName) {
			names.add(this.opts.config.nodeName);
		}

		return [...names].sort().map(name => {
			const cpus = cpuReports.get(name) ?? [];
			const k = k8s?.nodes.find(n => n.name === name) ?? null;
			const sys = res.nodes.get(name) ?? null;
			const sidecarCpu = cpus.length ? round(cpus.reduce((a, b) => a + b, 0) / cpus.length, 1) : null;
			const nodeEdges = edges.filter(e => (e.nodeName ?? '(노드 정보 없음)') === name);

			return {
				name,
				cpuPct: res.source === 'collector' ? (sys?.cpuPct == null ? null : round(sys.cpuPct, 1)) : sidecarCpu,
				cpuPeakPct: res.source === 'collector' && sys?.cpuPeakPct != null ? round(sys.cpuPeakPct, 1) : null,
				/** 물리 NIC root qdisc drop (/s). 수집기가 없으면 null */
				qdiscDropPerSec: sys?.qdiscDropsPerSec == null ? null : round(sys.qdiscDropsPerSec, 1),
				edgeIds: nodeEdges.map(e => e.id),
				/** 이 노드에 있는 edge들의 시청자 수 합 (edge가 1초마다 보낸 값을 origin이 더함) */
				viewerCount: nodeEdges.reduce((sum, e) => sum + (e.viewerCount ?? 0), 0),
				hasOrigin: name === this.opts.config.nodeName,
				ready: k ? k.ready : null,
				cpuCores: k?.cpuCores ?? null,
				internalIp: k?.internalIp ?? null,
			};
		});
	}

	#cluster(): (Pick<ClusterView, 'ok' | 'error' | 'pods'> & { enabled: true; updatedAt: number | null; nodeCount: number }) | { enabled: false } {
		const k = this.opts.k8s;

		if (!k) {
			return { enabled: false };
		}

		const v = k.view;

		return { enabled: true, ok: v.ok, error: v.error, updatedAt: v.updatedAt?.getTime() ?? null, nodeCount: v.nodes.length, pods: v.pods };
	}
}

function push<T>(map: Map<string, Slot<T>[]>, id: string, key: number, rec: T): void {
	let list = map.get(id);

	if (!list) {
		list = [];
		map.set(id, list);
	}

	const last = list[list.length - 1];

	if (last && last.key === key) {
		last.rec = rec;
	} else {
		list.push({ key, rec });
	}

	while (list.length && key - list[0]!.key >= POINTS) {
		list.shift();
	}
}

/**
 * LATE 비율 mock (C1). 지표 정의가 정해지지 않아 예시 값으로 둔다.
 * 같은 viewer는 늘 비슷한 값이 나오도록 id로 기본값(0~0.6%)을 정하고, 최근 loss가 높으면 함께 올라간다.
 */
export function mockLatePct(id: string, lossRatio: number | null): number {
	const base = (fnv(id) % 60) / 100;
	const fromLoss = lossRatio === null ? 0 : lossRatio * 100 * 1.3;

	return round(Math.min(5, base + fromLoss), 1);
}

function fnv(s: string): number {
	let h = 0x811c9dc5;

	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}

	return h >>> 0;
}

function round(v: number, digits: number): number {
	const f = 10 ** digits;

	return Math.round(v * f) / f;
}
