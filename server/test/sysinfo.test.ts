import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpServer } from '../src/http/server.js';
import { parseSysinfo, registerSysinfoRoutes, SysinfoError, SysinfoStore } from '../src/central/sysinfo.js';

const sample = {
	t: 1762843945000,
	nodes: [{ name: 'edge1', cpuPct: 34.2, cpuPeakPct: 61.5, qdiscDropsPerSec: 3, ageMs: 300 }],
	pods: [{ name: 'mediasoup-edge-abc', node: 'edge1', cpuPct: 62.1, cpuPeakPct: 118.4, throttledMs: 12.5, throttledPct: 4, ageMs: 400 }],
};

test('sysinfo: parses the collector message', () => {
	const m = parseSysinfo(sample);

	assert.deepEqual(m.nodes, sample.nodes);
	assert.deepEqual(m.pods, sample.pods);
	assert.equal(m.t, sample.t);
});

test('sysinfo: bad numbers become null, bad shape is rejected', () => {
	const m = parseSysinfo({
		nodes: [{ name: 'n', cpuPct: -1, qdiscDropsPerSec: 'x' }],
		pods: [{ name: 'p', cpuPct: 130, throttledPct: 250, throttledMs: NaN }],
	});

	assert.equal(m.nodes[0]!.cpuPct, null, 'negative');
	assert.equal(m.nodes[0]!.qdiscDropsPerSec, null, 'not a number');
	assert.equal(m.nodes[0]!.ageMs, null, 'missing');
	assert.equal(m.pods[0]!.cpuPct, 130, 'container may briefly exceed its limit');
	assert.equal(m.pods[0]!.throttledPct, null, 'ratio over 100');
	assert.equal(m.pods[0]!.node, null);
	assert.equal(m.nodes[0]!.cpuPeakPct, null, 'old collector without cpuPeakPct');

	assert.throws(() => parseSysinfo(null), SysinfoError);
	assert.throws(() => parseSysinfo({ nodes: {} }), SysinfoError);
	assert.throws(() => parseSysinfo({ pods: [{ cpuPct: 1 }] }), SysinfoError, 'name is required');
	assert.deepEqual(parseSysinfo({}).nodes, [], 'empty lists are fine (no agents yet)');
});

test('sysinfo: same name twice keeps the last one', () => {
	const m = parseSysinfo({ nodes: [{ name: 'a', cpuPct: 1 }, { name: 'a', cpuPct: 2 }] });

	assert.equal(m.nodes.length, 1);
	assert.equal(m.nodes[0]!.cpuPct, 2);
});

test('sysinfo: collector silent for 3s → disconnected; old agent values → null', () => {
	const s = new SysinfoStore();

	assert.equal(s.view(0).seen, false);
	assert.equal(s.view(0).connected, false);

	s.receive(
		{ ...sample, nodes: [...sample.nodes, { name: 'edge2', cpuPct: 50, qdiscDropsPerSec: 0, ageMs: 5000 }] },
		1000
	);

	const v = s.view(2000);

	assert.equal(v.connected, true);
	assert.equal(v.nodes.find(n => n.name === 'edge1')!.cpuPct, 34.2);

	const old = v.nodes.find(n => n.name === 'edge2')!;

	assert.equal(old.stale, true, 'agent stream stopped 5s ago');
	assert.equal(old.cpuPct, null);

	const later = s.view(4500);

	assert.equal(later.connected, false);
	assert.equal(later.seen, true);
	assert.deepEqual(later.nodes, []);
	assert.deepEqual(later.pods, []);
});

test('sysinfo: POST /api/central/sysinfo over HTTP', async () => {
	const http = new HttpServer();
	const store = new SysinfoStore();

	registerSysinfoRoutes(http, store);
	await http.listen('127.0.0.1', 0);

	try {
		const port = http.port!;
		const url = `http://127.0.0.1:${port}/api/central/sysinfo`;
		const ok = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sample) });

		assert.equal(ok.status, 200);
		assert.deepEqual(await ok.json().then(b => [b.ok, b.nodes, b.pods]), [true, 1, 1]);

		const got = (await (await fetch(url)).json()) as ReturnType<SysinfoStore['view']>;

		assert.equal(got.connected, true);
		assert.equal(got.pods[0]!.throttledMs, 12.5);

		const bad = await fetch(url, { method: 'POST', body: JSON.stringify({ nodes: 'x' }) });

		assert.equal(bad.status, 400);

		const notJson = await fetch(url, { method: 'POST', body: '{' });

		assert.equal(notJson.status, 400);
	} finally {
		await http.close();
	}
});

