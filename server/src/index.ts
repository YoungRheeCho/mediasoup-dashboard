import { registerAlertRoutes } from './api/alertRoutes.js';
import { meta } from './api/common.js';
import { registerEdgeRoutes } from './api/edgeRoutes.js';
import { WorkerTracker } from './api/live.js';
import { registerOriginRoutes } from './api/originRoutes.js';
import { AlertEvaluator } from './alerts/evaluator.js';
import { CentralView } from './central/central.js';
import { registerSysinfoRoutes, SysinfoStore } from './central/sysinfo.js';
import { edgeMetrics, originMetrics } from './alerts/metrics.js';
import { LogSink } from './alerts/sinks.js';
import { loadConfig } from './config.js';
import type { Config } from './config.js';
import type { Batch } from './db/rows.js';
import { Collector } from './collector/collector.js';
import { EdgeNormalizer } from './collector/normalizeEdge.js';
import { OriginNormalizer } from './collector/normalizeOrigin.js';
import { TimescaleEdgeStore } from './db/timescale/edgeStore.js';
import { TimescaleOriginStore } from './db/timescale/originStore.js';
import { BatchDownsampler } from './db/downsample.js';
import { BatchWriter } from './db/writer.js';
import { HttpError, HttpServer } from './http/server.js';
import { staticHandler } from './http/static.js';
import { K8sDiscovery } from './k8s/discovery.js';
import { EdgeLivenessSource, PushLivenessReporter } from './liveness/edgeReporter.js';
import { OriginLivenessMonitor, PullLivenessPoller } from './liveness/originMonitor.js';
import { createLogger } from './log.js';
import { HookSource } from './sources/hookSource.js';
import { SimSource } from './sources/simSource.js';
import type { MediasoupSource } from './sources/types.js';

const logger = createLogger('main');

async function main(): Promise<void> {
	const config = loadConfig();

	logger.info(
		'starting [mode:%s, server:%s, node:%s, source:%s, interval:%dms (db %dms, spread %dms), mock:%s, liveness:%s]',
		config.mode,
		config.serverId,
		config.nodeName ?? '-',
		config.mediasoupSource,
		config.collectIntervalMs,
		config.dbWriteIntervalMs,
		config.hookSpreadMs,
		config.mockEnabled,
		config.liveness.mode
	);

	const source: MediasoupSource =
		config.mediasoupSource === 'sim' ? new SimSource(config) : new HookSource(config.hookSocket, config.hookTimeoutMs);
	const store = config.mode === 'edge' ? new TimescaleEdgeStore(config.databaseUrl) : new TimescaleOriginStore(config.databaseUrl);

	await initStore(store, config);

	const evaluator = new AlertEvaluator(store, [new LogSink()]);

	await evaluator.init();

	const writer = new BatchWriter(store);
	// 수집은 1초, DB 기록·알림 평가는 dbWriteIntervalMs(기본 10초)로 합쳐서 한다 (db/downsample.ts).
	const downsampler = new BatchDownsampler(config.dbWriteIntervalMs);
	const http = new HttpServer();
	let central: CentralView | null = null;
	const stoppers: Array<() => void> = [];
	const flushers: Array<() => Promise<void>> = [];
	const downsampled: Array<(batch: Batch) => void> = [];
	let collector: Collector;

	http.route('GET', '/api/health', () => ({
		body: {
			mode: config.mode,
			serverId: config.serverId,
			source: config.mediasoupSource,
			collector: collector.status,
			dbWritePending: writer.pending,
			dbLastError: writer.lastError,
		},
	}));

	const tracker = new WorkerTracker();
	const apiBase = () => ({ config, collector, writer, evaluator, tracker, nicCapacityBps: config.nicCapacityBps });

	http.route('GET', '/api/meta', () => ({
		body: { meta: meta({ config, collector, writer }), rules: evaluator.rules, publicUrl: config.publicUrl },
	}));

	if (store instanceof TimescaleEdgeStore) {
		const normalizer = new EdgeNormalizer();

		normalizer.adoptOpenSessions(await store.getOpenViewerSessionIds());
		collector = new Collector({ config, source, normalizer });
		registerEdgeRoutes(http, { ...apiBase(), store });
		registerAlertRoutes(http, { ...apiBase(), store });

		const liveness = new EdgeLivenessSource(config, () => collector.status);

		collector.on('batch', batch => {
			if (batch.mode === 'edge') {
				liveness.addBatch(batch); // 1초마다: origin 통합 화면용 실시간 값
			}
		});
		downsampled.push(batch => {
			if (batch.mode === 'edge') {
				void evaluator.evaluate(edgeMetrics(batch), batch.time.getTime());
			}
		});

		if (config.liveness.mode === 'pull') {
			// pull: origin이 가져간다. push 모드에서는 delta를 뺏기지 않도록 이 경로를 열지 않는다.
			http.route('GET', '/api/liveness', () => ({ body: liveness.take() }));
		} else if (config.liveness.originUrl) {
			const reporter = new PushLivenessReporter(liveness, config.liveness.originUrl, config.liveness.intervalMs);

			reporter.start();
			stoppers.push(() => reporter.stop());
		} else {
			logger.warn('MSDASH_ORIGIN_URL not set; heartbeat to origin disabled');
		}
	} else {
		const originStore = store;
		const normalizer = new OriginNormalizer();

		for (const e of config.edgeTargets) {
			await originStore.upsertEdge({ edgeId: e.edgeId, dashboardUrl: e.dashboardUrl, ip: e.ip });
		}

		const monitor = new OriginLivenessMonitor(originStore, evaluator);

		await monitor.init();
		normalizer.adoptOpenSessions(await originStore.getOpenBroadcasterSessions());
		normalizer.adoptLinks(await originStore.getConnectedLinks());
		collector = new Collector({ config, source, normalizer, edgeIdByIp: () => monitor.edgeIdByIp() });
		registerOriginRoutes(http, { ...apiBase(), store: originStore, monitor });
		registerAlertRoutes(http, { ...apiBase(), store: originStore });
		downsampled.push(batch => {
			if (batch.mode === 'origin') {
				void evaluator.evaluate(originMetrics(batch), batch.time.getTime());
			}
		});

		// 통합 3D 화면: edge들의 1초 실시간 값 + origin 수집값 (+ 선택: k8s 노드·Pod 목록)
		const k8s = config.k8s.enabled ? new K8sDiscovery(config.k8s) : null;

		k8s?.start();
		stoppers.push(() => k8s?.stop());
		const sysinfo = new SysinfoStore();

		central = new CentralView({ config, monitor, collector: () => collector, k8s, sysinfo });
		http.route('GET', '/api/central/snapshot', () => ({ body: central!.snapshot() }));
		// 그래프 이력 30분(1초 간격). ?viewer=<id> 면 그 시청자 이력도
		http.route('GET', '/api/central/history', req => ({ body: central!.history(Date.now(), req.query.get('viewer')) }));
		// Metric-Collector → origin, 1초마다 노드·컨테이너 자원 값 (docs/api.md)
		registerSysinfoRoutes(http, sysinfo);
		central.start();
		stoppers.push(() => central?.stop());

		http.route('POST', '/api/liveness', async req => {
			try {
				await monitor.receive(req.body);
			} catch (error) {
				throw new HttpError(400, (error as Error).message);
			}

			return { body: { ok: true, serverTime: Date.now() } };
		});

		monitor.start();
		stoppers.push(() => monitor.stop());
		flushers.push(() => monitor.flush());

		if (config.liveness.mode === 'pull') {
			const poller = new PullLivenessPoller(monitor, config.liveness.intervalMs);

			poller.start();
			stoppers.push(() => poller.stop());
		}
	}

	collector.on('batch', () => {
		if (collector.raw.current) {
			tracker.observe(collector.raw.current);
		}
	});
	const persist = (batch: Batch) => {
		writer.enqueue(batch);
		downsampled.forEach(fn => fn(batch));
	};
	let lastFailureSavedAt = 0;

	collector.on('batch', batch => {
		const merged = downsampler.add(batch);

		if (merged) {
			persist(merged);
		}
	});
	collector.on('failure', row => {
		// 1초 주기라 훅이 죽어 있으면 매초 실패한다. 실패 기록도 DB 기록 주기마다 한 번만 남긴다.
		if (row.time.getTime() - lastFailureSavedAt >= config.dbWriteIntervalMs) {
			lastFailureSavedAt = row.time.getTime();
			writer.enqueueFailure(row);
		}
	});
	collector.start();

	const serveStatic = staticHandler(config.webDir, { rootPage: config.mode === 'origin' ? 'central.html' : null });

	http.fallback((req, res) => central?.handleStream(req, res) || serveStatic(req, res));
	await http.listen(config.http.host, config.http.port);

	const shutdown = async (signal: string) => {
		logger.info('%s received, shutting down', signal);
		collector.stop();
		stoppers.forEach(stop => stop());
		source.close();
		await http.close().catch(() => {});
		await Promise.all(flushers.map(flush => flush().catch(() => {})));

		const rest = downsampler.flush();

		if (rest) {
			writer.enqueue(rest);
		}

		await writer.flush().catch(() => {});
		await store.close().catch(() => {});
		process.exit(0);
	};

	process.on('SIGINT', () => void shutdown('SIGINT'));
	process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

/** DB가 늦게 뜰 수 있으므로(사이드카 동시 시작) 연결될 때까지 재시도한다. */
async function initStore(store: TimescaleEdgeStore | TimescaleOriginStore, config: Config): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		try {
			await store.init(config.dbSchemaDir, config.dbAutoInit);
			await store.applyRetention(config.retention);

			return;
		} catch (error) {
			const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));

			logger.warn('database not ready (attempt %d): %s; retrying in %dms', attempt, (error as Error).message, delay);
			await new Promise(resolve => setTimeout(resolve, delay));
		}
	}
}

main().catch(error => {
	logger.error('fatal: %s', (error as Error).stack ?? error);
	process.exit(1);
});
