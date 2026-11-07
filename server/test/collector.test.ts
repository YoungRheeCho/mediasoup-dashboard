import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DeltaTracker, sumStrict } from '../src/collector/delta.js';
import { EdgeNormalizer } from '../src/collector/normalizeEdge.js';
import { OriginNormalizer } from '../src/collector/normalizeOrigin.js';
import { Topology, jitterMs } from '../src/collector/topology.js';
import type { CycleContext } from '../src/collector/types.js';
import { layerName, streamSpatialLayer } from '../src/api/live.js';
import { loadConfig } from '../src/config.js';
import type { RawSnapshot } from '../src/hookProtocol.js';
import { SimSource } from '../src/sources/simSource.js';

const ctx: CycleContext = { collectDurationMs: 10, skipped: false, hostCpuPct: null, mockEnabled: true, intervalMs: 10000 };

test('delta: first observation and counter reset give null', () => {
	const d = new DeltaTracker();

	assert.equal(d.delta('a', 100), null);
	assert.equal(d.delta('a', 150), 50);
	assert.equal(d.delta('a', 20), null, 'decrease (restart) → interval not stored');
	assert.equal(d.delta('a', 30), 10);
	assert.equal(d.delta('b', null), null);
	assert.equal(sumStrict([1, 2, null]), null);
	assert.equal(sumStrict([1, 2]), 3);
});

test('delta: sweep forgets keys not seen this cycle', () => {
	const d = new DeltaTracker();

	d.delta('a', 1);
	d.delta('b', 1);
	d.sweep();
	d.delta('a', 2);
	d.sweep();
	assert.equal(d.size, 1);
});

test('jitter is converted from RTP units to ms', () => {
	assert.equal(jitterMs({ type: 'inbound-rtp', jitter: 900, mimeType: 'video/VP8' }), 10);
	assert.equal(jitterMs({ type: 'inbound-rtp', jitter: 480, mimeType: 'audio/opus' }), 10);
});

async function snapshots(mode: 'edge' | 'origin', count: number): Promise<RawSnapshot[]> {
	const config = loadConfig({ MSDASH_MODE: mode, MSDASH_SIM_ROOMS: '2', MSDASH_SIM_VIEWERS: '20', MSDASH_SIM_WORKERS: '3' });
	const sim = new SimSource(config, 7);
	const out: RawSnapshot[] = [];

	for (let i = 0; i < count; i++) {
		// 시뮬레이터는 실제 경과 시간으로 카운터를 늘리므로 시간을 흉내 낸다.
		const realNow = Date.now;
		const fake = realNow() + i * 10000;

		Date.now = () => fake;

		try {
			out.push(structuredClone(await sim.snapshot()));
		} finally {
			Date.now = realNow;
		}
	}

	return out;
}

test('topology: consumer router shards are mapped to their room via piped producer ids', async () => {
	const [snap] = await snapshots('edge', 1);
	const topo = new Topology(snap!);

	for (const t of snap!.transports.filter(t => t.direction === 'consumer')) {
		assert.ok(topo.roomOfTransport(t), `viewer transport ${t.id} on router ${t.routerId} has a room`);
	}
});

test('edge: viewer deltas, loss and sessions', async () => {
	const snaps = await snapshots('edge', 3);
	const n = new EdgeNormalizer();
	const first = n.normalize(snaps[0]!, ctx);

	assert.ok(first.viewerSamples.length > 0);
	assert.equal(first.viewerSessionStarts.length, first.viewerSamples.length, 'every viewer starts a session');
	assert.ok(first.viewerSamples.every(v => v.packetsExpected === null), 'no baseline on first cycle');
	assert.ok(first.workers.every(w => w.cpuPct === null));

	const second = n.normalize(snaps[1]!, ctx);
	const withDelta = second.viewerSamples.filter(v => v.packetsExpected !== null);

	assert.ok(withDelta.length > 0, 'second cycle has deltas for returning viewers');

	for (const v of withDelta) {
		assert.ok(v.packetsExpected! > 0);
		assert.ok(v.packetsLost! >= 0 && v.packetsLost! <= v.packetsExpected!);
	}

	assert.ok(second.workers.every(w => w.cpuPct !== null && w.cpuPct >= 0 && w.cpuPct <= 100));
	assert.ok(second.pipeSamples.length >= 2, 'pipe producers per room');
	assert.ok(second.pipeSamples.every(p => p.packetsExpected === null || p.packetsExpected >= p.packetsLost!));

	// mock 값은 mockEnabled일 때만. mock은 실제 보고가 아니므로 clientReported=false.
	assert.ok(second.viewerSamples.every(v => !v.clientReported && v.clientFps !== null));

	const noMock = new EdgeNormalizer().normalize(snaps[0]!, { ...ctx, mockEnabled: false });

	assert.ok(noMock.viewerSamples.every(v => !v.clientReported && v.clientFps === null));
	assert.ok(noMock.viewerSessionStarts.every(s => s.peerId === null && s.userAgent === null));

	// room 행: worker별, viewer 수 합 = viewer 표본 수
	const total = second.roomSamples.reduce((a, r) => a + r.viewerCount, 0);

	assert.equal(total, second.viewerSamples.length);
});

test('edge: viewers that disappear end their session; adopted sessions close if absent', async () => {
	const [snap] = await snapshots('edge', 1);
	const n = new EdgeNormalizer();

	n.adoptOpenSessions(['stale-viewer']);

	const batch = n.normalize(snap!, ctx);

	assert.deepEqual(
		batch.viewerSessionEnds.map(e => e.viewerId),
		['stale-viewer']
	);

	const emptied: RawSnapshot = { ...snap!, transports: snap!.transports.filter(t => t.direction !== 'consumer') };
	const after = n.normalize(emptied, ctx);

	assert.equal(after.viewerSessionEnds.length, batch.viewerSessionStarts.length);
	assert.equal(n.openSessionCount, 0);
});

test('edge: counter decrease (stream restart) drops that interval', async () => {
	const snaps = await snapshots('edge', 3);
	const n = new EdgeNormalizer();

	n.normalize(snaps[0]!, ctx);
	n.normalize(snaps[1]!, ctx);

	const reset = structuredClone(snaps[2]!);

	for (const c of reset.consumers) {
		for (const s of c.stats ?? []) {
			s.packetCount = 0;
		}
	}

	const batch = n.normalize(reset, ctx);

	assert.ok(batch.viewerSamples.every(v => v.packetsExpected === null));
});

test('origin: broadcasters, pipe send to edges, room-edge links', async () => {
	const snaps = await snapshots('origin', 2);
	const n = new OriginNormalizer();
	const edgeIdByIp = new Map([['10.0.0.11', 'edge-sim-1'], ['10.0.0.12', 'edge-sim-2']]);
	const first = n.normalize(snaps[0]!, { ...ctx, edgeIdByIp });

	assert.equal(first.broadcasterSessionStarts.length, 3, 'room-a has 1, room-b has 2 broadcasters');
	assert.ok(first.broadcasterSessionStarts.every(s => s.displayName?.startsWith('host-')), 'names come from room peers (real)');
	assert.equal(first.roomEdgeLinks.length, 4, '2 rooms × 2 known edges (third edge ip unknown)');
	assert.ok(first.pipeSendSamples.some(p => p.edgeId === null), 'unknown edge ip kept with null edge_id');

	const second = n.normalize(snaps[1]!, { ...ctx, edgeIdByIp });

	assert.equal(second.roomEdgeLinks.length, 0, 'no link changes');
	assert.ok(second.broadcasterSamples.every(b => b.layersActive === 3));
	assert.ok(second.broadcasterSamples.every(b => b.packetsExpected! > 0));
	assert.ok(second.pipeSendSamples.every(p => p.packetsExpected! > 0));
	assert.ok(second.roomSamples.every(r => r.outPipeBitrateBps! > 0));

	const gone: RawSnapshot = { ...snaps[1]!, transports: snaps[1]!.transports.filter(t => t.type !== 'pipe') };
	const third = n.normalize(gone, { ...ctx, edgeIdByIp });

	assert.equal(third.roomEdgeLinks.filter(l => l.state === 'closed').length, 4);
});

test('edge: viewer identity comes from the room peer when the transport has a peerId (M1)', async () => {
	const snaps = await snapshots('edge', 4);
	const topo = new Topology(snaps[0]!);
	const [a, b] = snaps[0]!.transports.filter(t => t.type === 'webrtc' && t.direction === 'consumer');
	const roomId = topo.roomOfTransport(a!)!;
	// remoteAddress는 hostNetwork pod에서 pod IP라 쓰지 않는다. IP는 ICE 선택 경로에서 읽는다.
	const peer = { peerId: 'peer-real', displayName: 'Alice', device: { flag: 'chrome', name: 'Chrome', version: '130.0' }, remoteAddress: '10.244.2.0' };

	for (const [i, snap] of snaps.entries()) {
		const ta = snap.transports.find(t => t.id === a!.id)!;

		ta.peerId = 'peer-real';
		snap.transports.find(t => t.id === b!.id)!.peerId = 'peer-unknown';

		// peer는 두 번째 스냅숏부터 보인다 (transport가 join보다 먼저 보이는 경우).
		if (i >= 1) {
			snap.rooms.find(r => r.roomId === roomId)!.peers.push(peer);
		}

		// ICE 연결(IP)은 세 번째 스냅숏부터.
		if (i >= 2) {
			ta.stats = [{ type: 'webrtc-transport', iceSelectedTuple: { remoteIp: '203.0.113.7', remotePort: 50000 } }];
		}
	}

	const n = new EdgeNormalizer();
	const first = n.normalize(snaps[0]!, ctx);
	const startA1 = first.viewerSessionStarts.find(s => s.viewerId === a!.id)!;

	assert.equal(startA1.identitySource, 'mock', 'peer not visible yet → mock');

	const second = n.normalize(snaps[1]!, ctx);
	const startA2 = second.viewerSessionStarts.find(s => s.viewerId === a!.id);

	assert.ok(startA2, 'identity found later → session start re-sent for the upsert');
	assert.equal(startA2!.identitySource, 'peer');
	assert.equal(startA2!.displayName, 'Alice');
	assert.equal(startA2!.deviceFlag, 'chrome');
	assert.equal(startA2!.browserName, 'Chrome');
	assert.equal(startA2!.browserVersion, '130.0');
	assert.equal(startA2!.remoteIp, null, 'ICE not connected yet → no IP (pod IP is not used)');
	assert.equal(startA2!.userAgent, null, 'mock user agent would contradict the real browser');
	assert.ok(!second.viewerSessionStarts.some(s => s.viewerId === b!.id), 'unknown peerId stays mock and is not re-sent');

	const third = n.normalize(snaps[2]!, ctx);
	const startA3 = third.viewerSessionStarts.find(s => s.viewerId === a!.id);

	assert.equal(startA3?.remoteIp, '203.0.113.7', 'IP found later → re-sent');

	const fourth = n.normalize(snaps[3]!, ctx);

	assert.ok(!fourth.viewerSessionStarts.some(s => s.viewerId === a!.id), 'resolved identity is sent only once');
});

test('edge: without peerId (current server code) identity stays mock', async () => {
	const [snap] = await snapshots('edge', 1);
	const n = new EdgeNormalizer();
	const batch = n.normalize(snap!, ctx);

	assert.ok(batch.viewerSessionStarts.every(s => s.identitySource === 'mock' && s.browserName === null && s.remoteIp === null));
	const noMock = new EdgeNormalizer().normalize(snap!, { ...ctx, mockEnabled: false });

	assert.ok(noMock.viewerSessionStarts.every(s => s.identitySource === null && s.displayName === null && s.peerId === null));
});

test('edge: pipe producers count even when appData.peerId is the origin broadcaster id (fec-merged Server.edge.ts)', async () => {
	const snaps = await snapshots('edge', 2);

	// /pipe/produce가 origin appData로 peerId를 덮어쓰는 경우를 흉내 낸다.
	for (const snap of snaps) {
		const pipeIds = new Set(snap.transports.filter(t => t.type === 'pipe').map(t => t.id));

		for (const p of snap.producers.filter(p => pipeIds.has(p.transportId))) {
			p.peerId = 'origin-broadcaster';
		}
	}

	const n = new EdgeNormalizer();

	n.normalize(snaps[0]!, ctx);

	const second = n.normalize(snaps[1]!, ctx);

	assert.ok(second.pipeSamples.length >= 2, 'pipe producers are not dropped by peerId');
	assert.ok(second.pipeSamples.every(p => p.packetsExpected !== null));
});

test('stream layer names: rid digit first, else stats order; single stream has none', () => {
	assert.equal(layerName(streamSpatialLayer({ rid: 'r2' }, 0, 3)), 'L2(High)');
	assert.equal(layerName(streamSpatialLayer({}, 1, 3)), 'L1(Mid)');
	assert.equal(layerName(streamSpatialLayer({}, 0, 3)), 'L0(Low)');
	assert.equal(streamSpatialLayer({}, 0, 1), null);
});

test('edge: browser report (reportClientStats) replaces mock client values (M2)', async () => {
	const snaps = await snapshots('edge', 3);
	const [a, b] = snaps[0]!.transports.filter(t => t.type === 'webrtc' && t.direction === 'consumer');

	snaps.forEach((snap, i) => {
		snap.transports.find(t => t.id === a!.id)!.clientStats = {
			freezeCount: 2 + i,
			freezeSec: 0.5 + i * 0.4,
			framesDropped: 10 + i * 3,
			fps: 29.6,
			jitterBufferMs: 41.2,
			width: 1280,
			height: 720,
			at: snap.time - 2000,
		};

		// b는 한 번 보고했지만 오래됐다 → mock으로 채우지 않는다.
		snap.transports.find(t => t.id === b!.id)!.clientStats = { freezeCount: 0, freezeSec: 0, framesDropped: 0, fps: 30, jitterBufferMs: 40, width: 640, height: 360, at: snap.time - 60_000 };
	});

	const n = new EdgeNormalizer();
	const first = n.normalize(snaps[0]!, ctx);
	const a1 = first.viewerSamples.find(v => v.viewerId === a!.id)!;

	assert.equal(a1.clientReported, true);
	assert.equal(a1.clientFps, 29.6);
	assert.equal(a1.clientFreezeCount, null, 'cumulative counter needs a baseline');

	const second = n.normalize(snaps[1]!, ctx);
	const a2 = second.viewerSamples.find(v => v.viewerId === a!.id)!;
	const b2 = second.viewerSamples.find(v => v.viewerId === b!.id)!;

	assert.equal(a2.clientFreezeCount, 1);
	assert.equal(a2.clientFreezeMs, 400);
	assert.equal(a2.clientFramesDropped, 3);
	assert.equal(a2.clientJitterBufferMs, 41);
	assert.equal(b2.clientReported, false);
	assert.equal(b2.clientFps, null, 'stale report → no value, not mock');

	const others = second.viewerSamples.filter(v => v.viewerId !== a!.id && v.viewerId !== b!.id);

	assert.ok(others.every(v => !v.clientReported && v.clientFps !== null), 'viewers that never reported keep mock values');
});
