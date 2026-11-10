import type * as http from 'node:http';

import type { Collector } from '../collector/collector.js';
import type { Config } from '../config.js';
import type { ClusterView, K8sDiscovery } from '../k8s/discovery.js';
import type { OriginLivenessMonitor } from '../liveness/originMonitor.js';
import { createLogger } from '../log.js';

const logger = createLogger('central');

/**
 * 통합 3D 화면(origin)의 데이터.
 *
 * edge들이 1초마다 heartbeat에 실어 보내는 실시간 값(live)과 origin 자신의 수집값을 합쳐
 * 서버·노드·시청자 전체를 하나의 응답으로 만든다. DB를 읽지 않는다 (1초 갱신이라 메모리 값만 쓴다).
 *
 *  - GET /api/central/snapshot : 현재 상태 한 번
 *  - GET /api/central/stream   : SSE. 1초마다 같은 형식을 밀어 준다.
 *
 * 그래프 이력(30분, 30초 간격)은 origin 메모리에만 둔다. origin 대시보드를 재시작하면 그 시점부터 다시 쌓인다.
 */

/** 이 화면에서 mock(예시 값)으로 채우는 항목. 화면이 MOCK 표시를 붙이고, docs/mock-data.md에 같은 목록이 있다. */
export const CENTRAL_MOCK_FIELDS: Record<string, string> = {
	'viewer.latePct': 'LATE 비율: 지표 정의가 정해지지 않아 loss와 viewer id로 만든 예시 값 (C1)',
	'node.qdiscDropPerSec': 'qdisc drop: 수집 방식(tc / Prometheus)이 정해지지 않아 예시 값 (C2)',
	'edge.loadBalancingReason': '로드 밸런싱 사유: 실제 배정 규칙을 몰라 "배정 전 시청자 수"만 표시 (C3)',
	'viewer.name': '시청자 이름: 서버가 transport에 peerId를 넣지 않으면 mock 이름 (M1, nameMock=true인 시청자만)',
	'viewer.freezeCount': 'freeze·fps: 브라우저 보고가 없는 시청자는 mock (M2, clientReported=false인 시청자만)',
};

const STEP_MS = 30_000;
const POINTS = 61; // 30분 + 현재
const STALE_AFTER_S = 5; // 1초 신호가 이만큼 끊기면 화면에 "신호 지연"
/**
 * 이만큼 신호가 없던 edge는 3D 화면에서 뺀다 (기존 Edges 화면에는 남는다).
 * Pod 이름을 edge id로 쓰면 재시작마다 id가 바뀌어, 옛 id가 "신호 끊김"으로 계속 쌓이는 것을 막는다.
 */
const HIDE_AFTER_S = 600;

type Bucket = { key: number; cpuSum: number; cpuN: number; viewers: number | null; dropSum: number; dropN: number };

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
	/** MOCK (C1) */
	latePct: number;
};

export type CentralSnapshot = ReturnType<CentralView['snapshot']>;

export class CentralView {
	readonly #edgeBuckets = new Map<string, Bucket[]>();
	readonly #nodeBuckets = new Map<string, Bucket[]>();
	readonly #drop = new Map<string, number>(); // 노드별 qdisc drop mock 값
	readonly #clients = new Set<http.ServerResponse>();
	#timer: NodeJS.Timeout | null = null;
	#last: CentralSnapshot | null = null;

	constructor(
		private readonly opts: {
			config: Config;
			monitor: OriginLivenessMonitor;
			collector: () => Collector;
			k8s: K8sDiscovery | null;
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
			this.#sample(Date.now());

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

	/** 1초마다 이력 버킷에 현재 값을 넣는다. */
	#sample(now: number): void {
		const key = Math.floor(now / STEP_MS);

		for (const e of this.#edges(now)) {
			const b = bucketOf(this.#edgeBuckets, e.id, key);

			if (e.cpuPct !== null) {
				b.cpuSum += e.cpuPct;
				b.cpuN++;
			}

			if (e.viewerCount !== null) {
				b.viewers = e.viewerCount;
			}
		}

		for (const n of this.#nodes(now)) {
			const b = bucketOf(this.#nodeBuckets, n.name, key);

			if (n.cpuPct !== null) {
				b.cpuSum += n.cpuPct;
				b.cpuN++;
			}

			b.dropSum += this.#stepDrop(n.name);
			b.dropN++;
		}
	}

	/** qdisc drop mock (C2): 대부분 0이고 가끔 몇 초간 튄다. */
	#stepDrop(node: string): number {
		let v = this.#drop.get(node) ?? 0;

		if (v > 0) {
			v = Math.max(0, v + (Math.random() - 0.62) * 2.2);
		} else if (Math.random() < 0.012) {
			v = 2 + Math.random() * 8;
		}

		this.#drop.set(node, v);

		return v;
	}

	snapshot(now = Date.now()) {
		const edges = this.#edges(now);
		const nodes = this.#nodes(now);
		const latest = this.opts.collector().latest;
		const origin = latest?.mode === 'origin' ? latest : null;
		const sending = origin ? origin.broadcasterSamples.filter(b => (b.bitrateBps ?? 0) > 0).length : 0;
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
					latePct: mockLatePct(v.id, v.lossRatio),
				});
			}
		}

		const keyNow = Math.floor(now / STEP_MS);
		const series = (map: Map<string, Bucket[]>, id: string, pick: (b: Bucket) => number | null) => {
			const list = map.get(id) ?? [];
			const byKey = new Map(list.map(b => [b.key, b]));

			return Array.from({ length: POINTS }, (_, i) => {
				const b = byKey.get(keyNow - (POINTS - 1 - i));

				return b ? pick(b) : null;
			});
		};
		const cpuOf = (b: Bucket) => (b.cpuN ? round(b.cpuSum / b.cpuN, 1) : null);

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
			nodes: nodes.map(n => ({ ...n, qdiscDropPerSec: round(this.#drop.get(n.name) ?? 0, 1), qdiscMock: true })),
			edges,
			viewers,
			history: {
				stepSec: STEP_MS / 1000,
				points: POINTS,
				nodes: Object.fromEntries(
					nodes.map(n => [n.name, { cpu: series(this.#nodeBuckets, n.name, cpuOf), drop: series(this.#nodeBuckets, n.name, b => (b.dropN ? round(b.dropSum / b.dropN, 1) : null)) }])
				),
				edges: Object.fromEntries(
					edges.map(e => [e.id, { cpu: series(this.#edgeBuckets, e.id, cpuOf), viewers: series(this.#edgeBuckets, e.id, b => b.viewers) }])
				),
			},
			cluster: this.#cluster(),
		};
	}

	#edges(now: number) {
		const pods = this.opts.k8s?.view.pods ?? [];

		return this.opts.monitor
			.statuses(now)
			.filter(s => s.state !== 'lost' || (s.ageSeconds !== null && s.ageSeconds < HIDE_AFTER_S))
			.map(s => {
			const live = this.opts.monitor.liveOf(s.edgeId);
			// 노드: edge가 직접 알려 준 값(NODE_NAME) → k8s Pod 목록에서 같은 이름의 Pod → 모름
			const pod = pods.find(p => p.role === 'edge' && p.name === s.edgeId);
			const stale = s.state !== 'lost' && s.ageSeconds !== null && s.ageSeconds >= STALE_AFTER_S;

			return {
				id: s.edgeId,
				state: stale ? ('stale' as const) : s.state,
				reason: stale ? `${s.ageSeconds}초 동안 실시간 신호 없음` : s.reason,
				ageSeconds: s.ageSeconds,
				nodeName: live?.nodeName ?? pod?.nodeName ?? null,
				dashboardUrl: s.dashboardUrl,
				cpuPct: live?.cpuPct === null || live?.cpuPct === undefined ? null : round(live.cpuPct, 1),
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

	/** 노드 목록: k8s 조회가 되면 그 목록, 아니면 edge/origin이 알려 준 노드 이름. CPU는 그 노드의 Pod가 잰 /proc/stat 값. */
	#nodes(now: number) {
		const edges = this.#edges(now);
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

		edges.forEach(e => names.add(e.nodeName ?? '(노드 정보 없음)'));

		if (this.opts.config.nodeName) {
			names.add(this.opts.config.nodeName);
		}

		return [...names].sort().map(name => {
			const cpus = cpuReports.get(name) ?? [];
			const k = k8s?.nodes.find(n => n.name === name) ?? null;

			return {
				name,
				cpuPct: cpus.length ? round(cpus.reduce((a, b) => a + b, 0) / cpus.length, 1) : null,
				edgeIds: edges.filter(e => (e.nodeName ?? '(노드 정보 없음)') === name).map(e => e.id),
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

function bucketOf(map: Map<string, Bucket[]>, id: string, key: number): Bucket {
	let list = map.get(id);

	if (!list) {
		list = [];
		map.set(id, list);
	}

	let b = list[list.length - 1];

	if (!b || b.key !== key) {
		b = { key, cpuSum: 0, cpuN: 0, viewers: null, dropSum: 0, dropN: 0 };
		list.push(b);

		while (list.length > POINTS + 2) {
			list.shift();
		}
	}

	return b;
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
