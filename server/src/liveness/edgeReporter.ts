import type { Config } from '../config.js';
import type { CollectorStatus } from '../collector/collector.js';
import type { EdgeBatch } from '../db/rows.js';
import { createLogger } from '../log.js';
import type { EdgeLive, EdgeLiveViewer, LivenessMessage } from './message.js';

const logger = createLogger('liveness');

/**
 * freeze 판단을 이만큼 유지한다. 브라우저 freezeCount는 멈춘 영상이 다시 그려질 때(끝날 때) 늘고,
 * 보고는 1초 주기라 판단이 한 박자 늦다. 짧게 끊겼다 이어지는 깜빡임을 막는 여유이기도 하다.
 */
const FREEZE_HOLD_MS = 2000;

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
	/** 통합 화면용: viewer 세션 정보와 최근 값 (세션 종료 시 지운다) */
	readonly #sessions = new Map<string, { roomId: string; name: string | null; nameMock: boolean; connectedAt: number | null }>();
	readonly #recent = new Map<string, { window: Array<[number, number]>; freezeCount: number | null; freezeUntil: number; row: EdgeBatch['viewerSamples'][number] }>();
	#live: EdgeLive | null = null;

	constructor(
		private readonly config: Config,
		private readonly status: () => Readonly<CollectorStatus>
	) {}

	addBatch(batch: EdgeBatch): void {
		this.#viewerCount = batch.viewerSamples.length;

		// 화면용 값 계산이 실패해도 생존 신호(요약 숫자)는 계속 보낸다.
		try {
			this.#updateLive(batch);
		} catch (error) {
			logger.warn('building live payload failed: %s', (error as Error).message);
		}

		for (const p of batch.pipeSamples) {
			if (p.packetsExpected !== null && p.packetsLost !== null) {
				this.#lost += p.packetsLost;
				this.#expected += p.packetsExpected;
				this.#hasPipe = true;
			}
		}
	}

	/** 최근 묶음 기준 통합 화면용 값. 수집 전이면 null. */
	get live(): EdgeLive | null {
		return this.#live;
	}

	#updateLive(batch: EdgeBatch): void {
		const LOSS_WINDOW = 5; // 최근 5번(=5초) delta로 loss 비율을 낸다. 1초 delta만 쓰면 패킷이 적어 값이 튄다.

		for (const s of batch.viewerSessionStarts ?? []) {
			this.#sessions.set(s.viewerId, {
				roomId: s.roomId,
				name: s.displayName,
				nameMock: s.identitySource === 'mock',
				connectedAt: s.connectedAt.getTime(),
			});
		}

		for (const e of batch.viewerSessionEnds ?? []) {
			this.#sessions.delete(e.viewerId);
			this.#recent.delete(e.viewerId);
		}

		const seen = new Set<string>();

		for (const row of batch.viewerSamples) {
			seen.add(row.viewerId);

			const r = this.#recent.get(row.viewerId) ?? { window: [], freezeCount: null, freezeUntil: 0, row };

			r.row = row;

			if (row.packetsExpected !== null && row.packetsLost !== null) {
				r.window.push([row.packetsExpected, row.packetsLost]);

				if (r.window.length > LOSS_WINDOW) {
					r.window.shift();
				}
			}

			if (row.clientFreezeCount !== null) {
				r.freezeCount = (r.freezeCount ?? 0) + row.clientFreezeCount;
			}

			// 실제 브라우저 보고만 본다 (mock 값으로 화면에 freeze를 띄우지 않는다).
			// 진행 중인 freeze는 fps가 0으로 떨어지는 것으로, 막 끝난 freeze는 횟수 증가로 잡는다.
			if (row.clientReported && ((row.clientFreezeCount ?? 0) > 0 || (row.clientFreezeMs ?? 0) > 0 || (row.clientFps !== null && row.clientFps < 1))) {
				r.freezeUntil = row.time.getTime() + FREEZE_HOLD_MS;
			}

			this.#recent.set(row.viewerId, r);
		}

		// 이번 묶음에 없는 viewer는 화면에서 뺀다 (세션 종료가 늦게 오는 경우 대비)
		for (const id of this.#recent.keys()) {
			if (!seen.has(id)) {
				this.#recent.delete(id);
			}
		}

		const viewers: EdgeLiveViewer[] = [];

		for (const [id, r] of this.#recent) {
			const s = this.#sessions.get(id);
			const expected = r.window.reduce((a, [e]) => a + e, 0);
			const lost = r.window.reduce((a, [, l]) => a + l, 0);

			viewers.push({
				id,
				roomId: s?.roomId ?? r.row.roomId,
				name: s?.name ?? null,
				nameMock: s?.nameMock ?? false,
				connectedAt: s?.connectedAt ?? null,
				lossRatio: expected > 0 ? Math.min(1, Math.max(0, lost / expected)) : null,
				rttMs: r.row.rttMs,
				bitrateBps: r.row.bitrateBps,
				spatialLayer: r.row.spatialLayer,
				transportState: r.row.transportState,
				clientReported: r.row.clientReported,
				freezeCount: r.freezeCount,
				fps: r.row.clientFps,
				freezing: r.row.clientReported && batch.time.getTime() < r.freezeUntil,
			});
		}

		const workers = batch.workers ?? [];
		const cpus = workers.map(w => w.cpuPct).filter((v): v is number => v !== null);
		const status = this.status();

		this.#live = {
			nodeName: this.config.nodeName,
			hostCpuPct: batch.collector?.hostCpuPct ?? null,
			cpuPct: cpus.length ? cpus.reduce((a, b) => a + b, 0) : null,
			workerCount: workers.length,
			collectMs: batch.collector?.collectDurationMs ?? null,
			skippedCycles: status.skippedCycles,
			eventLoopLagMs: batch.collector?.eventLoopLagMs ?? null,
			viewers,
		};
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
			live: this.#live,
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
	#inFlight = false;

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
		// 1초 주기라 직전 전송이 아직 안 끝났을 수 있다. 겹쳐 보내지 않고 이번 차례를 건너뛴다 (delta는 다음 신호에 합쳐진다).
		if (this.#inFlight) {
			return false;
		}

		this.#inFlight = true;

		try {
			return await this.#send();
		} finally {
			this.#inFlight = false;
		}
	}

	async #send(): Promise<boolean> {
		const message = this.source.take();
		const startedAt = Date.now();

		try {
			const res = await fetch(new URL('/api/liveness', this.originUrl), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(message),
				signal: AbortSignal.timeout(Math.max(3000, Math.min(5000, this.intervalMs * 3))),
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
