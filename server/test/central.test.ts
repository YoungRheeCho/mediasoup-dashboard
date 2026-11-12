import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AlertEvaluator } from '../src/alerts/evaluator.js';
import { CentralView, mockLatePct } from '../src/central/central.js';
import { SysinfoStore } from '../src/central/sysinfo.js';
import type { Collector } from '../src/collector/collector.js';
import { EdgeNormalizer } from '../src/collector/normalizeEdge.js';
import type { CycleContext } from '../src/collector/types.js';
import { loadConfig } from '../src/config.js';
import { BatchDownsampler, mergeBatches } from '../src/db/downsample.js';
import type { EdgeBatch } from '../src/db/rows.js';
import type { OriginStore } from '../src/db/store.js';
import type { RawSnapshot } from '../src/hookProtocol.js';
import { EdgeLivenessSource } from '../src/liveness/edgeReporter.js';
import { OriginLivenessMonitor } from '../src/liveness/originMonitor.js';
import { parseLivenessMessage } from '../src/liveness/message.js';
import { SimSource } from '../src/sources/simSource.js';

const ctx: CycleContext = { collectDurationMs: 10, skipped: false, hostCpuPct: 40, mockEnabled: true, intervalMs: 1000 };

/** 시뮬레이터 스냅숏을 stepMs 간격으로 만든다 (시뮬레이터는 Date.now 경과로 카운터를 늘린다). */
async function snapshots(count: number, stepMs: number): Promise<RawSnapshot[]> {
	const config = loadConfig({ MSDASH_MODE: 'edge', MSDASH_SIM_ROOMS: '2', MSDASH_SIM_VIEWERS: '15', MSDASH_SIM_WORKERS: '2' });
	const sim = new SimSource(config, 11);
	const out: RawSnapshot[] = [];
	const realNow = Date.now;
	const t0 = realNow();

	for (let i = 0; i < count; i++) {
		Date.now = () => t0 + i * stepMs;

		try {
			out.push(structuredClone(await sim.snapshot()));
		} finally {
			Date.now = realNow;
		}
	}

	return out;
}

test('config: 1s collection, 10s DB writes, spread 60% of the interval by default', () => {
	const c = loadConfig({});

	assert.equal(c.collectIntervalMs, 1000);
	assert.equal(c.dbWriteIntervalMs, 10000);
	assert.equal(c.hookSpreadMs, 600);
	assert.equal(c.liveness.intervalMs, 1000);
	assert.ok(c.hookTimeoutMs >= 3000);
	assert.equal(loadConfig({ MSDASH_HOOK_SPREAD_MS: '0' }).hookSpreadMs, 0);
	assert.equal(loadConfig({ MSDASH_COLLECT_INTERVAL_MS: '10000' }).dbWriteIntervalMs, 10000, 'old 10s setup still works');
});

test('downsample: ten 1s batches merge into one batch equal to a single 10s delta', async () => {
	const snaps = await snapshots(11, 1000);
	const fine = new EdgeNormalizer();
	const batches = snaps.map(s => fine.normalize(s, ctx) as EdgeBatch);
	// 같은 구간을 10초 간격 한 번으로 잰 값
	const coarse = new EdgeNormalizer();

	coarse.normalize(snaps[0]!, ctx);

	const ten = coarse.normalize(snaps[10]!, { ...ctx, intervalMs: 10000 }) as EdgeBatch;
	const merged = mergeBatches(batches.slice(1)) as EdgeBatch;
	// 시뮬레이터는 viewer가 들어오고 나간다. 10초 내내 있던 viewer만 같은 delta여야 한다.
	const always = new Set(snaps.slice(1).reduce<string[] | null>((acc, _s, i) => {
		const ids = batches[i + 1]!.viewerSamples.map(r => r.viewerId);

		return acc ? acc.filter(id => ids.includes(id)) : ids;
	}, null));
	const allIds = new Set(batches.slice(1).flatMap(b => b.viewerSamples.map(r => r.viewerId)));

	assert.ok(always.size > 10);
	assert.equal(merged.viewerSamples.length, allIds.size, 'one row per viewer');

	for (const row of ten.viewerSamples.filter(r => always.has(r.viewerId))) {
		const m = merged.viewerSamples.find(r => r.viewerId === row.viewerId)!;

		assert.equal(m.packetsExpected, row.packetsExpected, `expected packets of ${row.viewerId}`);
		assert.equal(m.packetsLost, row.packetsLost, `lost packets of ${row.viewerId}`);
		assert.equal(m.time.getTime(), batches[10]!.time.getTime());
	}

	for (const row of ten.pipeSamples) {
		const m = merged.pipeSamples.find(r => r.producerId === row.producerId && r.roomId === row.roomId)!;

		assert.equal(m.packetsExpected, row.packetsExpected);
		assert.equal(m.packetsLost, row.packetsLost);
	}

	// bigint 칸: 평균을 내도 정수여야 DB가 받는다 ("invalid input syntax for type bigint")
	const odd = [batches[1]!, batches[2]!].map((b, i) => structuredClone({
		...b,
		viewerSamples: b.viewerSamples.map(r => ({ ...r, bitrateBps: 1000 + i })),
		pipeSamples: b.pipeSamples.map(r => ({ ...r, bitrateBps: 2000 + i })),
		roomSamples: b.roomSamples.map(r => ({ ...r, outBitrateBps: 3000 + i, inBitrateBps: 4000 + i })),
	}));
	const two = mergeBatches(odd) as EdgeBatch;
	const bps = [
		...two.viewerSamples.map(r => r.bitrateBps),
		...two.pipeSamples.map(r => r.bitrateBps),
		...two.roomSamples.flatMap(r => [r.outBitrateBps, r.inBitrateBps]),
	];

	assert.ok(bps.length > 0);
	assert.ok(bps.every(v => Number.isInteger(v)), `bitrate averages are integers: ${bps.slice(0, 4).join(',')}`);

	assert.equal(merged.workers.length, ten.workers.length);
	assert.equal(merged.viewerSessionStarts.length, batches.slice(1).reduce((a, b) => a + b.viewerSessionStarts.length, 0));
});

test('downsample: flushes every 10th 1s batch, keeps the rest for shutdown', async () => {
	const snaps = await snapshots(25, 1000);
	const n = new EdgeNormalizer();
	const d = new BatchDownsampler(10000);
	const out: number[] = [];

	snaps.forEach((s, i) => {
		const b = n.normalize(s, ctx);

		if (d.add(b)) {
			out.push(i);
		}
	});
	assert.deepEqual(out, [9, 19]);
	assert.ok(d.flush(), 'remaining 5 batches');
	assert.equal(d.flush(), null);
});

test('edge live payload: viewers with 5s loss window, removed on session end, survives JSON', async () => {
	const config = loadConfig({ MSDASH_SERVER_ID: 'edge-a', NODE_NAME: 'node-1' });
	const source = new EdgeLivenessSource(config, () => ({
		ok: true,
		lastSuccessAt: new Date(),
		lastAttemptAt: new Date(),
		lastError: null,
		consecutiveFailures: 0,
		skippedCycles: 2,
		lastDurationMs: 10,
		source: 'sim',
	}));
	const snaps = await snapshots(4, 1000);
	const n = new EdgeNormalizer();

	for (const s of snaps) {
		source.addBatch(n.normalize(s, ctx) as EdgeBatch);
	}

	const live = source.live!;
	const lastCount = live.viewers.length;

	assert.equal(live.nodeName, 'node-1');
	assert.equal(live.skippedCycles, 2);
	assert.equal(live.hostCpuPct, 40);
	assert.ok(live.viewers.length > 20);
	assert.ok(live.viewers.every(v => v.lossRatio === null || (v.lossRatio >= 0 && v.lossRatio <= 1)));
	assert.ok(live.viewers.some(v => v.name && v.nameMock), 'mock names are flagged (M1)');

	const msg = parseLivenessMessage(JSON.parse(JSON.stringify(source.take())));

	assert.equal(msg.live?.viewers.length, lastCount);

	// 세션 종료 → 다음 묶음부터 목록에서 빠진다
	const last = n.normalize(snaps[3]!, ctx) as EdgeBatch;
	const gone = live.viewers[0]!.id;

	source.addBatch({ ...last, viewerSamples: last.viewerSamples.filter(v => v.viewerId !== gone), viewerSessionEnds: [{ viewerId: gone, disconnectedAt: new Date(), disconnectReason: null }] });
	assert.equal(source.live!.viewers.length, last.viewerSamples.length - (last.viewerSamples.some(v => v.viewerId === gone) ? 1 : 0));
	assert.ok(!source.live!.viewers.some(v => v.id === gone));
});

test('origin: 1s heartbeats are saved every 10s with summed pipe deltas; central view merges edges', async () => {
	const saved: Array<{ recvPacketsLost: number | null; recvPacketsExpected: number | null }> = [];
	const store = {
		getEdges: async () => [],
		upsertEdge: async () => {},
		saveHeartbeat: async (h: { recvPacketsLost: number | null; recvPacketsExpected: number | null }) => void saved.push(h),
	} as unknown as OriginStore;
	const ev = new AlertEvaluator({ getRules: async () => [], getOpenAlerts: async () => [], openAlert: async () => 1, updateAlert: async () => {}, resolveAlert: async () => {} } as never);

	await ev.init().catch(() => {});

	const monitor = new OriginLivenessMonitor(store, ev);
	const viewer = (id: string, loss: number | null) => ({
		id, roomId: 'r1', name: null, nameMock: false, connectedAt: 0, lossRatio: loss, rttMs: 30, bitrateBps: 1e6,
		spatialLayer: 2, transportState: 'connected', clientReported: false, freezeCount: null, fps: null,
	});
	const msg = (edgeId: string, node: string, viewers: ReturnType<typeof viewer>[]) => ({
		v: 1, edgeId, dashboardUrl: `http://${edgeId}`, ip: null, region: null, ok: true, okReason: null,
		viewerCount: viewers.length, recvPacketsLost: 1, recvPacketsExpected: 100, lastRttMs: 3, sentAt: 0,
		live: { nodeName: node, hostCpuPct: 50, cpuPct: 20, workerCount: 2, collectMs: 30, skippedCycles: 0, eventLoopLagMs: 1, viewers },
	});

	for (let s = 0; s < 12; s++) {
		await monitor.receive(msg('edge-a', 'node-1', [viewer('va1', 0.01), viewer('va2', null)]), { now: s * 1000 });
		await monitor.receive(msg('edge-b', 'node-1', [viewer('vb1', 0)]), { now: s * 1000 });
	}

	await monitor.flush();
	// edge 2개 × (처음 + 10초 뒤) = 4행. 두 번째 행은 10초 동안의 delta 합
	assert.equal(saved.length, 4);
	assert.equal(saved[2]!.recvPacketsExpected, 1000);
	assert.equal(saved[2]!.recvPacketsLost, 10);

	const config = loadConfig({ MSDASH_MODE: 'origin', MSDASH_SERVER_ID: 'origin-1', NODE_NAME: 'node-1' });
	const collector = { latest: null, status: { ok: true } } as unknown as Collector;
	const central = new CentralView({ config, monitor, collector: () => collector, k8s: null });
	const snap = central.snapshot(11_000);

	assert.deepEqual(snap.edges.map(e => [e.id, e.nodeName, e.viewerCount, e.state]), [
		['edge-a', 'node-1', 2, 'connected'],
		['edge-b', 'node-1', 1, 'connected'],
	]);
	assert.equal(snap.viewers.length, 3);
	assert.deepEqual(snap.viewers.map(v => v.edgeId), ['edge-a', 'edge-a', 'edge-b']);
	assert.equal(snap.viewers[0]!.lossPct, 1);
	assert.ok(snap.viewers[0]!.nameMock, 'no name from edge → generated name, flagged');
	assert.deepEqual(snap.nodes.map(n => [n.name, n.edgeIds, n.hasOrigin]), [['node-1', ['edge-a', 'edge-b'], true]]);
	assert.deepEqual(snap.nodes.map(n => n.viewerCount), [3], 'node viewers = sum of its edges');
	assert.ok(!('history' in snap), '1s stream carries no history');

	// 이력: 1초 간격 1800칸, 마지막 칸 = 지금. 시청자 이력은 ?viewer=로 하나만
	central.sample(10_000);
	central.sample(11_000);
	const hist = central.history(11_000, 'va1');

	assert.equal(hist.points, 1800);
	assert.equal(hist.endSec, 11);
	assert.equal(hist.edges['edge-a']!.cpu.length, 1800);
	assert.deepEqual(hist.edges['edge-a']!.viewers.slice(-3), [null, 2, 2]);
	assert.deepEqual(hist.edges['edge-a']!.egressBps.slice(-1), [2e6], 'egress = sum of viewer bitrates');
	assert.deepEqual(hist.nodes['node-1']!.viewers.slice(-1), [3]);
	assert.deepEqual(Object.keys(hist.viewers), ['va1']);
	assert.deepEqual(hist.viewers['va1']!.loss.slice(-1), [1]);
	assert.deepEqual(Object.keys(central.history(11_000).viewers), []);
	assert.ok('viewer.latePct' in snap.mockFields && !('node.qdiscDropPerSec' in snap.mockFields), 'qdisc is no longer mocked');
	assert.equal(central.snapshot(18_000).edges[0]!.state, 'stale', '7s without 1s heartbeat');

	// 수집기 없음 → 사이드카 값 (worker CPU, /proc/stat), qdisc·throttle 없음
	assert.equal(snap.resourceSource, 'sidecar');
	assert.deepEqual([snap.edges[0]!.cpuPct, snap.edges[0]!.throttledMs], [20, null]);
	assert.deepEqual([snap.nodes[0]!.cpuPct, snap.nodes[0]!.qdiscDropPerSec], [50, null]);

	// 수집기가 보내면 그 값만 쓴다. pod 이름 = edge id. 수집기에 없는 edge는 null (worker CPU로 바꿔 끼우지 않음)
	const sysinfo = new SysinfoStore();

	sysinfo.receive({
		nodes: [{ name: 'node-1', cpuPct: 71.3, cpuPeakPct: 92, qdiscDropsPerSec: 4, ageMs: 200 }, { name: 'node-2', cpuPct: 5, qdiscDropsPerSec: 0, ageMs: 200 }],
		pods: [{ name: 'edge-a', node: 'node-1', cpuPct: 104.2, cpuPeakPct: 130.5, throttledMs: 35, throttledPct: 12.5, ageMs: 300 }],
	}, 11_000);

	const withSys = new CentralView({ config, monitor, collector: () => collector, k8s: null, sysinfo }).snapshot(11_000);

	assert.equal(withSys.resourceSource, 'collector');
	assert.deepEqual(withSys.edges.map(e => [e.id, e.cpuPct, e.workerCpuPct, e.throttledMs, e.throttledPct]), [
		['edge-a', 104.2, 20, 35, 12.5],
		['edge-b', null, 20, null, null],
	]);
	assert.deepEqual(withSys.nodes.map(n => [n.name, n.cpuPct, n.qdiscDropPerSec]), [['node-1', 71.3, 4], ['node-2', 5, 0]], 'collector-only nodes are listed too');
	assert.deepEqual(withSys.edges.map(e => e.cpuPeakPct), [130.5, null], 'CPU max = max of 0.1s values in that second (collector only)');
	assert.deepEqual(withSys.nodes.map(n => n.cpuPeakPct), [92, null], 'old collector without cpuPeakPct → null');

	// 수집기가 끊기면 값은 null, 출처는 그대로 collector
	const gone = new CentralView({ config, monitor, collector: () => collector, k8s: null, sysinfo }).snapshot(20_000);

	assert.equal(gone.resourceSource, 'collector');
	assert.equal(gone.nodes.find(n => n.name === 'node-1')!.cpuPct, null);
});

test('freezing: only real browser reports, set by a freeze or fps≈0, held for 2s', () => {
	const config = loadConfig({ MSDASH_SERVER_ID: 'edge-a' });
	const source = new EdgeLivenessSource(config, () => ({ ok: true, lastSuccessAt: new Date(), lastAttemptAt: new Date(), lastError: null, consecutiveFailures: 0, skippedCycles: 0, lastDurationMs: 1, source: 'sim' }));
	const row = (t: number, over: Partial<EdgeBatch['viewerSamples'][number]>) => ({
		time: new Date(t), viewerId: 'v1', roomId: 'r', workerIdx: 0, packetsExpected: 100, packetsLost: 0, nackCount: 0, packetsRetransmitted: 0,
		rttMs: 20, bitrateBps: 1e6, spatialLayer: 2, temporalLayer: 2, transportState: 'connected',
		clientReported: true, clientFreezeCount: 0, clientFreezeMs: 0, clientFps: 30, clientJitterBufferMs: 40, clientFramesDropped: 0, ...over,
	});
	const at = (t: number, over: Partial<EdgeBatch['viewerSamples'][number]> = {}) => {
		source.addBatch({ mode: 'edge', time: new Date(t), rooms: ['r'], collector: { time: new Date(t), hookOk: true, collectDurationMs: 1, collectSkipped: false, eventLoopLagMs: 0, nodeRssBytes: null, hostCpuPct: 10 }, workers: [], roomSamples: [], pipeSamples: [], viewerSamples: [row(t, over)], viewerSessionStarts: [], viewerSessionEnds: [] });

		return source.live!.viewers[0]!.freezing;
	};

	assert.equal(at(0), false);
	assert.equal(at(1000, { clientFps: 0 }), true, 'fps 0 while frozen');
	assert.equal(at(2000), true, 'held');
	assert.equal(at(3100), false, 'released after 2s');
	assert.equal(at(4000, { clientFreezeCount: 1 }), true, 'a freeze just ended');
	assert.equal(at(7000, { clientReported: false, clientFreezeCount: 3, clientFps: 0 }), false, 'mock values never show freeze');
});

test('LATE mock is stable per viewer and rises with loss', () => {
	assert.equal(mockLatePct('abc', 0), mockLatePct('abc', 0));
	assert.ok(mockLatePct('abc', 0.02) > mockLatePct('abc', 0));
	assert.ok(mockLatePct('abc', 1) <= 5);
});
