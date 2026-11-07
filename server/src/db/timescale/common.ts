import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import pg from 'pg';

import type { NewAlertEvent } from '../../alerts/evaluator.js';
import type { Mode } from '../../config.js';
import { createLogger } from '../../log.js';
import type { CollectorSampleRow } from '../rows.js';
import type {
	AlertEventRecord,
	AlertRuleRecord,
	ServerSeriesPoint,
	TimeRange,
	WorkerSeriesPoint,
} from '../store.js';
import { insertRows, toNum } from './sql.js';

const logger = createLogger('db');

// timestamptz는 Date로, bigint(20)/numeric(1700)은 문자열 그대로 두고 toNum으로 바꾼다.
pg.types.setTypeParser(20, v => Number(v));

/** 대시보드 스키마가 만드는 테이블 (edge·origin 합집합). 이 밖의 테이블이 있으면 초기화하지 않는다. */
const OWN_TABLES = [
	'room', 'viewer_session', 'alert_rule', 'alert_event', 'collector_sample', 'worker_sample', 'room_sample',
	'pipe_sample', 'viewer_sample', 'edge', 'broadcaster_session', 'room_edge_link', 'broadcaster_sample',
	'pipe_send_sample', 'edge_heartbeat', 'msdash_schema',
];

export const COLLECTOR_COLUMNS = [
	{ name: 'time', type: 'timestamptz', get: (r: CollectorSampleRow) => r.time },
	{ name: 'hook_ok', type: 'boolean', get: (r: CollectorSampleRow) => r.hookOk },
	{ name: 'collect_duration_ms', type: 'integer', get: (r: CollectorSampleRow) => r.collectDurationMs },
	{ name: 'collect_skipped', type: 'boolean', get: (r: CollectorSampleRow) => r.collectSkipped },
	{ name: 'event_loop_lag_ms', type: 'real', get: (r: CollectorSampleRow) => r.eventLoopLagMs },
	{ name: 'node_rss_bytes', type: 'bigint', get: (r: CollectorSampleRow) => r.nodeRssBytes },
	{ name: 'host_cpu_pct', type: 'real', get: (r: CollectorSampleRow) => r.hostCpuPct },
];

/**
 * edge·origin 공통 부분. 연결 풀, 스키마 초기화, 수집기·worker 시계열, 알림, 보관 정책.
 */
export class TimescaleBase {
	readonly pool: pg.Pool;

	constructor(
		private readonly databaseUrl: string,
		protected readonly mode: Mode
	) {
		this.pool = new pg.Pool({ connectionString: databaseUrl, max: 5, idleTimeoutMillis: 30000 });
		this.pool.on('error', error => logger.warn('idle client error: %s', error.message));
	}

	/**
	 * 스키마 초기화.
	 *  - 완료 표시(msdash_schema)가 있으면 시드만 다시 적용한다 (ON CONFLICT DO NOTHING이라 멱등).
	 *  - 표시가 없는데 테이블이 있으면 적용 도중 끊긴 DB다. 한 번도 완성된 적이 없으니 지우고 다시 만든다.
	 *    (continuous aggregate는 트랜잭션 안에서 만들 수 없어 전체를 한 트랜잭션으로 묶을 수 없다.)
	 */
	async init(schemaDir: string, autoInit: boolean): Promise<void> {
		const read = (file: string) => readFile(join(schemaDir, file), 'utf8');
		const { rows } = await this.pool.query<{ done: boolean; partial: boolean; foreign: string[] }>(
			`SELECT to_regclass('public.msdash_schema') IS NOT NULL AS done,
			        EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public') AS partial,
			        coalesce(array_agg(tablename::text) FILTER (WHERE tablename <> ALL($1::text[])), '{}'::text[]) AS foreign
			   FROM pg_tables WHERE schemaname = 'public'`,
			[OWN_TABLES]
		);

		if (!rows[0]?.done && rows[0]?.foreign.length) {
			// 대시보드 전용 DB가 아닌 곳을 가리키고 있다. 절대 지우지 않는다.
			throw new Error(`database has tables not owned by the dashboard (${rows[0].foreign.slice(0, 5).join(', ')}); refusing to initialize`);
		}

		if (rows[0]?.done) {
			await this.pool.query(await read(`${this.mode}_seed.sql`));

			return;
		}

		if (!autoInit) {
			throw new Error('database schema missing or incomplete and MSDASH_DB_AUTO_INIT=0');
		}

		if (rows[0]?.partial) {
			logger.warn('incomplete %s schema found (initialization was interrupted); recreating', this.mode);
			await this.#withFreshClient(c => c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'));
		}

		// 확장을 지운 직후의 같은 세션에서는 timescaledb를 다시 만들 수 없어(라이브러리가 이미 로드됨) 새 연결을 쓴다.
		logger.info('applying %s schema from %s', this.mode, schemaDir);
		await this.#withFreshClient(async c => {
			await c.query(await read(`${this.mode}_schema.sql`));
			await c.query(await read(`${this.mode}_seed.sql`));
		});
	}

	async #withFreshClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
		const client = new pg.Client({ connectionString: this.databaseUrl });

		await client.connect();

		try {
			return await fn(client);
		} finally {
			await client.end().catch(() => {});
		}
	}

	async applyRetention(retention: { viewerRawHours: number; rawDays: number; aggregateDays: number }): Promise<void> {
		const raw = `${retention.rawDays} days`;
		const agg = `${retention.aggregateDays} days`;
		const policies: Array<[string, string]> =
			this.mode === 'edge'
				? [
						['viewer_sample', `${retention.viewerRawHours} hours`],
						['pipe_sample', raw],
						['room_sample', raw],
						['worker_sample', raw],
						['collector_sample', raw],
						['viewer_room_1m', agg],
						['pipe_room_1m', agg],
					]
				: [
						['broadcaster_sample', raw],
						['pipe_send_sample', raw],
						['worker_sample', raw],
						['collector_sample', raw],
						['room_sample', agg],
						['edge_heartbeat', agg],
					];

		for (const [table, interval] of policies) {
			await this.pool.query(`SELECT remove_retention_policy($1, if_exists => true)`, [table]);
			await this.pool.query(`SELECT add_retention_policy($1, $2::interval)`, [table, interval]);
		}
	}

	async saveCollectorFailure(row: CollectorSampleRow): Promise<void> {
		const client = await this.pool.connect();

		try {
			await insertRows(client, 'collector_sample', COLLECTOR_COLUMNS, [row]);
		} finally {
			client.release();
		}
	}

	async getServerSeries(range: TimeRange, bucketSeconds: number): Promise<ServerSeriesPoint[]> {
		const { rows } = await this.pool.query(
			`SELECT time_bucket(make_interval(secs => $3), time) AS bucket,
			        avg(hook_ok::int)            AS hook_ok_ratio,
			        avg(collect_duration_ms)     AS collect_duration_ms,
			        count(*) FILTER (WHERE collect_skipped) AS skipped,
			        max(event_loop_lag_ms)       AS event_loop_lag_ms,
			        max(node_rss_bytes)          AS node_rss_bytes,
			        avg(host_cpu_pct)            AS host_cpu_pct
			   FROM collector_sample
			  WHERE time >= $1 AND time < $2
			  GROUP BY bucket ORDER BY bucket`,
			[range.from, range.to, bucketSeconds]
		);

		return rows.map(r => ({
			bucket: r.bucket,
			hookOkRatio: toNum(r.hook_ok_ratio) ?? 0,
			collectDurationMs: toNum(r.collect_duration_ms),
			skippedCycles: toNum(r.skipped) ?? 0,
			eventLoopLagMs: toNum(r.event_loop_lag_ms),
			nodeRssBytes: toNum(r.node_rss_bytes),
			hostCpuPct: toNum(r.host_cpu_pct),
		}));
	}

	async getWorkerSeries(range: TimeRange, bucketSeconds: number): Promise<WorkerSeriesPoint[]> {
		const { rows } = await this.pool.query(
			`SELECT time_bucket(make_interval(secs => $3), time) AS bucket, worker_idx,
			        avg(cpu_pct) AS cpu_pct, max(mem_rss_bytes) AS mem_rss_bytes,
			        max(router_count) AS router_count, max(transport_count) AS transport_count,
			        max(consumer_count) AS consumer_count
			   FROM worker_sample
			  WHERE time >= $1 AND time < $2
			  GROUP BY bucket, worker_idx ORDER BY bucket, worker_idx`,
			[range.from, range.to, bucketSeconds]
		);

		return rows.map(r => ({
			bucket: r.bucket,
			workerIdx: r.worker_idx,
			cpuPct: toNum(r.cpu_pct),
			memRssBytes: toNum(r.mem_rss_bytes),
			routerCount: toNum(r.router_count),
			transportCount: toNum(r.transport_count),
			consumerCount: toNum(r.consumer_count),
		}));
	}

	async getAlertRules(): Promise<AlertRuleRecord[]> {
		const { rows } = await this.pool.query(`SELECT * FROM alert_rule ORDER BY rule_id`);

		return rows.map(r => ({
			ruleId: r.rule_id,
			title: r.title,
			metric: r.metric,
			warnAbove: toNum(r.warn_above),
			critAbove: toNum(r.crit_above),
			windowSeconds: r.window_seconds,
			enabled: r.enabled,
		}));
	}

	async getAlertHistory(range: TimeRange, limit = 200): Promise<AlertEventRecord[]> {
		const { rows } = await this.pool.query(
			`SELECT e.*, r.title FROM alert_event e JOIN alert_rule r USING (rule_id)
			  WHERE e.started_at >= $1 AND e.started_at < $2
			  ORDER BY e.started_at DESC LIMIT $3`,
			[range.from, range.to, limit]
		);

		return rows.map(mapAlert);
	}

	async insertAlertEvent(e: NewAlertEvent): Promise<number> {
		const { rows } = await this.pool.query(
			`INSERT INTO alert_event (rule_id, severity, state, subject_type, subject_id, value, threshold, started_at)
			 VALUES ($1, $2, 'firing', $3, $4, $5, $6, $7) RETURNING alert_id`,
			[e.ruleId, e.severity, e.subjectType, e.subjectId, e.value, e.threshold, e.startedAt]
		);

		return toNum(rows[0].alert_id)!;
	}

	async resolveAlertEvent(alertId: number, resolvedAt: Date): Promise<void> {
		await this.pool.query(
			`UPDATE alert_event SET state = 'resolved', resolved_at = $2 WHERE alert_id = $1 AND state = 'firing'`,
			[alertId, resolvedAt]
		);
	}

	async getFiringAlerts(): Promise<AlertEventRecord[]> {
		const { rows } = await this.pool.query(
			`SELECT e.*, r.title FROM alert_event e JOIN alert_rule r USING (rule_id)
			  WHERE e.state = 'firing' ORDER BY e.started_at DESC`
		);

		return rows.map(mapAlert);
	}

	async close(): Promise<void> {
		await this.pool.end();
	}
}

function mapAlert(r: Record<string, any>): AlertEventRecord {
	return {
		alertId: toNum(r.alert_id)!,
		ruleId: r.rule_id,
		title: r.title,
		severity: r.severity,
		state: r.state,
		subjectType: r.subject_type,
		subjectId: r.subject_id,
		value: toNum(r.value),
		threshold: toNum(r.threshold),
		startedAt: r.started_at,
		resolvedAt: r.resolved_at,
	};
}
