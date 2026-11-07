// DB 읽기 함수 점검용. 사이드카를 sim 모드로 잠시 돌린 뒤 실행한다.
//   MSDASH_MODE=edge MSDASH_DATABASE_URL=... node scripts/read-smoke.mjs
import { TimescaleEdgeStore } from '../dist/src/db/timescale/edgeStore.js';
import { TimescaleOriginStore } from '../dist/src/db/timescale/originStore.js';

const mode = process.env.MSDASH_MODE ?? 'edge';
const url = process.env.MSDASH_DATABASE_URL;
const range = { from: new Date(Date.now() - 3600_000), to: new Date() };
const show = (name, value) => {
	const list = Array.isArray(value) ? value : [value];

	console.log(`--- ${name}: ${Array.isArray(value) ? `${value.length} rows` : ''}`);
	console.log(JSON.stringify(list.slice(0, 2), null, 0));
};

if (mode === 'edge') {
	const s = new TimescaleEdgeStore(url);

	show('getServerSeries', await s.getServerSeries(range, 10));
	show('getWorkerSeries', await s.getWorkerSeries(range, 10));
	show('getRoomSummary', await s.getRoomSummary());
	const rooms = await s.getRoomSummary();
	show('getRoomViewerSeries', await s.getRoomViewerSeries(rooms[0].roomId, range, 10));
	show('getPipeSeries', await s.getPipeSeries(range, 10));
	show('getPipeSeries(agg path, 14d)', await s.getPipeSeries({ from: new Date(Date.now() - 14 * 86400_000), to: new Date() }, 300));
	const viewers = await s.getViewerList({ sort: 'loss' });
	show('getViewerList(loss)', viewers);
	show('getViewerList(loss>=5%, mobile)', await s.getViewerList({ minLossRatio: 0.05, deviceClass: 'mobile' }));
	show('getViewerSession', await s.getViewerSession(viewers[0].viewerId));
	show('getViewerSeries', await s.getViewerSeries(viewers[0].viewerId, range, 10));
	show('getViewerLossPercentiles', await s.getViewerLossPercentiles(range, 10));
	show('getViewerLossDistribution', await s.getViewerLossDistribution());
	show('getAlertRules', await s.getAlertRules());
	show('getAlertHistory', await s.getAlertHistory(range));
	show('getOpenViewerSessionIds', (await s.getOpenViewerSessionIds()).length);
	await s.close();
} else {
	const s = new TimescaleOriginStore(url);

	show('getServerSeries', await s.getServerSeries(range, 10));
	show('getOriginRoomSummary', await s.getOriginRoomSummary());
	const b = await s.getBroadcasters();
	show('getBroadcasters', b);
	show('getBroadcasterSeries', await s.getBroadcasterSeries(b[0].broadcasterId, range, 10));
	show('getRoomBitrateSeries', await s.getRoomBitrateSeries(b[0].roomId, range, 10));
	await s.saveHeartbeat({ time: new Date(), edgeId: 'edge-sim-1', ok: true, rttMs: 3, viewerCount: 40, recvPacketsLost: 5, recvPacketsExpected: 1000 });
	show('getEdges', await s.getEdges());
	show('getRoomEdgeMatrix', await s.getRoomEdgeMatrix());
	await s.close();
}
