import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AlertEvaluator } from '../src/alerts/evaluator.js';
import type { AlertStorePort, NewAlertEvent } from '../src/alerts/evaluator.js';
import { edgeMetrics, percentile } from '../src/alerts/metrics.js';
import type { AlertSink } from '../src/alerts/sinks.js';
import type { AlertEventRecord, AlertRuleRecord, OriginStore } from '../src/db/store.js';
import type { EdgeBatch } from '../src/db/rows.js';
import { EdgeLivenessSource } from '../src/liveness/edgeReporter.js';
import { OriginLivenessMonitor } from '../src/liveness/originMonitor.js';
import { loadConfig } from '../src/config.js';
import { byLevel, firingLevel, firingStates, valueLevel, worst } from '../src/api/overview.js';

class MemoryAlertStore implements AlertStorePort {
	events: Array<NewAlertEvent & { alertId: number; resolvedAt: Date | null }> = [];

	constructor(
		private readonly rules: AlertRuleRecord[],
		private readonly firing: AlertEventRecord[] = []
	) {}

	async getAlertRules() {
		return this.rules;
	}

	async getFiringAlerts() {
		return this.firing;
	}

	async insertAlertEvent(e: NewAlertEvent) {
		const alertId = this.events.length + 1;

		this.events.push({ ...e, alertId, resolvedAt: null });

		return alertId;
	}

	async resolveAlertEvent(alertId: number, resolvedAt: Date) {
		this.events.find(e => e.alertId === alertId)!.resolvedAt = resolvedAt;
	}
}

const rule = (over: Partial<AlertRuleRecord> = {}): AlertRuleRecord => ({
	ruleId: 'pipe_loss',
	title: 'Pipe loss',
	metric: 'pipe.loss_ratio',
	warnAbove: 0.02,
	critAbove: 0.05,
	windowSeconds: 30,
	enabled: true,
	...over,
});

const sample = (value: number, subjectId = 'room-a') => ({ metric: 'pipe.loss_ratio', subjectType: 'pipe' as const, subjectId, value });

test('fires only after the value stays above threshold for the window, resolves after window below', async () => {
	const store = new MemoryAlertStore([rule()]);
	const fired: string[] = [];
	const sink: AlertSink = { onFiring: e => void fired.push(`fire:${e.severity}`), onResolved: e => void fired.push(`resolve:${e.severity}`) };
	const ev = new AlertEvaluator(store, [sink]);

	await ev.init();

	const t0 = 1_000_000;

	await ev.evaluate([sample(0.03)], t0);
	await ev.evaluate([sample(0.03)], t0 + 20_000);
	assert.equal(store.events.length, 0, 'not yet held for 30s');
	await ev.evaluate([sample(0.01)], t0 + 25_000); // 잠깐 내려가면 다시 센다
	await ev.evaluate([sample(0.03)], t0 + 30_000);
	await ev.evaluate([sample(0.03)], t0 + 50_000);
	assert.equal(store.events.length, 0);
	await ev.evaluate([sample(0.03)], t0 + 60_000);
	assert.equal(store.events.length, 1);
	assert.equal(store.events[0]!.severity, 'warn');
	assert.equal(ev.states()[0]!.status, 'warn');

	await ev.evaluate([sample(0.0)], t0 + 70_000);
	await ev.evaluate([sample(0.0)], t0 + 90_000);
	assert.equal(store.events[0]!.resolvedAt, null, 'still within resolve window');
	await ev.evaluate([sample(0.0)], t0 + 100_000);
	assert.ok(store.events[0]!.resolvedAt);
	assert.deepEqual(fired, ['fire:warn', 'resolve:warn']);
});

test('escalates warn → crit and de-escalates only after window below crit', async () => {
	const store = new MemoryAlertStore([rule({ windowSeconds: 10 })]);
	const ev = new AlertEvaluator(store);

	await ev.init();

	const t0 = 0;

	await ev.evaluate([sample(0.03)], t0);
	await ev.evaluate([sample(0.03)], t0 + 10_000); // warn
	await ev.evaluate([sample(0.08)], t0 + 20_000);
	await ev.evaluate([sample(0.08)], t0 + 30_000); // crit
	assert.deepEqual(store.events.map(e => [e.severity, e.resolvedAt !== null]), [['warn', true], ['crit', false]]);

	await ev.evaluate([sample(0.03)], t0 + 35_000);
	assert.equal(store.events.length, 2, 'not de-escalated yet');
	await ev.evaluate([sample(0.03)], t0 + 45_000);
	assert.deepEqual(store.events.map(e => e.severity), ['warn', 'crit', 'warn']);
	assert.ok(store.events[1]!.resolvedAt);
});

test('subject that disappears is resolved; firing alerts are resumed after restart', async () => {
	const firing: AlertEventRecord = {
		alertId: 7,
		ruleId: 'pipe_loss',
		title: 'Pipe loss',
		severity: 'warn',
		state: 'firing',
		subjectType: 'pipe',
		subjectId: 'room-z',
		value: 0.03,
		threshold: 0.02,
		startedAt: new Date(0),
		resolvedAt: null,
	};
	const store = new MemoryAlertStore([rule({ windowSeconds: 10 })], [firing]);
	const resolved: number[] = [];
	const ev = new AlertEvaluator(store, [{ onFiring: () => {}, onResolved: e => void resolved.push(e.alertId) }]);

	store.resolveAlertEvent = async id => void resolved.push(-id);
	await ev.init(100_000);
	await ev.evaluate([sample(0.03, 'room-a')], 100_000);
	assert.equal(resolved.length, 0, 'resumed alert is not re-fired or resolved immediately');
	await ev.evaluate([sample(0.03, 'room-a')], 111_000);
	assert.deepEqual(resolved, [-7, 7], 'room-z gone for > window → resolved');
});

test('edge metrics use server values only (client/mock fields ignored)', () => {
	const time = new Date();
	const batch = {
		mode: 'edge',
		time,
		rooms: ['r'],
		collector: { time, hookOk: true, collectDurationMs: 1, collectSkipped: false, eventLoopLagMs: 3, nodeRssBytes: 1, hostCpuPct: 1 },
		workers: [{ time, workerIdx: 0, cpuPct: 50, memRssBytes: 1, routerCount: 1, transportCount: 1, producerCount: 1, consumerCount: 1 }],
		roomSamples: [],
		pipeSamples: [
			{ time, roomId: 'r', producerId: 'p', kind: 'video', packetsExpected: 1000, packetsLost: 30, packetsRepaired: 0, bitrateBps: 1, rttMs: 1, jitterMs: 1, nackCount: 0, pliCount: 0 },
		],
		viewerSamples: [0, 0.01, 0.06, 0.1].map((loss, i) => ({
			time,
			viewerId: `v${i}`,
			roomId: 'r',
			workerIdx: 0,
			packetsExpected: 1000,
			packetsLost: loss * 1000,
			nackCount: 0,
			packetsRetransmitted: 0,
			rttMs: 1,
			bitrateBps: 1,
			spatialLayer: 2,
			temporalLayer: 2,
			transportState: 'connected',
			clientReported: true,
			clientFreezeCount: 99,
			clientFreezeMs: 99,
			clientFps: 1,
			clientJitterBufferMs: 999,
			clientFramesDropped: 99,
		})),
		viewerSessionStarts: [],
		viewerSessionEnds: [],
	} satisfies EdgeBatch;
	const m = Object.fromEntries(edgeMetrics(batch).map(s => [`${s.metric}|${s.subjectId}`, s.value]));

	assert.equal(m['pipe.loss_ratio|r'], 0.03);
	assert.equal(m['viewer.bad_ratio|r'], 0.5);
	assert.ok(Math.abs(m['viewer.loss_ratio.p50|r']! - 0.035) < 1e-9);
	assert.equal(m['worker.cpu_pct|w0'], 50);
	assert.ok(!Object.keys(m).some(k => k.includes('client')));
	assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
});

test('liveness: edge deltas accumulate, origin marks lost after threshold', async () => {
	const config = loadConfig({ MSDASH_MODE: 'edge', MSDASH_SERVER_ID: 'edge-1', MSDASH_PUBLIC_URL: 'http://e1:8080', SERVER_IP: '10.1.1.1' });
	const source = new EdgeLivenessSource(config, () => ({
		ok: true,
		lastSuccessAt: new Date(),
		lastAttemptAt: new Date(),
		lastError: null,
		consecutiveFailures: 0,
		skippedCycles: 0,
		lastDurationMs: 1,
		source: 'sim',
	}));
	const pipe = (lost: number) => ({ pipeSamples: [{ packetsExpected: 100, packetsLost: lost }], viewerSamples: [{}, {}] }) as unknown as EdgeBatch;

	source.addBatch(pipe(1));
	source.addBatch(pipe(3));

	const msg = source.take();

	assert.equal(msg.recvPacketsLost, 4);
	assert.equal(msg.recvPacketsExpected, 200);
	assert.equal(msg.viewerCount, 2);
	assert.equal(msg.ip, '10.1.1.1');
	source.restore(msg); // 전송 실패 → 다음 신호에 합쳐짐
	source.addBatch(pipe(2));
	assert.equal(source.take().recvPacketsLost, 6);
	assert.equal(source.take().recvPacketsLost, null, 'no pipe data since last take');

	const saved: unknown[] = [];
	const store = {
		getEdges: async () => [],
		upsertEdge: async (e: unknown) => void saved.push(['edge', e]),
		saveHeartbeat: async (h: unknown) => void saved.push(['hb', h]),
	} as unknown as OriginStore;
	const evStore = new MemoryAlertStore([
		{ ruleId: 'edge_signal_age', title: 'edge 신호 끊김', metric: 'edge.heartbeat_age_s', warnAbove: 30, critAbove: 120, windowSeconds: 0, enabled: true },
	]);
	const ev = new AlertEvaluator(evStore);

	await ev.init();

	const monitor = new OriginLivenessMonitor(store, ev);

	await monitor.receive({ ...msg, recvPacketsLost: 5, recvPacketsExpected: 100 }, { now: 0 });
	await monitor.flush();
	assert.deepEqual(saved.map(s => (s as [string])[0]), ['edge', 'hb']);
	assert.equal(monitor.edgeIdByIp().get('10.1.1.1'), 'edge-1');
	assert.equal(monitor.statuses(10_000)[0]!.state, 'warning', '5% recv loss');
	assert.equal(monitor.statuses(31_000)[0]!.state, 'lost');
	await monitor.evaluateAges(31_000);
	assert.equal(evStore.events[0]?.severity, 'warn');
	await monitor.evaluateAges(121_000);
	assert.equal(evStore.events.at(-1)?.severity, 'crit');
	await assert.rejects(monitor.receive({ v: 2 }), /unsupported version/);
	await assert.rejects(monitor.receive({ v: 1, edgeId: 'x' }), /dashboardUrl/);
});

test('overview levels follow alert rules: firing for the banner, rule thresholds for current values', async () => {
	const store = new MemoryAlertStore([rule({ windowSeconds: 0 })]);
	const ev = new AlertEvaluator(store);

	await ev.init();
	assert.equal(valueLevel(ev, 'pipe_loss', 0.01), 'ok');
	assert.equal(valueLevel(ev, 'pipe_loss', 0.02), 'warn');
	assert.equal(valueLevel(ev, 'pipe_loss', 0.06), 'crit');
	assert.equal(valueLevel(ev, 'pipe_loss', null), 'ok');
	assert.equal(valueLevel(ev, 'unknown_rule', 1), 'ok');

	await ev.evaluate([sample(0.03, 'room-a'), sample(0.0, 'room-b')], 1_000_000);

	const firing = firingStates(ev);

	assert.equal(firing.length, 1);
	assert.equal(firingLevel(firing, 'pipe', 'room-a'), 'warn');
	assert.equal(firingLevel(firing, 'pipe', 'room-b'), null);
	assert.equal(worst('ok', null, 'warn', undefined), 'warn');
	assert.equal(worst(), 'ok');

	// 문제 먼저(crit → warn → ok → idle), 같은 등급은 기존 순서 유지
	const rows = [
		{ id: 'a', level: 'ok' as const },
		{ id: 'b', level: 'idle' as const },
		{ id: 'c', level: 'warn' as const },
		{ id: 'd', level: 'crit' as const },
		{ id: 'e', level: 'warn' as const },
	];

	assert.deepEqual(
		[...rows].sort(byLevel(r => r.level)).map(r => r.id),
		['d', 'c', 'e', 'a', 'b']
	);
});
