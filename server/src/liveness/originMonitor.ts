import type { AlertEvaluator } from '../alerts/evaluator.js';
import type { MetricSample } from '../alerts/metrics.js';
import type { OriginStore } from '../db/store.js';
import { createLogger } from '../log.js';
import { parseLivenessMessage } from './message.js';
import type { EdgeLive, LivenessMessage } from './message.js';

const logger = createLogger('liveness');

/** origin에서 본 edge 상태 (AGENT_TASK 7-6). */
export type EdgeLiveState = 'connected' | 'warning' | 'lost';

export type EdgeLiveStatus = {
	edgeId: string;
	dashboardUrl: string;
	ip: string | null;
	region: string | null;
	state: EdgeLiveState;
	/** 화면 문구: 왜 이 상태인지 */
	reason: string | null;
	lastSeenAt: Date | null;
	ageSeconds: number | null;
	viewerCount: number | null;
	recvLossRatio: number | null;
};

type Known = {
	edgeId: string;
	dashboardUrl: string;
	ip: string | null;
	region: string | null;
	lastSeenAt: number | null;
	last: LivenessMessage | null;
	/** DB에 아직 쓰지 않은 pipe 수신 delta (신호는 1초마다 오지만 DB에는 HEARTBEAT_SAVE_MS마다 쓴다) */
	unsaved: { lost: number; expected: number; hasPipe: boolean };
	lastSavedAt: number | null;
	lastSavedOk: boolean | null;
	/** 상태 판단용 최근 pipe 수신 [expected, lost] (신호 LOSS_WINDOW개). 1초 신호 하나만 보면 패킷이 적어 값이 튄다. */
	recent: Array<[number, number]>;
};

/** 상태 판단에 쓰는 pipe 수신 loss 구간: 최근 신호 10개 (1초 신호면 10초) */
const LOSS_WINDOW = 10;

/** edge_heartbeat 기록 간격. 신호는 1초마다 오지만 이력은 10초 간격이면 충분하다 (상태가 바뀌면 바로 쓴다). */
const HEARTBEAT_SAVE_MS = 10_000;

/** 신호 끊김 기준 기본값. alert_rule 'edge_signal_age'의 warn 값이 있으면 그것을 쓴다. */
const DEFAULT_LOST_AFTER_S = 30;
/** edge가 보고한 pipe 수신 loss가 이 이상이면 "연결됨 · 품질 경고". alert_rule 'pipe_send_loss' warn 값 우선. */
const DEFAULT_RECV_LOSS_WARN = 0.02;

/**
 * origin 쪽 생존 감시 (AGENT_TASK 6.4). 죽은 서버는 스스로 알릴 수 없으므로 마지막 신호 시각으로 판단한다.
 * 신호를 받는 방법(push 수신 / pull 조회)과 판단은 분리되어 있다: 어느 쪽이든 receive()로 들어온다.
 */
export class OriginLivenessMonitor {
	readonly #known = new Map<string, Known>();
	readonly #startedAt = Date.now();
	#timer: NodeJS.Timeout | null = null;
	#persist: Promise<void> = Promise.resolve();

	constructor(
		private readonly store: OriginStore,
		private readonly evaluator: AlertEvaluator
	) {}

	/** DB에 있는 edge와 설정의 edge를 미리 알고 시작한다 (한 번도 신호가 없으면 시작 시각 기준으로 끊김 판단). */
	async init(): Promise<void> {
		for (const e of await this.store.getEdges()) {
			this.#known.set(e.edgeId, {
				edgeId: e.edgeId,
				dashboardUrl: e.dashboardUrl,
				ip: e.ip,
				region: e.region,
				lastSeenAt: e.lastHeartbeatAt?.getTime() ?? null,
				last: null,
				unsaved: { lost: 0, expected: 0, hasPipe: false },
				lastSavedAt: null,
				lastSavedOk: null,
				recent: [],
			});
		}
	}

	/** PipeTransport 원격 IP → edge id (M7). 정규화기가 주기마다 읽는다. */
	edgeIdByIp(): Map<string, string> {
		const map = new Map<string, string>();

		for (const e of this.#known.values()) {
			if (e.ip) {
				map.set(e.ip, e.edgeId);
			}
		}

		return map;
	}

	knownEdges(): Array<{ edgeId: string; dashboardUrl: string }> {
		return [...this.#known.values()].map(e => ({ edgeId: e.edgeId, dashboardUrl: e.dashboardUrl }));
	}

	/**
	 * 신호 하나 처리. 시각은 origin이 찍는다.
	 * 판단에 쓰는 메모리 상태는 바로 갱신하고, DB 기록은 순서대로 뒤에서 한다.
	 * (push 응답이 DB 쓰기를 기다리지 않아야 edge가 재는 RTT가 네트워크 시간에 가깝다.)
	 */
	async receive(input: unknown, opts: { rttMs?: number | null; now?: number } = {}): Promise<void> {
		const message = parseLivenessMessage(input);
		const now = opts.now ?? Date.now();
		const prev = this.#known.get(message.edgeId);
		const changed = !prev || prev.dashboardUrl !== message.dashboardUrl || prev.ip !== message.ip || prev.region !== message.region;

		if (!prev) {
			logger.info('new edge %s (%s, ip %s)', message.edgeId, message.dashboardUrl, message.ip ?? '-');
		}

		const unsaved = prev?.unsaved ?? { lost: 0, expected: 0, hasPipe: false };
		const recent = prev?.recent ?? [];

		if (message.recvPacketsExpected !== null && message.recvPacketsLost !== null) {
			unsaved.lost += message.recvPacketsLost;
			unsaved.expected += message.recvPacketsExpected;
			unsaved.hasPipe = true;
			recent.push([message.recvPacketsExpected, message.recvPacketsLost]);

			while (recent.length > LOSS_WINDOW) {
				recent.shift();
			}
		}

		const known: Known = {
			edgeId: message.edgeId,
			dashboardUrl: message.dashboardUrl,
			ip: message.ip,
			region: message.region,
			lastSeenAt: now,
			last: message,
			unsaved,
			lastSavedAt: prev?.lastSavedAt ?? null,
			lastSavedOk: prev?.lastSavedOk ?? null,
			recent,
		};

		this.#known.set(message.edgeId, known);

		// 1초 신호를 모두 DB에 쓰지 않는다: 처음, 10초마다, 상태(ok)가 바뀔 때, edge 정보가 바뀔 때만 쓴다.
		const due =
			changed ||
			known.lastSavedAt === null ||
			now - known.lastSavedAt >= HEARTBEAT_SAVE_MS ||
			known.lastSavedOk !== message.ok;

		if (!due) {
			return;
		}

		const row = {
			time: new Date(now),
			edgeId: message.edgeId,
			ok: message.ok,
			rttMs: opts.rttMs ?? message.lastRttMs,
			viewerCount: message.viewerCount,
			recvPacketsLost: unsaved.hasPipe ? unsaved.lost : null,
			recvPacketsExpected: unsaved.hasPipe ? unsaved.expected : null,
		};

		known.unsaved = { lost: 0, expected: 0, hasPipe: false };
		known.lastSavedAt = now;
		known.lastSavedOk = message.ok;

		this.#persist = this.#persist
			.then(async () => {
				if (changed) {
					await this.store.upsertEdge({ edgeId: message.edgeId, dashboardUrl: message.dashboardUrl, region: message.region, ip: message.ip });
				}

				await this.store.saveHeartbeat(row);
			})
			.catch(error => logger.warn('saving heartbeat of %s failed: %s', message.edgeId, (error as Error).message));
	}

	/** 밀린 heartbeat DB 기록이 끝날 때까지 기다린다 (테스트·종료용). */
	flush(): Promise<void> {
		return this.#persist;
	}

	statuses(now = Date.now()): EdgeLiveStatus[] {
		const lostAfterS = this.#ruleWarn('edge_signal_age') ?? DEFAULT_LOST_AFTER_S;
		const lossWarn = this.#ruleWarn('pipe_send_loss') ?? DEFAULT_RECV_LOSS_WARN;

		return [...this.#known.values()]
			.map(e => {
				const ageSeconds = e.lastSeenAt === null ? null : (now - e.lastSeenAt) / 1000;
				const expected = e.recent.reduce((a, [x]) => a + x, 0);
				const loss = expected > 0 ? e.recent.reduce((a, [, l]) => a + l, 0) / expected : null;
				let state: EdgeLiveState = 'connected';
				let reason: string | null = null;

				if (ageSeconds === null || ageSeconds >= lostAfterS) {
					state = 'lost';
					reason = ageSeconds === null ? '신호를 받은 적 없음' : `${Math.round(ageSeconds)}초 동안 신호 없음`;
				} else if (e.last && !e.last.ok) {
					state = 'warning';
					reason = `edge 자체 점검 실패: ${e.last.okReason ?? '알 수 없음'}`;
				} else if (loss !== null && loss >= lossWarn) {
					state = 'warning';
					reason = `pipe 수신 loss ${(loss * 100).toFixed(1)}%`;
				}

				return {
					edgeId: e.edgeId,
					dashboardUrl: e.dashboardUrl,
					ip: e.ip,
					region: e.region,
					state,
					reason,
					lastSeenAt: e.lastSeenAt === null ? null : new Date(e.lastSeenAt),
					ageSeconds: ageSeconds === null ? null : Math.round(ageSeconds),
					viewerCount: e.last?.viewerCount ?? null,
					recvLossRatio: loss,
				};
			})
			.sort((a, b) => a.edgeId.localeCompare(b.edgeId));
	}

	/** 통합 화면용: edge별 마지막 실시간 값 (live를 보내지 않는 옛 edge는 null). */
	liveOf(edgeId: string): EdgeLive | null {
		return this.#known.get(edgeId)?.last?.live ?? null;
	}

	/** 주기적으로 신호 나이를 알림 평가기에 넘긴다 (edge_signal_age 규칙). */
	start(intervalMs = 5000): void {
		if (this.#timer) {
			return;
		}

		this.#timer = setInterval(() => void this.evaluateAges(), intervalMs);
	}

	stop(): void {
		if (this.#timer) {
			clearInterval(this.#timer);
			this.#timer = null;
		}
	}

	evaluateAges(now = Date.now()): Promise<void> {
		const samples: MetricSample[] = [...this.#known.values()].map(e => ({
			metric: 'edge.heartbeat_age_s',
			subjectType: 'edge',
			subjectId: e.edgeId,
			value: (now - (e.lastSeenAt ?? this.#startedAt)) / 1000,
		}));

		return this.evaluator.evaluate(samples, now);
	}

	#ruleWarn(ruleId: string): number | null {
		return this.evaluator.rules.find(r => r.ruleId === ruleId)?.warnAbove ?? null;
	}
}

/**
 * pull 방식 (교체용): origin이 알려진 edge의 /api/liveness 를 주기적으로 GET 한다.
 * 기본은 push다. MSDASH_LIVENESS_MODE=pull 로 바꾼다.
 */
export class PullLivenessPoller {
	#timer: NodeJS.Timeout | null = null;

	constructor(
		private readonly monitor: OriginLivenessMonitor,
		private readonly intervalMs: number
	) {}

	start(): void {
		if (!this.#timer) {
			this.#timer = setInterval(() => void this.pollOnce(), this.intervalMs);
			void this.pollOnce();
		}
	}

	stop(): void {
		if (this.#timer) {
			clearInterval(this.#timer);
			this.#timer = null;
		}
	}

	async pollOnce(): Promise<void> {
		await Promise.all(
			this.monitor.knownEdges().map(async edge => {
				if (!edge.dashboardUrl) {
					return;
				}

				const startedAt = Date.now();

				try {
					const res = await fetch(new URL('/api/liveness', edge.dashboardUrl), {
						signal: AbortSignal.timeout(Math.min(5000, this.intervalMs)),
					});

					if (!res.ok) {
						throw new Error(`edge responded ${res.status}`);
					}

					await this.monitor.receive(await res.json(), { rttMs: Date.now() - startedAt });
				} catch (error) {
					logger.debug('pull %s failed: %s', edge.edgeId, (error as Error).message);
				}
			})
		);
	}
}
