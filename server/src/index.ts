import { registerAlertRoutes } from './api/alertRoutes.js';
import { meta } from './api/common.js';
import { registerEdgeRoutes } from './api/edgeRoutes.js';
import { WorkerTracker } from './api/live.js';
import { registerOriginRoutes } from './api/originRoutes.js';
import { AlertEvaluator } from './alerts/evaluator.js';
import { edgeMetrics, originMetrics } from './alerts/metrics.js';
import { LogSink } from './alerts/sinks.js';
import { loadConfig } from './config.js';
import type { Config } from './config.js';
import { Collector } from './collector/collector.js';
import { EdgeNormalizer } from './collector/normalizeEdge.js';
import { OriginNormalizer } from './collector/normalizeOrigin.js';
import { TimescaleEdgeStore } from './db/timescale/edgeStore.js';
import { TimescaleOriginStore } from './db/timescale/originStore.js';
import { BatchWriter } from './db/writer.js';
import { HttpError, HttpServer } from './http/server.js';
import { staticHandler } from './http/static.js';
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
		'starting [mode:%s, server:%s, source:%s, interval:%dms, mock:%s, liveness:%s]',
		config.mode,
		config.serverId,
		config.mediasoupSource,
		config.collectIntervalMs,
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
	const http = new HttpServer();
	const stoppers: Array<() => void> = [];
	const flushers: Array<() => Promise<void>> = [];
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
				liveness.addBatch(batch);
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
		collector.on('batch', batch => {
			if (batch.mode === 'origin') {
				void evaluator.evaluate(originMetrics(batch), batch.time.getTime());
			}
		});

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
	collector.on('batch', batch => writer.enqueue(batch));
	collector.on('failure', row => writer.enqueueFailure(row));
	collector.start();
	http.fallback(staticHandler(config.webDir));
	await http.listen(config.http.host, config.http.port);

	const shutdown = async (signal: string) => {
		logger.info('%s received, shutting down', signal);
		collector.stop();
		stoppers.forEach(stop => stop());
		source.close();
		await http.close().catch(() => {});
		await Promise.all(flushers.map(flush => flush().catch(() => {})));
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
