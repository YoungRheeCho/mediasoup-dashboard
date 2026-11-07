// API 점검: 모든 화면 엔드포인트를 호출하고 패널별 성공 여부를 요약한다.
//   node scripts/api-smoke.mjs http://127.0.0.1:18081 edge
//   node scripts/api-smoke.mjs http://127.0.0.1:18080 origin
const [base, mode] = process.argv.slice(2);
let failures = 0;

async function get(path) {
	const started = Date.now();
	const res = await fetch(base + path);
	const body = await res.json();

	return { status: res.status, body, ms: Date.now() - started };
}

function size(data) {
	if (Array.isArray(data)) return `${data.length} items`;
	if (data && typeof data === 'object') {
		const arr = Object.entries(data).find(([, v]) => Array.isArray(v));

		return arr ? `${arr[0]}: ${arr[1].length}` : `${Object.keys(data).length} keys`;
	}

	return String(data);
}

async function check(path, expectNotFound = false) {
	const { status, body, ms } = await get(path);

	if (status !== 200) {
		failures++;
		console.log(`✗ ${path} → HTTP ${status} ${JSON.stringify(body)}`);

		return body;
	}

	const panels = Object.entries(body.panels ?? {}).map(([name, p]) => {
		if (!p.ok && p.reason !== 'not_implemented' && !(expectNotFound && p.reason === 'not_found')) failures++;

		return p.ok
			? `${name}✓(${size(p.data)}${p.excluded?.length ? `, excluded ${p.excluded}` : ''}${p.mock?.length ? ', mock' : ''})`
			: `${name}${p.reason === 'not_implemented' ? '∅' : '✗'}(${p.error})`;
	});

	console.log(`${path} [${ms}ms] ${panels.join('  ')}`);

	return body;
}

const meta = await get('/api/meta');

console.log(`meta: server=${meta.body.meta.serverId} source=${meta.body.meta.source} collectorAge=${meta.body.meta.collector.ageSeconds}s mockFields=${Object.keys(meta.body.meta.mockFields).length}`);

if (mode === 'edge') {
	for (const range of ['5m', '1h']) await check(`/api/edge/overview?range=${range}`);
	await check('/api/edge/workers');
	const rooms = await check('/api/edge/broadcasts');
	const roomId = rooms.panels.rooms.data[0]?.roomId;
	await check(`/api/edge/broadcasts/${roomId}`);
	await check('/api/edge/broadcasts/nope', true);
	await check('/api/edge/pipe');
	const viewers = await check('/api/edge/viewers?filter=loss5&limit=5');
	await check('/api/edge/viewers?q=viewer-&filter=mobile');
	const viewerId = viewers.panels.viewers.data.items[0]?.viewerId ?? (await get('/api/edge/viewers')).body.panels.viewers.data.items[0].viewerId;
	await check(`/api/edge/viewers/${viewerId}`);
	await check(`/api/edge/viewers/${viewerId}?range=session`);
	await check(`/api/edge/viewers/${viewerId}/live`);
	const live2 = await check(`/api/edge/viewers/${viewerId}/live`);
	console.log('   live video:', JSON.stringify(live2.panels.live.data?.video));
	const missing = await get('/api/edge/viewers/does-not-exist');
	console.log(`/api/edge/viewers/does-not-exist → ${missing.status}`);
	const overview = await get('/api/edge/overview');
	console.log('   kpi:', JSON.stringify(overview.body.panels.kpi.data));
	console.log('   rooms[0]:', JSON.stringify(overview.body.panels.rooms.data?.[0]));
} else {
	await check('/api/origin/overview');
	const rooms = await check('/api/origin/rooms');
	const roomId = rooms.panels.rooms.data[0]?.roomId;
	const room = await check(`/api/origin/rooms/${roomId}`);
	const b = room.panels.broadcasters.data[0];
	console.log('   broadcaster[0]:', JSON.stringify({ ...b, report: undefined }).slice(0, 400));
	await check(`/api/origin/broadcasters/${encodeURIComponent(b.broadcasterId)}`);
	await check(`/api/origin/broadcasters/${encodeURIComponent(b.broadcasterId)}/live`);
	const edges = await check('/api/origin/edges');
	console.log('   edges summary:', JSON.stringify(edges.panels.summary.data));
	const overview = await get('/api/origin/overview');
	console.log('   kpi:', JSON.stringify(overview.body.panels.kpi.data));
}

await check('/api/alerts');
console.log(failures ? `\n${failures} failure(s)` : '\nall panels ok');
process.exit(failures ? 1 : 0);
