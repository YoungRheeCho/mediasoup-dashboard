import { createLogger } from '../log.js';
import type { AlertEventRecord, AlertRuleRecord } from '../db/store.js';
import type { MetricSample } from './metrics.js';
import type { AlertSink } from './sinks.js';

const logger = createLogger('alert-evaluator');

/** 평가기가 쓰는 저장소 부분. */
export interface AlertStorePort {
	getAlertRules(): Promise<AlertRuleRecord[]>;
	getFiringAlerts(): Promise<AlertEventRecord[]>;
	insertAlertEvent(event: NewAlertEvent): Promise<number>;
	resolveAlertEvent(alertId: number, resolvedAt: Date): Promise<void>;
}

export type NewAlertEvent = {
	ruleId: string;
	severity: 'warn' | 'crit';
	subjectType: string;
	subjectId: string | null;
	value: number;
	threshold: number;
	startedAt: Date;
};

/** 화면의 "지금 발동 중 / 임계값에 근접" 표시용 현재 상태. */
export type AlertSubjectState = {
	ruleId: string;
	title: string;
	metric: string;
	subjectType: string;
	subjectId: string | null;
	value: number;
	warnAbove: number | null;
	critAbove: number | null;
	/** near: 경고 임계값의 NEAR_RATIO 이상 */
	status: 'ok' | 'near' | 'warn' | 'crit';
	firingSince: Date | null;
	updatedAt: Date;
};

export const NEAR_RATIO = 0.8;

type Tracked = {
	rule: AlertRuleRecord;
	subjectType: string;
	subjectId: string | null;
	value: number;
	lastSeenAt: number;
	aboveWarnSince: number | null;
	aboveCritSince: number | null;
	belowWarnSince: number | null;
	belowCritSince: number | null;
	firing: { alertId: number; severity: 'warn' | 'crit'; startedAt: Date } | null;
};

/**
 * 서버 측 알림 평가 (AGENT_TASK 6.3).
 *  - 값이 임계값을 window_seconds 동안 계속 넘으면 발동(firing), 경고 아래로 window_seconds 동안 내려오면 해소(resolved).
 *  - warn에서 crit로 오르거나 내려오면 기존 이벤트를 해소하고 새 등급으로 다시 발동한다 (이력에 등급 변화가 남는다).
 *  - 값이 사라진 대상(방송 종료, worker 종료)은 window 동안 안 보이면 해소한다.
 *  - 값 없음(null)은 평가하지 않는다. mock 값은 metrics.ts에서 이미 빠져 있다.
 */
export class AlertEvaluator {
	readonly #store: AlertStorePort;
	readonly #sinks: AlertSink[];
	readonly #tracked = new Map<string, Tracked>();
	#rules: AlertRuleRecord[] = [];
	#chain: Promise<void> = Promise.resolve();

	constructor(store: AlertStorePort, sinks: AlertSink[] = []) {
		this.#store = store;
		this.#sinks = sinks;
	}

	/** 규칙을 읽고, 재시작 전에 발동 중이던 알림을 이어받는다. */
	async init(now = Date.now()): Promise<void> {
		this.#rules = (await this.#store.getAlertRules()).filter(r => r.enabled);

		for (const e of await this.#store.getFiringAlerts()) {
			const rule = this.#rules.find(r => r.ruleId === e.ruleId);

			if (!rule) {
				continue;
			}

			this.#tracked.set(key(rule.ruleId, e.subjectType, e.subjectId), {
				rule,
				subjectType: e.subjectType,
				subjectId: e.subjectId,
				value: e.value ?? 0,
				lastSeenAt: now,
				aboveWarnSince: now - rule.windowSeconds * 1000,
				aboveCritSince: e.severity === 'crit' ? now - rule.windowSeconds * 1000 : null,
				belowWarnSince: null,
				belowCritSince: null,
				firing: { alertId: e.alertId, severity: e.severity, startedAt: e.startedAt },
			});
		}
	}

	get rules(): readonly AlertRuleRecord[] {
		return this.#rules;
	}

	/**
	 * 지표 묶음을 평가한다. metrics에 포함된 metric 이름의 규칙만 평가한다
	 * (예: edge 신호 나이 규칙은 heartbeat 타이머가 따로 부른다).
	 * 호출은 순서대로 직렬 처리된다.
	 */
	evaluate(samples: MetricSample[], now = Date.now()): Promise<void> {
		this.#chain = this.#chain.then(() => this.#evaluate(samples, now)).catch(error => {
			logger.warn('evaluation failed: %s', (error as Error).message);
		});

		return this.#chain;
	}

	/** 화면용 현재 상태. 발동 중인 것과 근접한 것이 앞에 온다. */
	states(): AlertSubjectState[] {
		const order = { crit: 0, warn: 1, near: 2, ok: 3 };

		return [...this.#tracked.values()]
			.map(t => ({
				ruleId: t.rule.ruleId,
				title: t.rule.title,
				metric: t.rule.metric,
				subjectType: t.subjectType,
				subjectId: t.subjectId,
				value: t.value,
				warnAbove: t.rule.warnAbove,
				critAbove: t.rule.critAbove,
				status: t.firing?.severity ?? (t.rule.warnAbove !== null && t.value >= t.rule.warnAbove * NEAR_RATIO ? 'near' : 'ok'),
				firingSince: t.firing?.startedAt ?? null,
				updatedAt: new Date(t.lastSeenAt),
			}) satisfies AlertSubjectState)
			.sort((a, b) => order[a.status] - order[b.status] || b.value - a.value);
	}

	async #evaluate(samples: MetricSample[], now: number): Promise<void> {
		const metrics = new Set(samples.map(s => s.metric));
		const seen = new Set<string>();

		for (const rule of this.#rules) {
			if (!metrics.has(rule.metric)) {
				continue;
			}

			const hold = rule.windowSeconds * 1000;

			for (const s of samples) {
				if (s.metric !== rule.metric || !Number.isFinite(s.value)) {
					continue;
				}

				const k = key(rule.ruleId, s.subjectType, s.subjectId);
				let t = this.#tracked.get(k);

				if (!t) {
					t = {
						rule,
						subjectType: s.subjectType,
						subjectId: s.subjectId,
						value: s.value,
						lastSeenAt: now,
						aboveWarnSince: null,
						aboveCritSince: null,
						belowWarnSince: null,
						belowCritSince: null,
						firing: null,
					};
					this.#tracked.set(k, t);
				}

				seen.add(k);
				t.value = s.value;
				t.lastSeenAt = now;

				const aboveWarn = rule.warnAbove !== null && s.value > rule.warnAbove;
				const aboveCrit = rule.critAbove !== null && s.value > rule.critAbove;

				t.aboveWarnSince = aboveWarn || aboveCrit ? (t.aboveWarnSince ?? now) : null;
				t.aboveCritSince = aboveCrit ? (t.aboveCritSince ?? now) : null;
				t.belowWarnSince = aboveWarn || aboveCrit ? null : (t.belowWarnSince ?? now);
				t.belowCritSince = aboveCrit ? null : (t.belowCritSince ?? now);

				const desired: 'warn' | 'crit' | null =
					t.aboveCritSince !== null && now - t.aboveCritSince >= hold
						? 'crit'
						: t.aboveWarnSince !== null && now - t.aboveWarnSince >= hold
							? 'warn'
							: null;

				if (t.firing && t.belowWarnSince !== null && now - t.belowWarnSince >= hold) {
					await this.#resolve(t, now);
				} else if (desired && (!t.firing || t.firing.severity !== desired)) {
					// 등급이 내려가는 경우(crit → warn)는 crit 아래로 window 동안 머문 뒤에만
					if (t.firing?.severity === 'crit') {
						if (t.belowCritSince !== null && now - t.belowCritSince >= hold) {
							await this.#resolve(t, now);
							await this.#fire(t, 'warn', now);
						}
					} else if (!t.firing || desired === 'crit') {
						if (t.firing) {
							await this.#resolve(t, now);
						}

						await this.#fire(t, desired, now);
					}
				}
			}
		}

		// 이번 평가에서 다룬 metric인데 값이 사라진 대상
		for (const [k, t] of this.#tracked) {
			if (seen.has(k) || !metrics.has(t.rule.metric)) {
				continue;
			}

			if (now - t.lastSeenAt >= Math.max(t.rule.windowSeconds * 1000, 1)) {
				if (t.firing) {
					await this.#resolve(t, now);
				}

				this.#tracked.delete(k);
			}
		}
	}

	async #fire(t: Tracked, severity: 'warn' | 'crit', now: number): Promise<void> {
		const threshold = (severity === 'crit' ? t.rule.critAbove : t.rule.warnAbove) ?? 0;
		const startedAt = new Date(now);
		const alertId = await this.#store.insertAlertEvent({
			ruleId: t.rule.ruleId,
			severity,
			subjectType: t.subjectType,
			subjectId: t.subjectId,
			value: t.value,
			threshold,
			startedAt,
		});

		t.firing = { alertId, severity, startedAt };
		this.#notify('onFiring', {
			alertId,
			ruleId: t.rule.ruleId,
			title: t.rule.title,
			severity,
			state: 'firing',
			subjectType: t.subjectType,
			subjectId: t.subjectId,
			value: t.value,
			threshold,
			startedAt,
			resolvedAt: null,
		});
	}

	async #resolve(t: Tracked, now: number): Promise<void> {
		const firing = t.firing!;
		const resolvedAt = new Date(now);

		await this.#store.resolveAlertEvent(firing.alertId, resolvedAt);
		t.firing = null;
		this.#notify('onResolved', {
			alertId: firing.alertId,
			ruleId: t.rule.ruleId,
			title: t.rule.title,
			severity: firing.severity,
			state: 'resolved',
			subjectType: t.subjectType,
			subjectId: t.subjectId,
			value: t.value,
			threshold: (firing.severity === 'crit' ? t.rule.critAbove : t.rule.warnAbove) ?? null,
			startedAt: firing.startedAt,
			resolvedAt,
		});
	}

	#notify(method: 'onFiring' | 'onResolved', event: AlertEventRecord): void {
		for (const sink of this.#sinks) {
			try {
				void Promise.resolve(sink[method](event)).catch(error => logger.warn('alert sink failed: %s', (error as Error).message));
			} catch (error) {
				logger.warn('alert sink failed: %s', (error as Error).message);
			}
		}
	}
}

function key(ruleId: string, subjectType: string, subjectId: string | null): string {
	return `${ruleId}|${subjectType}|${subjectId ?? ''}`;
}
