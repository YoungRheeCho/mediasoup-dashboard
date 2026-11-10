import { EventEmitter } from 'node:events';

import type { Config } from '../config.js';
import type { RawSnapshot, RawTransportDetail } from '../hookProtocol.js';
import type { Batch, CollectorSampleRow } from '../db/rows.js';
import { createLogger } from '../log.js';
import type { MediasoupSource } from '../sources/types.js';
import { HostCpuSampler } from './hostCpu.js';
import type { EdgeNormalizer } from './normalizeEdge.js';
import type { OriginNormalizer } from './normalizeOrigin.js';

const logger = createLogger('collector');

export type CollectorStatus = {
	ok: boolean;
	lastSuccessAt: Date | null;
	lastAttemptAt: Date | null;
	lastError: string | null;
	consecutiveFailures: number;
	skippedCycles: number;
	lastDurationMs: number | null;
	source: MediasoupSource['kind'];
};

export type CollectorEvents = {
	/** 정규화가 끝난 묶음. DB 기록, 알림 평가, 화면 캐시가 같은 묶음을 읽는다. */
	batch: [Batch];
	/** 훅 응답이 실패한 주기. 수집기 상태 행만 남긴다. */
	failure: [CollectorSampleRow];
};

/**
 * 수집 루프 (AGENT_TASK 4.3).
 *  - 주기마다 전체 통계를 한 번만 가져와 메모리에 캐시한다. 화면·알림·DB가 이 캐시를 같이 읽는다.
 *  - 이전 수집이 끝나지 않았으면 이번 주기를 건너뛰고 경고한다.
 *  - 개별 viewer 상세(2초)는 요청이 있을 때만 그 transport 하나를 호출하고, 1초 동안 결과를 재사용한다.
 */
export class Collector extends EventEmitter<CollectorEvents> {
	readonly #config: Config;
	readonly #source: MediasoupSource;
	readonly #normalizer: EdgeNormalizer | OriginNormalizer;
	readonly #edgeIdByIp: () => ReadonlyMap<string, string>;
	readonly #hostCpu = new HostCpuSampler();
	readonly #detailCache = new Map<string, { at: number; promise: Promise<RawTransportDetail> }>();
	#timer: NodeJS.Timeout | null = null;
	#running = false;
	#skippedSinceLast = false;
	#latest: Batch | null = null;
	#raw: { current: RawSnapshot | null; previous: RawSnapshot | null } = { current: null, previous: null };
	readonly #status: CollectorStatus;

	constructor(opts: {
		config: Config;
		source: MediasoupSource;
		normalizer: EdgeNormalizer | OriginNormalizer;
		edgeIdByIp?: () => ReadonlyMap<string, string>;
	}) {
		super();
		this.#config = opts.config;
		this.#source = opts.source;
		this.#normalizer = opts.normalizer;
		this.#edgeIdByIp = opts.edgeIdByIp ?? (() => new Map());
		this.#status = {
			ok: false,
			lastSuccessAt: null,
			lastAttemptAt: null,
			lastError: null,
			consecutiveFailures: 0,
			skippedCycles: 0,
			lastDurationMs: null,
			source: opts.source.kind,
		};
	}

	start(): void {
		if (this.#timer) {
			return;
		}

		void this.tick();
		this.#timer = setInterval(() => void this.tick(), this.#config.collectIntervalMs);
	}

	stop(): void {
		if (this.#timer) {
			clearInterval(this.#timer);
			this.#timer = null;
		}
	}

	/** 최근 정규화 묶음 (없으면 null). */
	get latest(): Batch | null {
		return this.#latest;
	}

	get status(): Readonly<CollectorStatus> {
		return this.#status;
	}

	/**
	 * 최근 원시 스냅숏 두 개. 화면의 "현재 값"(스트림별 통계, router 배치, NIC 송신량)은
	 * 이것과 그 차이로 만든다. 화면 요청이 getStats()를 부르지 않게 하려는 것이다 (AGENT_TASK 4.3).
	 */
	get raw(): Readonly<{ current: RawSnapshot | null; previous: RawSnapshot | null }> {
		return this.#raw;
	}

	/** 한 주기 수집. 테스트에서 직접 호출할 수 있게 공개한다. */
	async tick(): Promise<void> {
		if (this.#running) {
			this.#status.skippedCycles++;
			this.#skippedSinceLast = true;
			logger.warn('previous collection still running; skipping this cycle (%d skipped so far)', this.#status.skippedCycles);

			return;
		}

		this.#running = true;

		const startedAt = Date.now();

		this.#status.lastAttemptAt = new Date(startedAt);

		try {
			const raw = await this.#source.snapshot({ spreadMs: this.#config.hookSpreadMs });
			const durationMs = Date.now() - startedAt;
			const ctx = {
				collectDurationMs: durationMs,
				skipped: this.#skippedSinceLast,
				hostCpuPct: this.#hostCpu.sample(),
				mockEnabled: this.#config.mockEnabled,
				intervalMs: this.#config.collectIntervalMs,
				edgeIdByIp: this.#edgeIdByIp(),
			};
			const batch = this.#normalizer.normalize(raw, ctx);

			if (raw.errorCount > 0) {
				logger.warn('hook reported %d stats errors (first: %s)', raw.errorCount, raw.errors[0]);
			}

			if (durationMs > this.#config.collectIntervalMs) {
				logger.warn('collection took %dms, longer than interval %dms', durationMs, this.#config.collectIntervalMs);
			}

			this.#skippedSinceLast = false;
			this.#latest = batch;
			this.#raw = { current: raw, previous: this.#raw.current };
			Object.assign(this.#status, {
				ok: true,
				lastSuccessAt: new Date(),
				lastError: null,
				consecutiveFailures: 0,
				lastDurationMs: durationMs,
			});

			this.emit('batch', batch);
		} catch (error) {
			const message = (error as Error).message ?? String(error);

			this.#status.ok = false;
			this.#status.lastError = message;
			this.#status.consecutiveFailures++;

			// 처음 실패와 이후 10번에 한 번만 로그를 남긴다.
			if (this.#status.consecutiveFailures === 1 || this.#status.consecutiveFailures % 10 === 0) {
				logger.warn('collection failed (%d in a row): %s', this.#status.consecutiveFailures, message);
			}

			this.emit('failure', {
				time: new Date(),
				hookOk: false,
				collectDurationMs: Date.now() - startedAt,
				collectSkipped: this.#skippedSinceLast,
				eventLoopLagMs: null,
				nodeRssBytes: null,
				hostCpuPct: this.#hostCpu.sample(),
			});
		} finally {
			this.#running = false;
		}
	}

	/** 개별 viewer/broadcaster 상세(2초 갱신)용. 같은 transport 요청은 1초 동안 재사용한다. */
	transportDetail(transportId: string): Promise<RawTransportDetail> {
		const now = Date.now();

		for (const [id, entry] of this.#detailCache) {
			if (now - entry.at > 1000) {
				this.#detailCache.delete(id);
			}
		}

		const cached = this.#detailCache.get(transportId);

		if (cached) {
			return cached.promise;
		}

		const promise = this.#source.transportDetail(transportId);

		this.#detailCache.set(transportId, { at: now, promise });
		promise.catch(() => this.#detailCache.delete(transportId));

		return promise;
	}
}
