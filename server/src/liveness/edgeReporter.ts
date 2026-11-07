import type { Config } from '../config.js';
import type { CollectorStatus } from '../collector/collector.js';
import type { EdgeBatch } from '../db/rows.js';
import { createLogger } from '../log.js';
import type { LivenessMessage } from './message.js';

const logger = createLogger('liveness');

/**
 * edge 쪽 생존 신호 내용을 만든다. pipe 수신 delta는 신호 사이에 쌓아 두었다가 보낼 때 비운다.
 * push든 pull이든 take()를 한 곳에서만 부르므로 delta가 두 번 세지지 않는다.
 */
export class EdgeLivenessSource {
	#lost = 0;
	#expected = 0;
	#hasPipe = false;
	#viewerCount: number | null = null;
	#lastRttMs: number | null = null;

	constructor(
		private readonly config: Config,
		private readonly status: () => Readonly<CollectorStatus>
	) {}

	addBatch(batch: EdgeBatch): void {
		this.#viewerCount = batch.viewerSamples.length;

		for (const p of batch.pipeSamples) {
			if (p.packetsExpected !== null && p.packetsLost !== null) {
				this.#lost += p.packetsLost;
				this.#expected += p.packetsExpected;
				this.#hasPipe = true;
			}
		}
	}

	setLastRtt(rttMs: number | null): void {
		this.#lastRttMs = rttMs;
	}

	/** 신호 하나를 만들고 쌓인 delta를 비운다. */
	take(now = Date.now()): LivenessMessage {
		const status = this.status();
		const staleMs = now - (status.lastSuccessAt?.getTime() ?? 0);
		const ok = status.ok && staleMs < this.config.collectIntervalMs * 3;
		const message: LivenessMessage = {
			v: 1,
			edgeId: this.config.serverId,
			dashboardUrl: this.config.publicUrl,
			ip: this.config.liveness.pipeIp,
			region: this.config.liveness.region,
			ok,
			okReason: ok ? null : (status.lastError ?? `no successful collection for ${Math.round(staleMs / 1000)}s`),
			viewerCount: this.#viewerCount,
			recvPacketsLost: this.#hasPipe ? this.#lost : null,
			recvPacketsExpected: this.#hasPipe ? this.#expected : null,
			lastRttMs: this.#lastRttMs,
			sentAt: now,
		};

		this.#lost = 0;
		this.#expected = 0;
		this.#hasPipe = false;

		return message;
	}

	/** 보내기에 실패한 신호의 delta를 되돌린다 (다음 신호에 합쳐진다). */
	restore(message: LivenessMessage): void {
		if (message.recvPacketsExpected !== null && message.recvPacketsLost !== null) {
			this.#lost += message.recvPacketsLost;
			this.#expected += message.recvPacketsExpected;
			this.#hasPipe = true;
		}
	}
}

/** push 방식: 주기마다 origin의 /api/liveness 로 POST 한다. */
export class PushLivenessReporter {
	#timer: NodeJS.Timeout | null = null;
	#failures = 0;

	constructor(
		private readonly source: EdgeLivenessSource,
		private readonly originUrl: string,
		private readonly intervalMs: number
	) {}

	start(): void {
		if (!this.#timer) {
			this.#timer = setInterval(() => void this.sendOnce(), this.intervalMs);
			void this.sendOnce();
		}
	}

	stop(): void {
		if (this.#timer) {
			clearInterval(this.#timer);
			this.#timer = null;
		}
	}

	async sendOnce(): Promise<boolean> {
		const message = this.source.take();
		const startedAt = Date.now();

		try {
			const res = await fetch(new URL('/api/liveness', this.originUrl), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(message),
				signal: AbortSignal.timeout(Math.min(5000, this.intervalMs)),
			});

			if (!res.ok) {
				throw new Error(`origin responded ${res.status}`);
			}

			this.source.setLastRtt(Date.now() - startedAt);

			if (this.#failures > 0) {
				logger.info('origin reachable again after %d failed heartbeats', this.#failures);
			}

			this.#failures = 0;

			return true;
		} catch (error) {
			this.source.restore(message);
			this.source.setLastRtt(null);
			this.#failures++;

			if (this.#failures === 1 || this.#failures % 30 === 0) {
				logger.warn('heartbeat to %s failed (%d in a row): %s', this.originUrl, this.#failures, (error as Error).message);
			}

			return false;
		}
	}
}
