import { createLogger } from '../log.js';
import type { AlertEventRecord } from '../db/store.js';

/**
 * 알림 이벤트를 받는 곳. 외부 알림(Slack, 웹훅 등)은 이번 범위가 아니지만 (AGENT_TASK 6.3)
 * 이 인터페이스를 구현해 AlertEvaluator에 넘기면 저장 직후에 호출된다.
 * sink의 실패는 평가와 저장에 영향을 주지 않는다.
 */
export interface AlertSink {
	onFiring(event: AlertEventRecord): void | Promise<void>;
	onResolved(event: AlertEventRecord): void | Promise<void>;
}

const logger = createLogger('alert');

export class LogSink implements AlertSink {
	onFiring(e: AlertEventRecord): void {
		logger.warn('FIRING %s [%s] %s=%s value=%s threshold=%s', e.ruleId, e.severity, e.subjectType, e.subjectId ?? '-', fmt(e.value), fmt(e.threshold));
	}

	onResolved(e: AlertEventRecord): void {
		logger.info('RESOLVED %s [%s] %s=%s', e.ruleId, e.severity, e.subjectType, e.subjectId ?? '-');
	}
}

function fmt(v: number | null): string {
	return v === null ? '-' : Number.isInteger(v) ? String(v) : v.toFixed(4);
}
