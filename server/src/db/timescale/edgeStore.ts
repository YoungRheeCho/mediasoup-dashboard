import type {
	EdgeBatch,
	EdgeRoomSampleRow,
	PipeSampleRow,
	ViewerSampleRow,
	ViewerSessionStart,
	WorkerSampleRow,
} from '../rows.js';
import type {
	EdgeStore,
	LossDistribution,
	PipeSeriesPoint,
	RoomSummary,
	SeriesPoint,
	TimeRange,
	ViewerListFilter,
	ViewerListItem,
	ViewerLossPercentilePoint,
	ViewerSeriesPoint,
} from '../store.js';
import { COLLECTOR_COLUMNS, TimescaleBase } from './common.js';
import { insertRows, ratio, toNum, useAggregate } from './sql.js';

export const WORKER_COLUMNS = [
	{ name: 'time', type: 'timestamptz', get: (r: WorkerSampleRow) => r.time },
	{ name: 'worker_idx', type: 'smallint', get: (r: WorkerSampleRow) => r.workerIdx },
	{ name: 'cpu_pct', type: 'real', get: (r: WorkerSampleRow) => r.cpuPct },
	{ name: 'mem_rss_bytes', type: 'bigint', get: (r: WorkerSampleRow) => r.memRssBytes },
	{ name: 'router_count', type: 'smallint', get: (r: WorkerSampleRow) => r.routerCount },
	{ name: 'transport_count', type: 'integer', get: (r: WorkerSampleRow) => r.transportCount },
	{ name: 'producer_count', type: 'integer', get: (r: WorkerSampleRow) => r.producerCount },
	{ name: 'consumer_count', type: 'integer', get: (r: WorkerSampleRow) => r.consumerCount },
];

const ROOM_COLUMNS = [
	{ name: 'time', type: 'timestamptz', get: (r: EdgeRoomSampleRow) => r.time },
	{ name: 'room_id', type: 'text', get: (r: EdgeRoomSampleRow) => r.roomId },
	{ name: 'worker_idx', type: 'smallint', get: (r: EdgeRoomSampleRow) => r.workerIdx },
	{ name: 'viewer_count', type: 'integer', get: (r: EdgeRoomSampleRow) => r.viewerCount },
	{ name: 'producer_count', type: 'smallint', get: (r: EdgeRoomSampleRow) => r.producerCount },
	{ name: 'out_bitrate_bps', type: 'bigint', get: (r: EdgeRoomSampleRow) => r.outBitrateBps },
	{ name: 'in_bitrate_bps', type: 'bigint', get: (r: EdgeRoomSampleRow) => r.inBitrateBps },
];

const PIPE_COLUMNS = [
	{ name: 'time', type: 'timestamptz', get: (r: PipeSampleRow) => r.time },
	{ name: 'room_id', type: 'text', get: (r: PipeSampleRow) => r.roomId },
	{ name: 'producer_id', type: 'text', get: (r: PipeSampleRow) => r.producerId },
	{ name: 'kind', type: 'text', get: (r: PipeSampleRow) => r.kind },
	{ name: 'packets_expected', type: 'bigint', get: (r: PipeSampleRow) => r.packetsExpected },
	{ name: 'packets_lost', type: 'bigint', get: (r: PipeSampleRow) => r.packetsLost },
	{ name: 'packets_repaired', type: 'bigint', get: (r: PipeSampleRow) => r.packetsRepaired },
	{ name: 'bitrate_bps', type: 'bigint', get: (r: PipeSampleRow) => r.bitrateBps },
	{ name: 'rtt_ms', type: 'real', get: (r: PipeSampleRow) => r.rttMs },
	{ name: 'jitter_ms', type: 'real', get: (r: PipeSampleRow) => r.jitterMs },
	{ name: 'nack_count', type: 'integer', get: (r: PipeSampleRow) => r.nackCount },
	{ name: 'pli_count', type: 'integer', get: (r: PipeSampleRow) => r.pliCount },
];

const VIEWER_COLUMNS = [
	{ name: 'time', type: 'timestamptz', get: (r: ViewerSampleRow) => r.time },
	{ name: 'viewer_id', type: 'text', get: (r: ViewerSampleRow) => r.viewerId },
	{ name: 'room_id', type: 'text', get: (r: ViewerSampleRow) => r.roomId },
	{ name: 'worker_idx', type: 'smallint', get: (r: ViewerSampleRow) => r.workerIdx },
	{ name: 'packets_expected', type: 'bigint', get: (r: ViewerSampleRow) => r.packetsExpected },
	{ name: 'packets_lost', type: 'bigint', get: (r: ViewerSampleRow) => r.packetsLost },
	{ name: 'nack_count', type: 'integer', get: (r: ViewerSampleRow) => r.nackCount },
	{ name: 'packets_retransmitted', type: 'bigint', get: (r: ViewerSampleRow) => r.packetsRetransmitted },
	{ name: 'rtt_ms', type: 'real', get: (r: ViewerSampleRow) => r.rttMs },
	{ name: 'bitrate_bps', type: 'bigint', get: (r: ViewerSampleRow) => r.bitrateBps },
	{ name: 'spatial_layer', type: 'smallint', get: (r: ViewerSampleRow) => r.spatialLayer },
	{ name: 'temporal_layer', type: 'smallint', get: (r: ViewerSampleRow) => r.temporalLayer },
	{ name: 'transport_state', type: 'text', get: (r: ViewerSampleRow) => r.transportState },
	{ name: 'client_reported', type: 'boolean', get: (r: ViewerSampleRow) => r.clientReported },
	{ name: 'client_freeze_count', type: 'integer', get: (r: ViewerSampleRow) => r.clientFreezeCount },
	{ name: 'client_freeze_ms', type: 'integer', get: (r: ViewerSampleRow) => r.clientFreezeMs },
	{ name: 'client_fps', type: 'real', get: (r: ViewerSampleRow) => r.clientFps },
	{ name: 'client_jitter_buffer_ms', type: 'real', get: (r: ViewerSampleRow) => r.clientJitterBufferMs },
	{ name: 'client_frames_dropped', type: 'integer', get: (r: ViewerSampleRow) => r.clientFramesDropped },
];

const SESSION_COLUMNS = [
	{ name: 'viewer_id', type: 'text', get: (r: ViewerSessionStart) => r.viewerId },
	{ name: 'room_id', type: 'text', get: (r: ViewerSessionStart) => r.roomId },
	{ name: 'worker_idx', type: 'smallint', get: (r: ViewerSessionStart) => r.workerIdx },
	{ name: 'connected_at', type: 'timestamptz', get: (r: ViewerSessionStart) => r.connectedAt },
	{ name: 'peer_id', type: 'text', get: (r: ViewerSessionStart) => r.peerId },
	{ name: 'display_name', type: 'text', get: (r: ViewerSessionStart) => r.displayName },
	{ name: 'device_flag', type: 'text', get: (r: ViewerSessionStart) => r.deviceFlag },
	{ name: 'browser_name', type: 'text', get: (r: ViewerSessionStart) => r.browserName },
	{ name: 'browser_version', type: 'text', get: (r: ViewerSessionStart) => r.browserVersion },
	{ name: 'remote_ip', type: 'text', get: (r: ViewerSessionStart) => r.remoteIp },
	{ name: 'identity_source', type: 'text', get: (r: ViewerSessionStart) => r.identitySource },
	{ name: 'device_class', type: 'text', get: (r: ViewerSessionStart) => r.deviceClass },
	{ name: 'network_type', type: 'text', get: (r: ViewerSessionStart) => r.networkType },
	{ name: 'user_agent', type: 'text', get: (r: ViewerSessionStart) => r.userAgent },
];

/** viewer loss 구간 분포 (Overview "viewer loss 구간 분포") */
const LOSS_BUCKETS: Array<[string, number, number | null]> = [
	['<1%', 0, 0.01],
	['1–2%', 0.01, 0.02],
	['2–5%', 0.02, 0.05],
	['5–10%', 0.05, 0.1],
	['≥10%', 0.1, null],
];

export class TimescaleEdgeStore extends TimescaleBase implements EdgeStore {
	constructor(databaseUrl: string) {
		super(databaseUrl, 'edge');
	}

	async saveBatch(batch: EdgeBatch): Promise<void> {
		const client = await this.pool.connect();

		try {
			await client.query('BEGIN');

			// 방송 목록 (FK 대상이라 먼저)
			const roomIds = [...new Set([...batch.rooms, ...batch.viewerSessionStarts.map(s => s.roomId)])];

			if (roomIds.length) {
				await client.query(
					`INSERT INTO room (room_id, first_seen_at, last_seen_at)
					 SELECT id, $2, $2 FROM unnest($1::text[]) AS id
					 ON CONFLICT (room_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at`,
					[roomIds, batch.time]
				);
			}

			if (batch.viewerSessionStarts.length) {
				const cols = SESSION_COLUMNS.map(c => c.name).join(', ');
				const params = SESSION_COLUMNS.map((c, i) => `$${i + 1}::${c.type}[]`).join(', ');

				// 이미 있는 세션은 "실제 신원이나 IP를 나중에 찾은 경우"에만 신원 칸을 갱신한다. 실제 값을 mock이나 null로 덮지 않는다.
				await client.query(
					`INSERT INTO viewer_session (${cols}) SELECT * FROM unnest(${params})
					 ON CONFLICT (viewer_id) DO UPDATE SET
					   identity_source = EXCLUDED.identity_source, peer_id = EXCLUDED.peer_id,
					   display_name = EXCLUDED.display_name, device_flag = EXCLUDED.device_flag,
					   browser_name = EXCLUDED.browser_name, browser_version = EXCLUDED.browser_version,
					   remote_ip = coalesce(EXCLUDED.remote_ip, viewer_session.remote_ip), user_agent = EXCLUDED.user_agent
					 WHERE EXCLUDED.identity_source = 'peer'
					   AND (viewer_session.identity_source IS DISTINCT FROM 'peer'
					        OR (EXCLUDED.remote_ip IS NOT NULL AND viewer_session.remote_ip IS NULL))`,
					SESSION_COLUMNS.map(c => batch.viewerSessionStarts.map(r => c.get(r) ?? null))
				);
			}

			if (batch.viewerSessionEnds.length) {
				await client.query(
					`UPDATE viewer_session s SET disconnected_at = e.at, disconnect_reason = e.reason
					   FROM unnest($1::text[], $2::timestamptz[], $3::text[]) AS e(id, at, reason)
					  WHERE s.viewer_id = e.id AND s.disconnected_at IS NULL`,
					[
						batch.viewerSessionEnds.map(e => e.viewerId),
						batch.viewerSessionEnds.map(e => e.disconnectedAt),
						batch.viewerSessionEnds.map(e => e.disconnectReason),
					]
				);
			}

			await insertRows(client, 'collector_sample', COLLECTOR_COLUMNS, [batch.collector]);
			await insertRows(client, 'worker_sample', WORKER_COLUMNS, batch.workers);
			await insertRows(client, 'room_sample', ROOM_COLUMNS, batch.roomSamples);
			await insertRows(client, 'pipe_sample', PIPE_COLUMNS, batch.pipeSamples);
			await insertRows(client, 'viewer_sample', VIEWER_COLUMNS, batch.viewerSamples);
			await client.query('COMMIT');
		} catch (error) {
			await client.query('ROLLBACK').catch(() => {});
			throw error;
		} finally {
			client.release();
		}
	}

	async getOpenViewerSessionIds(): Promise<string[]> {
		const { rows } = await this.pool.query(`SELECT viewer_id FROM viewer_session WHERE disconnected_at IS NULL`);

		return rows.map(r => r.viewer_id);
	}

	async getRoomSummary(windowSeconds = 30): Promise<RoomSummary[]> {
		const { rows } = await this.pool.query(
			`WITH latest AS (
			   SELECT DISTINCT ON (room_id, worker_idx) *
			     FROM room_sample WHERE time > now() - make_interval(secs => $1)
			    ORDER BY room_id, worker_idx, time DESC
			 ), rooms AS (
			   SELECT room_id, sum(viewer_count) AS viewer_count, array_agg(DISTINCT worker_idx ORDER BY worker_idx) AS workers,
			          sum(producer_count) AS producer_count, sum(in_bitrate_bps) AS in_bitrate_bps,
			          sum(out_bitrate_bps) AS out_bitrate_bps, max(time) AS last_seen_at
			     FROM latest GROUP BY room_id
			 ), vloss AS (
			   SELECT room_id, sum(packets_lost) AS lost, sum(packets_expected) AS expected,
			          percentile_cont(0.5) WITHIN GROUP (ORDER BY packets_lost::float8 / packets_expected) AS p50
			     FROM viewer_sample
			    WHERE time > now() - interval '10 seconds' * 1.5 AND packets_expected > 0
			    GROUP BY room_id
			 ), ploss AS (
			   SELECT room_id, sum(packets_lost) AS lost, sum(packets_expected) AS expected
			     FROM pipe_sample WHERE time > now() - interval '15 seconds' AND packets_expected > 0
			    GROUP BY room_id
			 )
			 SELECT r.*, v.lost AS v_lost, v.expected AS v_expected, v.p50 AS v_p50, p.lost AS p_lost, p.expected AS p_expected
			   FROM rooms r LEFT JOIN vloss v USING (room_id) LEFT JOIN ploss p USING (room_id)
			  ORDER BY r.viewer_count DESC, r.room_id`,
			[windowSeconds]
		);

		return rows.map(r => ({
			roomId: r.room_id,
			viewerCount: toNum(r.viewer_count) ?? 0,
			workers: r.workers,
			producerCount: toNum(r.producer_count),
			inBitrateBps: toNum(r.in_bitrate_bps),
			outBitrateBps: toNum(r.out_bitrate_bps),
			viewerLossRatio: ratio(r.v_lost, r.v_expected),
			viewerLossP50: toNum(r.v_p50),
			pipeLossRatio: ratio(r.p_lost, r.p_expected),
			lastSeenAt: r.last_seen_at,
		}));
	}

	async getRoomViewerSeries(roomId: string, range: TimeRange, bucketSeconds: number): Promise<SeriesPoint<{ viewerCount: number }>[]> {
		// 같은 bucket 안에서는 수집 시각별 합(worker shard 합)의 최대값
		const { rows } = await this.pool.query(
			`SELECT time_bucket(make_interval(secs => $4), time) AS bucket, max(total) AS viewer_count
			   FROM (SELECT time, sum(viewer_count) AS total FROM room_sample
			          WHERE room_id = $1 AND time >= $2 AND time < $3 GROUP BY time) t
			  GROUP BY bucket ORDER BY bucket`,
			[roomId, range.from, range.to, bucketSeconds]
		);

		return rows.map(r => ({ bucket: r.bucket, viewerCount: toNum(r.viewer_count) ?? 0 }));
	}

	async getPipeSeries(range: TimeRange, bucketSeconds: number, roomId?: string): Promise<PipeSeriesPoint[]> {
		const agg = useAggregate(range.to.getTime() - range.from.getTime(), bucketSeconds);
		const sql = agg
			? `SELECT time_bucket(make_interval(secs => $3), bucket) AS bucket, room_id,
			          sum(packets_expected) AS expected, sum(packets_lost) AS lost, sum(packets_repaired) AS repaired,
			          avg(rtt_avg_ms) AS rtt, avg(jitter_avg_ms) AS jitter,
			          NULL::float8 AS bitrate, sum(nack_count) AS nack, sum(pli_count) AS pli
			     FROM pipe_room_1m
			    WHERE bucket >= $1 AND bucket < $2 AND ($4::text IS NULL OR room_id = $4)
			    GROUP BY 1, room_id ORDER BY 1`
			: `SELECT time_bucket(make_interval(secs => $3), time) AS bucket, room_id,
			          sum(packets_expected) AS expected, sum(packets_lost) AS lost, sum(packets_repaired) AS repaired,
			          avg(rtt_ms) AS rtt, avg(jitter_ms) AS jitter,
			          sum(bitrate_bps)::float8 / greatest(count(DISTINCT time), 1) AS bitrate,
			          sum(nack_count) AS nack, sum(pli_count) AS pli
			     FROM pipe_sample
			    WHERE time >= $1 AND time < $2 AND ($4::text IS NULL OR room_id = $4)
			    GROUP BY 1, room_id ORDER BY 1`;
		const { rows } = await this.pool.query(sql, [range.from, range.to, bucketSeconds, roomId ?? null]);

		return rows.map(r => {
			const lost = toNum(r.lost);
			const repaired = toNum(r.repaired);

			return {
				bucket: r.bucket,
				roomId: r.room_id,
				packetsExpected: toNum(r.expected),
				packetsLost: lost,
				packetsRepaired: repaired,
				lossRatio: ratio(lost, r.expected),
				recoveredLossRatio: lost !== null && repaired !== null ? ratio(Math.max(0, lost - repaired), r.expected) : null,
				rttMs: toNum(r.rtt),
				jitterMs: toNum(r.jitter),
				bitrateBps: toNum(r.bitrate),
				nackCount: toNum(r.nack),
				pliCount: toNum(r.pli),
			};
		});
	}

	async getViewerList(filter: ViewerListFilter, windowSeconds = 15): Promise<ViewerListItem[]> {
		const order: Record<string, string> = {
			loss: 'loss_ratio DESC NULLS LAST',
			freeze: 'freeze_count DESC NULLS LAST',
			rtt: 'rtt_ms DESC NULLS LAST',
			layer: 'spatial_layer ASC NULLS LAST',
			connected: 'connected_at ASC',
		};
		const { rows } = await this.pool.query(
			`${VIEWER_LIST_SQL}
			  WHERE s.disconnected_at IS NULL
			    AND ($2::text IS NULL OR s.room_id = $2)
			    AND ($3::float8 IS NULL OR l.loss_ratio >= $3)
			    AND ($4::text IS NULL OR s.device_class = $4)
			    AND ($5::int IS NULL OR l.spatial_layer <= $5)
			  ORDER BY ${order[filter.sort ?? 'loss'] ?? order.loss}
			  LIMIT $6`,
			[
				windowSeconds,
				filter.roomId ?? null,
				filter.minLossRatio ?? null,
				filter.deviceClass ?? null,
				filter.maxSpatialLayer ?? null,
				filter.limit ?? 500,
			]
		);

		return rows.map(mapViewer);
	}

	async getViewerSession(viewerId: string): Promise<ViewerListItem | null> {
		const { rows } = await this.pool.query(`${VIEWER_LIST_SQL} WHERE s.viewer_id = $2`, [15, viewerId]);

		return rows[0] ? mapViewer(rows[0]) : null;
	}

	async getViewerSeries(viewerId: string, range: TimeRange, bucketSeconds: number): Promise<ViewerSeriesPoint[]> {
		const { rows } = await this.pool.query(
			`SELECT time_bucket(make_interval(secs => $4), time) AS bucket,
			        sum(packets_expected) AS expected, sum(packets_lost) AS lost,
			        sum(nack_count) AS nack, sum(packets_retransmitted) AS retrans,
			        avg(rtt_ms) AS rtt, avg(bitrate_bps) AS bitrate, min(spatial_layer) AS spatial_layer,
			        (array_agg(transport_state ORDER BY time DESC))[1] AS transport_state,
			        bool_or(client_reported) AS client_reported,
			        sum(client_freeze_count) AS freeze_count, sum(client_freeze_ms) AS freeze_ms,
			        avg(client_fps) AS fps, avg(client_jitter_buffer_ms) AS jb, sum(client_frames_dropped) AS dropped
			   FROM viewer_sample
			  WHERE viewer_id = $1 AND time >= $2 AND time < $3
			  GROUP BY bucket ORDER BY bucket`,
			[viewerId, range.from, range.to, bucketSeconds]
		);

		return rows.map(r => ({
			bucket: r.bucket,
			packetsExpected: toNum(r.expected),
			packetsLost: toNum(r.lost),
			lossRatio: ratio(r.lost, r.expected),
			nackCount: toNum(r.nack),
			packetsRetransmitted: toNum(r.retrans),
			rttMs: toNum(r.rtt),
			bitrateBps: toNum(r.bitrate),
			spatialLayer: toNum(r.spatial_layer),
			transportState: r.transport_state,
			clientReported: Boolean(r.client_reported),
			clientFreezeCount: toNum(r.freeze_count),
			clientFreezeMs: toNum(r.freeze_ms),
			clientFps: toNum(r.fps),
			clientJitterBufferMs: toNum(r.jb),
			clientFramesDropped: toNum(r.dropped),
		}));
	}

	/**
	 * viewer loss p50/p95 추이. viewer마다 bucket 안 loss 비율을 먼저 구한 뒤 백분위를 낸다.
	 * 원본(48시간)에서만 계산한다. 1분 집계는 합계만 있어 백분위를 만들 수 없다.
	 */
	async getViewerLossPercentiles(range: TimeRange, bucketSeconds: number, roomId?: string): Promise<ViewerLossPercentilePoint[]> {
		const { rows } = await this.pool.query(
			`SELECT bucket,
			        percentile_cont(0.5)  WITHIN GROUP (ORDER BY loss) AS p50,
			        percentile_cont(0.95) WITHIN GROUP (ORDER BY loss) AS p95,
			        count(*) AS viewers
			   FROM (SELECT time_bucket(make_interval(secs => $3), time) AS bucket, viewer_id,
			                sum(packets_lost)::float8 / sum(packets_expected) AS loss
			           FROM viewer_sample
			          WHERE time >= $1 AND time < $2 AND packets_expected > 0 AND ($4::text IS NULL OR room_id = $4)
			          GROUP BY 1, viewer_id) v
			  GROUP BY bucket ORDER BY bucket`,
			[range.from, range.to, bucketSeconds, roomId ?? null]
		);

		return rows.map(r => ({ bucket: r.bucket, p50: toNum(r.p50), p95: toNum(r.p95), viewers: toNum(r.viewers) ?? 0 }));
	}

	async getBadViewerRatioAt(at: Date, windowSeconds: number, threshold: number): Promise<number | null> {
		const { rows } = await this.pool.query(
			`SELECT avg((loss >= $3)::int) AS ratio FROM (
			   SELECT sum(packets_lost)::float8 / sum(packets_expected) AS loss
			     FROM viewer_sample
			    WHERE time > $1::timestamptz - make_interval(secs => $2) AND time <= $1 AND packets_expected > 0
			    GROUP BY viewer_id) v`,
			[at, windowSeconds, threshold]
		);

		return toNum(rows[0]?.ratio);
	}

	async getLayerSwitchesPerMinute(roomId: string, windowSeconds: number): Promise<number | null> {
		const { rows } = await this.pool.query(
			`SELECT count(*) FILTER (WHERE prev IS NOT NULL AND prev <> spatial_layer) AS switches, count(*) AS samples
			   FROM (SELECT spatial_layer, lag(spatial_layer) OVER (PARTITION BY viewer_id ORDER BY time) AS prev
			           FROM viewer_sample
			          WHERE room_id = $1 AND time > now() - make_interval(secs => $2) AND spatial_layer IS NOT NULL) s`,
			[roomId, windowSeconds]
		);
		const samples = toNum(rows[0]?.samples) ?? 0;

		return samples > 0 ? Math.round(((toNum(rows[0]?.switches) ?? 0) / windowSeconds) * 60 * 10) / 10 : null;
	}

	async getRoomsFirstSeen(since: Date): Promise<Array<{ roomId: string; firstSeenAt: Date }>> {
		const { rows } = await this.pool.query(
			`SELECT room_id, first_seen_at FROM room WHERE first_seen_at >= $1 ORDER BY first_seen_at DESC LIMIT 20`,
			[since]
		);

		return rows.map(r => ({ roomId: r.room_id, firstSeenAt: r.first_seen_at }));
	}

	async getViewerLossDistribution(windowSeconds = 15, roomId?: string): Promise<LossDistribution> {
		const { rows } = await this.pool.query(
			`SELECT sum(packets_lost)::float8 / sum(packets_expected) AS loss
			   FROM viewer_sample
			  WHERE time > now() - make_interval(secs => $1) AND packets_expected > 0 AND ($2::text IS NULL OR room_id = $2)
			  GROUP BY viewer_id`,
			[windowSeconds, roomId ?? null]
		);
		const losses = rows.map(r => toNum(r.loss) ?? 0);

		return LOSS_BUCKETS.map(([label, lower, upper]) => ({
			label,
			lower,
			upper,
			viewers: losses.filter(l => l >= lower && (upper === null || l < upper)).length,
		}));
	}
}

/** 열린 세션 + 최근 구간 지표. $1 = 구간(초). */
const VIEWER_LIST_SQL = `
	SELECT s.*, l.*
	  FROM viewer_session s
	  LEFT JOIN LATERAL (
	    SELECT sum(packets_lost)::float8 / nullif(sum(packets_expected), 0) AS loss_ratio,
	           avg(rtt_ms) AS rtt_ms, avg(bitrate_bps) AS bitrate_bps,
	           (array_agg(spatial_layer ORDER BY time DESC))[1] AS spatial_layer,
	           (array_agg(temporal_layer ORDER BY time DESC))[1] AS temporal_layer,
	           (array_agg(transport_state ORDER BY time DESC))[1] AS transport_state,
	           sum(client_freeze_count) AS freeze_count,
	           bool_or(client_reported) AS client_reported,
	           max(time) AS last_sample_at
	      FROM viewer_sample v
	     WHERE v.viewer_id = s.viewer_id AND v.time > now() - make_interval(secs => $1)
	  ) l ON true`;

function mapViewer(r: Record<string, any>): ViewerListItem {
	return {
		viewerId: r.viewer_id,
		roomId: r.room_id,
		workerIdx: r.worker_idx,
		connectedAt: r.connected_at,
		disconnectedAt: r.disconnected_at,
		disconnectReason: r.disconnect_reason,
		peerId: r.peer_id,
		displayName: r.display_name,
		deviceFlag: r.device_flag,
		browserName: r.browser_name ?? null,
		browserVersion: r.browser_version ?? null,
		remoteIp: r.remote_ip ?? null,
		identitySource: r.identity_source ?? null,
		deviceClass: r.device_class,
		networkType: r.network_type,
		lossRatio: toNum(r.loss_ratio),
		rttMs: toNum(r.rtt_ms),
		bitrateBps: toNum(r.bitrate_bps),
		spatialLayer: toNum(r.spatial_layer),
		temporalLayer: toNum(r.temporal_layer),
		transportState: r.transport_state,
		freezeCount: toNum(r.freeze_count),
		clientReported: Boolean(r.client_reported),
		lastSampleAt: r.last_sample_at,
	};
}
