import type { RawRtpStat, RawSnapshot } from '../hookProtocol.js';
import { Topology, jitterMs, rtpEntries, round2 } from '../collector/topology.js';
import type { Batch, ViewerSampleRow } from '../db/rows.js';

/**
 * 화면의 "현재 값". 수집기가 캐시한 최근 원시 스냅숏 두 개와 정규화 묶음으로 만든다.
 * 화면 요청마다 mediasoup을 호출하지 않는다 (AGENT_TASK 4.3).
 */

/** 이번 수집에서 통계를 못 가져온 worker (훅 errors: "worker:<pid>: timeout"). 화면의 "w3 제외" 표시용. */
export function excludedWorkers(raw: RawSnapshot): number[] {
	const out = new Set<number>();

	for (const e of raw.errors) {
		const m = /^worker:(\d+):/.exec(e);

		if (m) {
			const w = raw.workers.find(x => x.pid === Number(m[1]));

			out.add(w?.idx ?? Number(m[1]));
		}
	}

	for (const w of raw.workers) {
		if (!w.usage) {
			out.add(w.idx ?? w.pid);
		}
	}

	return [...out].sort((a, b) => a - b);
}

/**
 * worker 재시작 감지. 같은 idx의 pid가 바뀌면 재시작으로 센다.
 * 사이드카가 켜진 이후만 알 수 있다 (uptime도 "관측 시작 이후").
 */
export class WorkerTracker {
	readonly #byIdx = new Map<number, { pid: number; firstSeenAt: number; restarts: number; lastRestartAt: number | null }>();

	observe(raw: RawSnapshot): void {
		for (const w of raw.workers) {
			const idx = w.idx ?? w.pid;
			const known = this.#byIdx.get(idx);

			if (!known) {
				this.#byIdx.set(idx, { pid: w.pid, firstSeenAt: raw.time, restarts: 0, lastRestartAt: null });
			} else if (known.pid !== w.pid) {
				known.pid = w.pid;
				known.restarts++;
				known.lastRestartAt = raw.time;
				known.firstSeenAt = raw.time;
			}
		}
	}

	info(idx: number) {
		return this.#byIdx.get(idx) ?? null;
	}
}

export type WorkerLive = {
	workerIdx: number;
	pid: number;
	status: 'running' | 'no_response';
	cpuPct: number | null;
	cpuUserPct: number | null;
	cpuSysPct: number | null;
	memRssBytes: number | null;
	maxRssBytes: number | null;
	contextSwitchesPerSec: number | null;
	routerCount: number;
	transportCount: number;
	producerCount: number;
	consumerCount: number;
	viewerCount: number;
	observedSinceAt: string | null;
	restarts: number;
	lastRestartAt: string | null;
	routers: Array<{ routerId: string; roomId: string | null; consumerCount: number; viewerCount: number }>;
};

export function workersLive(cur: RawSnapshot, prev: RawSnapshot | null, tracker: WorkerTracker): WorkerLive[] {
	const topo = new Topology(cur);
	const excluded = new Set(excludedWorkers(cur));
	const dt = prev ? (cur.time - prev.time) / 1000 : 0;

	return cur.workers
		.map(w => {
			const idx = w.idx ?? w.pid;
			const p = prev?.workers.find(x => x.pid === w.pid);
			const pct = (a?: number, b?: number) =>
				a !== undefined && b !== undefined && dt > 0 && a >= b ? round2(Math.min(100, ((a - b) / (dt * 1000)) * 100)) : null;
			const routers = cur.routers
				.filter(r => r.workerPid === w.pid)
				.map(r => {
					const transports = cur.transports.filter(t => t.routerId === r.id);

					return {
						routerId: r.id,
						roomId: topo.roomByRouter.get(r.id) ?? null,
						consumerCount: transports.reduce((a, t) => a + (topo.consumersByTransport.get(t.id)?.length ?? 0), 0),
						viewerCount: transports.filter(t => t.type === 'webrtc' && t.direction === 'consumer').length,
					};
				});
			const transports = cur.transports.filter(t => topo.routerWorkerPid.get(t.routerId) === w.pid);
			const csw = (u: typeof w.usage) => (u && u.ru_nvcsw !== undefined ? u.ru_nvcsw + (u.ru_nivcsw ?? 0) : undefined);
			const cswNow = csw(w.usage);
			const cswPrev = csw(p?.usage ?? null);
			const info = tracker.info(idx);

			return {
				workerIdx: idx,
				pid: w.pid,
				status: excluded.has(idx) ? ('no_response' as const) : ('running' as const),
				cpuPct: pct(w.usage ? w.usage.ru_utime + w.usage.ru_stime : undefined, p?.usage ? p.usage.ru_utime + p.usage.ru_stime : undefined),
				cpuUserPct: pct(w.usage?.ru_utime, p?.usage?.ru_utime),
				cpuSysPct: pct(w.usage?.ru_stime, p?.usage?.ru_stime),
				memRssBytes: w.rssBytes,
				maxRssBytes: w.usage ? w.usage.ru_maxrss * 1024 : null,
				contextSwitchesPerSec: cswNow !== undefined && cswPrev !== undefined && dt > 0 && cswNow >= cswPrev ? Math.round((cswNow - cswPrev) / dt) : null,
				routerCount: routers.length,
				transportCount: transports.length,
				producerCount: transports.reduce((a, t) => a + (topo.producersByTransport.get(t.id)?.length ?? 0), 0),
				consumerCount: routers.reduce((a, r) => a + r.consumerCount, 0),
				viewerCount: routers.reduce((a, r) => a + r.viewerCount, 0),
				observedSinceAt: info ? new Date(info.firstSeenAt).toISOString() : null,
				restarts: info?.restarts ?? 0,
				lastRestartAt: info?.lastRestartAt ? new Date(info.lastRestartAt).toISOString() : null,
				routers,
			};
		})
		.sort((a, b) => a.workerIdx - b.workerIdx);
}

export type StreamLive = {
	producerId: string;
	kind: string;
	codec: string | null;
	/** 예: "L2(High)". simulcast가 아니면 null */
	layer: string | null;
	spatialLayer: number | null;
	ssrc: number | null;
	bitrateBps: number | null;
	lossRatio: number | null;
	jitterMs: number | null;
	nackPerMin: number | null;
	pliPerMin: number | null;
	consumerCount: number | null;
};

/**
 * RTP stream별 현재 값 (Pipe 화면 "스트림별 수신 통계", Broadcasts "Piped producers", broadcaster simulcast 레이어).
 * 두 스냅숏 사이 차이로 loss·NACK·PLI를 구한다.
 */
export function streamsLive(
	cur: RawSnapshot,
	prev: RawSnapshot | null,
	pick: (p: RawSnapshot['producers'][number], topo: Topology) => boolean,
	countConsumers = false
): StreamLive[] {
	const topo = new Topology(cur);
	const dt = prev ? (cur.time - prev.time) / 1000 : 0;
	const out: StreamLive[] = [];

	for (const p of cur.producers) {
		if (!pick(p, topo)) {
			continue;
		}

		const before = prev?.producers.find(x => x.id === p.id && x.transportId === p.transportId);
		const entries = rtpEntries(p.stats, 'inbound-rtp');
		const consumers = countConsumers ? cur.consumers.filter(c => c.producerId === p.id && topo.transports.get(c.transportId)?.type === 'webrtc').length : null;

		entries.forEach((s, i) => {
			const b = rtpEntries(before?.stats ?? null, 'inbound-rtp').find(x => x.ssrc === s.ssrc);
			const d = (f: keyof RawRtpStat) => {
				const a = s[f];
				const c = b?.[f];

				return typeof a === 'number' && typeof c === 'number' && a >= c ? a - c : null;
			};
			const received = d('packetCount');
			const lost = d('packetsLost');
			const repaired = d('packetsRepaired') ?? 0;
			const expected = received !== null && lost !== null ? received - repaired + lost : null;
			const spatial = streamSpatialLayer(s, i, entries.length);

			out.push({
				producerId: p.id,
				kind: p.kind,
				codec: s.mimeType?.split('/')[1] ?? null,
				layer: layerName(spatial),
				spatialLayer: spatial,
				ssrc: s.ssrc ?? null,
				bitrateBps: s.bitrate !== undefined ? Math.round(s.bitrate) : null,
				lossRatio: expected && lost !== null ? lost / expected : null,
				jitterMs: jitterMs(s),
				nackPerMin: dt > 0 && d('nackCount') !== null ? round2((d('nackCount')! / dt) * 60) : null,
				pliPerMin: dt > 0 && d('pliCount') !== null ? round2((d('pliCount')! / dt) * 60) : null,
				consumerCount: consumers,
			});
		});
	}

	return out;
}

/** 이 서버가 내보내는 양 (transport sendBitrate 합). viewer(WebRTC)와 pipe를 나눈다. */
export function egressLive(cur: RawSnapshot): { totalBps: number; viewerBps: number; pipeBps: number } {
	let viewerBps = 0;
	let pipeBps = 0;

	for (const t of cur.transports) {
		const send = (t.stats ?? []).reduce((a, s) => a + (s.sendBitrate ?? 0), 0);

		if (t.type === 'pipe') {
			pipeBps += send;
		} else {
			viewerBps += send;
		}
	}

	return { totalBps: Math.round(viewerBps + pipeBps), viewerBps: Math.round(viewerBps), pipeBps: Math.round(pipeBps) };
}

/** viewer 수신 레이어 분포. spatial layer 2 이상 = L2(High), 1 = L1(Mid), 0 = L0(Low). */
export function layerMix(viewers: Array<Pick<ViewerSampleRow, 'spatialLayer'>>) {
	const mix = { high: 0, mid: 0, low: 0, unknown: 0 };

	for (const v of viewers) {
		if (v.spatialLayer === null) {
			mix.unknown++;
		} else if (v.spatialLayer >= 2) {
			mix.high++;
		} else if (v.spatialLayer === 1) {
			mix.mid++;
		} else {
			mix.low++;
		}
	}

	return mix;
}

/** 예: "L2(High)". 숫자는 mediasoup spatial layer 그대로, 괄호는 읽기 쉬운 이름 (web/src/lib/format.ts의 layerLabel과 같다). */
export function layerName(spatial: number | null): string | null {
	return spatial === null ? null : `L${spatial}(${spatial >= 2 ? 'High' : spatial === 1 ? 'Mid' : 'Low'})`;
}

/**
 * producer 수신 stream의 spatial layer 번호. simulcast가 아니면(stream 1개, rid 없음) null.
 * rid 끝 숫자("r0"·"r1"·"r2")를 먼저 쓰고, 없으면 getStats 순서(encoding 순서)를 쓴다.
 */
export function streamSpatialLayer(s: Pick<RawRtpStat, 'rid'>, index: number, count: number): number | null {
	const m = s.rid ? /(\d+)$/.exec(s.rid) : null;

	return m ? Number(m[1]) : count > 1 ? index : null;
}

/** 최근 묶음의 collector 행이 수집 시각을 갖는다. */
export function batchAgeSeconds(batch: Batch | null): number | null {
	return batch ? Math.round((Date.now() - batch.time.getTime()) / 1000) : null;
}
