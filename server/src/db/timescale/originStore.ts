import type {
	BroadcasterSampleRow,
	OriginBatch,
	OriginRoomSampleRow,
	PipeSendSampleRow,
	RoomEdgeLinkRow,
} from '../rows.js';
import type {
	BroadcasterRecord,
	BroadcasterSeriesPoint,
	EdgeRecord,
	HeartbeatInput,
	OriginRoomSummary,
	OriginStore,
	RoomEdgeCell,
	SeriesPoint,
	TimeRange,
} from '../store.js';
import { COLLECTOR_COLUMNS, TimescaleBase } from './common.js';
import { WORKER_COLUMNS } from './edgeStore.js';
import { insertRows, ratio, toNum } from './sql.js';

const BROADCASTER_COLUMNS = [
	{ name: 'time', type: 'timestamptz', get: (r: BroadcasterSampleRow) => r.time },
	{ name: 'broadcaster_id', type: 'text', get: (r: BroadcasterSampleRow) => r.broadcasterId },
	{ name: 'room_id', type: 'text', get: (r: BroadcasterSampleRow) => r.roomId },
	{ name: 'bitrate_bps', type: 'bigint', get: (r: BroadcasterSampleRow) => r.bitrateBps },
	{ name: 'fps', type: 'real', get: (r: BroadcasterSampleRow) => r.fps },
	{ name: 'packets_expected', type: 'bigint', get: (r: BroadcasterSampleRow) => r.packetsExpected },
	{ name: 'packets_lost', type: 'bigint', get: (r: BroadcasterSampleRow) => r.packetsLost },
	{ name: 'packets_repaired', type: 'bigint', get: (r: BroadcasterSampleRow) => r.packetsRepaired },
	{ name: 'rtt_ms', type: 'real', get: (r: BroadcasterSampleRow) => r.rttMs },
	{ name: 'jitter_ms', type: 'real', get: (r: BroadcasterSampleRow) => r.jitterMs },
	{ name: 'nack_count', type: 'integer', get: (r: BroadcasterSampleRow) => r.nackCount },
	{ name: 'pli_count', type: 'integer', get: (r: BroadcasterSampleRow) => r.pliCount },
	{ name: 'layers_active', type: 'smallint', get: (r: BroadcasterSampleRow) => r.layersActive },
];

const ROOM_COLUMNS = [
	{ name: 'time', type: 'timestamptz', get: (r: OriginRoomSampleRow) => r.time },
	{ name: 'room_id', type: 'text', get: (r: OriginRoomSampleRow) => r.roomId },
	{ name: 'viewer_count', type: 'integer', get: (r: OriginRoomSampleRow) => r.viewerCount },
	{ name: 'out_pipe_bitrate_bps', type: 'bigint', get: (r: OriginRoomSampleRow) => r.outPipeBitrateBps },
];

const PIPE_SEND_COLUMNS = [
	{ name: 'time', type: 'timestamptz', get: (r: PipeSendSampleRow) => r.time },
	{ name: 'room_id', type: 'text', get: (r: PipeSendSampleRow) => r.roomId },
	{ name: 'edge_id', type: 'text', get: (r: PipeSendSampleRow) => r.edgeId },
	{ name: 'remote_ip', type: 'text', get: (r: PipeSendSampleRow) => r.remoteIp },
	{ name: 'producer_id', type: 'text', get: (r: PipeSendSampleRow) => r.producerId },
	{ name: 'kind', type: 'text', get: (r: PipeSendSampleRow) => r.kind },
	{ name: 'packets_expected', type: 'bigint', get: (r: PipeSendSampleRow) => r.packetsExpected },
	{ name: 'packets_lost', type: 'bigint', get: (r: PipeSendSampleRow) => r.packetsLost },
	{ name: 'bitrate_bps', type: 'bigint', get: (r: PipeSendSampleRow) => r.bitrateBps },
	{ name: 'rtt_ms', type: 'real', get: (r: PipeSendSampleRow) => r.rttMs },
	{ name: 'nack_count', type: 'integer', get: (r: PipeSendSampleRow) => r.nackCount },
	{ name: 'pli_count', type: 'integer', get: (r: PipeSendSampleRow) => r.pliCount },
];

export class TimescaleOriginStore extends TimescaleBase implements OriginStore {
	constructor(databaseUrl: string) {
		super(databaseUrl, 'origin');
	}

	async saveBatch(batch: OriginBatch): Promise<void> {
		const client = await this.pool.connect();

		try {
			await client.query('BEGIN');

			const roomIds = [...new Set([...batch.rooms, ...batch.broadcasterSessionStarts.map(s => s.roomId)])];

			if (roomIds.length) {
				await client.query(
					`INSERT INTO room (room_id, first_seen_at, last_seen_at)
					 SELECT id, $2, $2 FROM unnest($1::text[]) AS id
					 ON CONFLICT (room_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at`,
					[roomIds, batch.time]
				);
			}

			for (const s of batch.broadcasterSessionStarts) {
				await client.query(
					`INSERT INTO broadcaster_session (broadcaster_id, room_id, display_name, worker_idx, connected_at)
					 VALUES ($1, $2, $3, $4, $5) ON CONFLICT (broadcaster_id) DO NOTHING`,
					[s.broadcasterId, s.roomId, s.displayName, s.workerIdx, s.connectedAt]
				);
			}

			for (const u of batch.broadcasterSessionUpdates) {
				await client.query(
					`UPDATE broadcaster_session SET state = $2, disconnected_at = coalesce($3, disconnected_at)
					  WHERE broadcaster_id = $1`,
					[u.broadcasterId, u.state, u.disconnectedAt]
				);
			}

			for (const link of batch.roomEdgeLinks) {
				// edge가 아직 heartbeat를 보내지 않았으면 FK를 만족시키기 위해 최소 행을 만든다.
				await client.query(
					`INSERT INTO edge (edge_id, dashboard_url) VALUES ($1, '') ON CONFLICT (edge_id) DO NOTHING`,
					[link.edgeId]
				);
				await client.query(
					`INSERT INTO room_edge_link (room_id, edge_id, state, since) VALUES ($1, $2, $3, $4)
					 ON CONFLICT (room_id, edge_id) DO UPDATE SET state = EXCLUDED.state, since = EXCLUDED.since`,
					[link.roomId, link.edgeId, link.state, link.since]
				);
			}

			await insertRows(client, 'collector_sample', COLLECTOR_COLUMNS, [batch.collector]);
			await insertRows(client, 'worker_sample', WORKER_COLUMNS, batch.workers);
			await insertRows(client, 'broadcaster_sample', BROADCASTER_COLUMNS, batch.broadcasterSamples);
			await insertRows(client, 'room_sample', ROOM_COLUMNS, batch.roomSamples);
			await insertRows(client, 'pipe_send_sample', PIPE_SEND_COLUMNS, batch.pipeSendSamples);
			await client.query('COMMIT');
		} catch (error) {
			await client.query('ROLLBACK').catch(() => {});
			throw error;
		} finally {
			client.release();
		}
	}

	async getOpenBroadcasterSessions() {
		const { rows } = await this.pool.query(
			`SELECT broadcaster_id, room_id, state FROM broadcaster_session WHERE disconnected_at IS NULL`
		);

		// broadcaster_id = "<roomId>/<peerId>@<epoch>" → 정규화기의 키는 "@" 앞부분
		return rows.map(r => ({
			broadcasterId: r.broadcaster_id as string,
			roomId: r.room_id as string,
			key: String(r.broadcaster_id).replace(/@\d+$/, ''),
			state: (r.state === 'sending' ? 'sending' : 'idle') as 'sending' | 'idle',
		}));
	}

	async getConnectedLinks(): Promise<RoomEdgeLinkRow[]> {
		const { rows } = await this.pool.query(`SELECT * FROM room_edge_link WHERE state = 'connected'`);

		return rows.map(r => ({ roomId: r.room_id, edgeId: r.edge_id, state: r.state, since: r.since }));
	}

	async getOriginRoomSummary(windowSeconds = 30): Promise<OriginRoomSummary[]> {
		const { rows } = await this.pool.query(
			`WITH rs AS (
			   SELECT DISTINCT ON (room_id) * FROM room_sample
			    WHERE time > now() - make_interval(secs => $1) ORDER BY room_id, time DESC
			 ), b AS (
			   SELECT room_id, count(*) AS broadcasters, count(*) FILTER (WHERE state = 'sending') AS sending
			     FROM broadcaster_session WHERE disconnected_at IS NULL GROUP BY room_id
			 ), bs AS (
			   SELECT room_id, sum(packets_lost) AS lost, sum(packets_expected) AS expected
			     FROM broadcaster_sample WHERE time > now() - interval '15 seconds' GROUP BY room_id
			 ), bitrate AS (
			   SELECT room_id, sum(bitrate_bps) AS in_bitrate FROM (
			     SELECT DISTINCT ON (broadcaster_id) room_id, bitrate_bps FROM broadcaster_sample
			      WHERE time > now() - make_interval(secs => $1) ORDER BY broadcaster_id, time DESC) x
			   GROUP BY room_id
			 ), e AS (
			   SELECT room_id, count(*) AS edges FROM room_edge_link WHERE state = 'connected' GROUP BY room_id
			 )
			 SELECT rs.room_id, rs.viewer_count, rs.out_pipe_bitrate_bps, rs.time AS last_seen_at,
			        coalesce(b.broadcasters, 0) AS broadcasters, coalesce(b.sending, 0) AS sending,
			        coalesce(e.edges, 0) AS edges, bitrate.in_bitrate, bs.lost, bs.expected
			   FROM rs LEFT JOIN b USING (room_id) LEFT JOIN bs USING (room_id)
			   LEFT JOIN bitrate USING (room_id) LEFT JOIN e USING (room_id)
			  ORDER BY rs.room_id`,
			[windowSeconds]
		);

		return rows.map(r => ({
			roomId: r.room_id,
			broadcasters: toNum(r.broadcasters) ?? 0,
			sendingBroadcasters: toNum(r.sending) ?? 0,
			viewerCount: toNum(r.viewer_count) ?? 0,
			edgeCount: toNum(r.edges) ?? 0,
			inBitrateBps: toNum(r.in_bitrate),
			outPipeBitrateBps: toNum(r.out_pipe_bitrate_bps),
			ingestLossRatio: ratio(r.lost, r.expected),
			lastSeenAt: r.last_seen_at,
		}));
	}

	async getBroadcasters(roomId?: string, windowSeconds = 15): Promise<BroadcasterRecord[]> {
		const { rows } = await this.pool.query(
			`${BROADCASTER_SQL}
			  WHERE s.disconnected_at IS NULL AND ($2::text IS NULL OR s.room_id = $2)
			  ORDER BY s.room_id, s.connected_at`,
			[windowSeconds, roomId ?? null]
		);

		return rows.map(mapBroadcaster);
	}

	async getBroadcaster(broadcasterId: string): Promise<BroadcasterRecord | null> {
		const { rows } = await this.pool.query(`${BROADCASTER_SQL} WHERE s.broadcaster_id = $2`, [15, broadcasterId]);

		return rows[0] ? mapBroadcaster(rows[0]) : null;
	}

	async getRecentBroadcasterSessions(since: Date): Promise<BroadcasterRecord[]> {
		const { rows } = await this.pool.query(
			`${BROADCASTER_SQL} WHERE s.connected_at >= $2 ORDER BY s.connected_at DESC LIMIT 20`,
			[15, since]
		);

		return rows.map(mapBroadcaster);
	}

	async getBroadcasterSeries(broadcasterId: string, range: TimeRange, bucketSeconds: number): Promise<BroadcasterSeriesPoint[]> {
		const { rows } = await this.pool.query(
			`SELECT time_bucket(make_interval(secs => $4), time) AS bucket,
			        avg(bitrate_bps) AS bitrate, avg(fps) AS fps,
			        sum(packets_expected) AS expected, sum(packets_lost) AS lost, sum(packets_repaired) AS repaired,
			        avg(rtt_ms) AS rtt, avg(jitter_ms) AS jitter, sum(nack_count) AS nack, sum(pli_count) AS pli,
			        min(layers_active) AS layers
			   FROM broadcaster_sample
			  WHERE broadcaster_id = $1 AND time >= $2 AND time < $3
			  GROUP BY bucket ORDER BY bucket`,
			[broadcasterId, range.from, range.to, bucketSeconds]
		);

		return rows.map(r => {
			const lost = toNum(r.lost);
			const repaired = toNum(r.repaired);

			return {
				bucket: r.bucket,
				bitrateBps: toNum(r.bitrate),
				fps: toNum(r.fps),
				packetsExpected: toNum(r.expected),
				packetsLost: lost,
				packetsRepaired: repaired,
				lossRatio: ratio(lost, r.expected),
				recoveredLossRatio: lost !== null && repaired !== null ? ratio(Math.max(0, lost - repaired), r.expected) : null,
				rttMs: toNum(r.rtt),
				jitterMs: toNum(r.jitter),
				nackCount: toNum(r.nack),
				pliCount: toNum(r.pli),
				layersActive: toNum(r.layers),
			};
		});
	}

	async getRoomBitrateSeries(roomId: string, range: TimeRange, bucketSeconds: number) {
		const { rows } = await this.pool.query(
			`WITH inb AS (
			   SELECT time_bucket(make_interval(secs => $4), time) AS bucket, sum(bitrate_bps)::float8 / greatest(count(DISTINCT time), 1) AS v
			     FROM broadcaster_sample WHERE room_id = $1 AND time >= $2 AND time < $3 GROUP BY 1
			 ), outb AS (
			   SELECT time_bucket(make_interval(secs => $4), time) AS bucket, avg(out_pipe_bitrate_bps) AS v
			     FROM room_sample WHERE room_id = $1 AND time >= $2 AND time < $3 GROUP BY 1
			 )
			 SELECT coalesce(inb.bucket, outb.bucket) AS bucket, inb.v AS in_bitrate, outb.v AS out_bitrate
			   FROM inb FULL JOIN outb USING (bucket) ORDER BY 1`,
			[roomId, range.from, range.to, bucketSeconds]
		);

		return rows.map(r => ({
			bucket: r.bucket,
			inBitrateBps: toNum(r.in_bitrate),
			outPipeBitrateBps: toNum(r.out_bitrate),
		})) as SeriesPoint<{ inBitrateBps: number | null; outPipeBitrateBps: number | null }>[];
	}

	async getEdges(): Promise<EdgeRecord[]> {
		const { rows } = await this.pool.query(
			`SELECT e.*, h.time AS last_time, h.ok, h.viewer_count, h.rtt_ms, l.lost, l.expected
			   FROM edge e
			   LEFT JOIN LATERAL (SELECT * FROM edge_heartbeat WHERE edge_id = e.edge_id ORDER BY time DESC LIMIT 1) h ON true
			   LEFT JOIN LATERAL (
			     SELECT sum(recv_packets_lost) AS lost, sum(recv_packets_expected) AS expected
			       FROM edge_heartbeat WHERE edge_id = e.edge_id AND time > now() - interval '30 seconds'
			   ) l ON true
			  ORDER BY e.edge_id`
		);

		return rows.map(r => ({
			edgeId: r.edge_id,
			dashboardUrl: r.dashboard_url,
			region: r.region,
			ip: r.ip,
			firstSeenAt: r.first_seen_at,
			lastHeartbeatAt: r.last_time,
			lastOk: r.ok,
			viewerCount: toNum(r.viewer_count),
			recvLossRatio: ratio(r.lost, r.expected),
			heartbeatRttMs: toNum(r.rtt_ms),
		}));
	}

	async getRoomEdgeMatrix(windowSeconds = 30): Promise<RoomEdgeCell[]> {
		const { rows } = await this.pool.query(
			`SELECT coalesce(p.room_id, l.room_id) AS room_id, coalesce(p.edge_id, l.edge_id) AS edge_id,
			        l.state AS link_state, p.bitrate, p.lost, p.expected, p.rtt
			   FROM (SELECT room_id, edge_id,
			                sum(bitrate_bps)::float8 / greatest(count(DISTINCT time), 1) AS bitrate,
			                sum(packets_lost) AS lost, sum(packets_expected) AS expected, avg(rtt_ms) AS rtt
			           FROM pipe_send_sample
			          WHERE time > now() - make_interval(secs => $1) AND edge_id IS NOT NULL
			          GROUP BY room_id, edge_id) p
			   FULL JOIN room_edge_link l ON l.room_id = p.room_id AND l.edge_id = p.edge_id
			  ORDER BY 1, 2`,
			[windowSeconds]
		);

		return rows.map(r => ({
			roomId: r.room_id,
			edgeId: r.edge_id,
			linkState: r.link_state,
			bitrateBps: toNum(r.bitrate),
			lossRatio: ratio(r.lost, r.expected),
			rttMs: toNum(r.rtt),
		}));
	}

	async upsertEdge(edge: { edgeId: string; dashboardUrl: string; region?: string | null; ip?: string | null }): Promise<void> {
		await this.pool.query(
			`INSERT INTO edge (edge_id, dashboard_url, region, ip) VALUES ($1, $2, $3, $4)
			 ON CONFLICT (edge_id) DO UPDATE SET dashboard_url = EXCLUDED.dashboard_url,
			   region = coalesce(EXCLUDED.region, edge.region), ip = coalesce(EXCLUDED.ip, edge.ip)`,
			[edge.edgeId, edge.dashboardUrl, edge.region ?? null, edge.ip ?? null]
		);
	}

	async saveHeartbeat(hb: HeartbeatInput): Promise<void> {
		await this.pool.query(
			`INSERT INTO edge_heartbeat (time, edge_id, ok, rtt_ms, viewer_count, recv_packets_lost, recv_packets_expected)
			 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			[hb.time, hb.edgeId, hb.ok, hb.rttMs, hb.viewerCount, hb.recvPacketsLost, hb.recvPacketsExpected]
		);
	}
}

/** broadcaster 세션 + 최근 구간 지표. $1 = 구간(초). */
const BROADCASTER_SQL = `
	SELECT s.*, l.*
	  FROM broadcaster_session s
	  LEFT JOIN LATERAL (
	    SELECT (array_agg(bitrate_bps ORDER BY time DESC))[1] AS bitrate_bps,
	           sum(packets_lost)::float8 / nullif(sum(packets_expected), 0) AS loss_ratio,
	           (array_agg(fps ORDER BY time DESC))[1] AS fps,
	           (array_agg(layers_active ORDER BY time DESC))[1] AS layers_active,
	           max(time) AS last_sample_at
	      FROM broadcaster_sample b
	     WHERE b.broadcaster_id = s.broadcaster_id AND b.time > now() - make_interval(secs => $1)
	  ) l ON true`;

function mapBroadcaster(r: Record<string, any>): BroadcasterRecord {
	return {
		broadcasterId: r.broadcaster_id,
		roomId: r.room_id,
		displayName: r.display_name,
		workerIdx: r.worker_idx,
		connectedAt: r.connected_at,
		disconnectedAt: r.disconnected_at,
		state: r.state,
		bitrateBps: toNum(r.bitrate_bps),
		lossRatio: toNum(r.loss_ratio),
		fps: toNum(r.fps),
		layersActive: toNum(r.layers_active),
		lastSampleAt: r.last_sample_at,
	};
}
