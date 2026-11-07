import type { AlertEvaluator, AlertSubjectState } from '../alerts/evaluator.js';
import type { CommonStore } from '../db/store.js';

/**
 * Overview 공통 (handoff/HANDOFF.md). 화면은 숫자 임계치를 보여 주지 않고, 알림 규칙이 판정한 결과만 보여 준다.
 *  - 상태 배너: 진행 중 알림이 심각이면 crit, 경고면 warn, 없으면 ok
 *  - 문제 항목: 해당 대상에 진행 중 알림이 있거나, 지금 값이 그 규칙의 경고 값 이상이면 문제로 센다
 */

export type OverviewLevel = 'ok' | 'warn' | 'crit';

/** 하단 방송 목록에 보여 줄 행 수. 나머지는 "더 보기"로 각 탭에 보낸다. */
export const OVERVIEW_ROWS = 5;

const RANK: Record<OverviewLevel, number> = { ok: 0, warn: 1, crit: 2 };

export function worst(...levels: Array<OverviewLevel | null | undefined>): OverviewLevel {
	return levels.reduce<OverviewLevel>((a, l) => (l && RANK[l] > RANK[a] ? l : a), 'ok');
}

/** 문제 있는 항목을 위로: crit → warn → ok. 같은 등급은 기존 순서(호출 쪽에서 이름순 등)를 유지한다. */
export function byLevel<T>(level: (item: T) => OverviewLevel | 'idle'): (a: T, b: T) => number {
	const rank = (x: T) => {
		const l = level(x);

		return l === 'idle' ? -1 : RANK[l];
	};

	return (a, b) => rank(b) - rank(a);
}

/** 진행 중(발동) 알림 상태만. */
export function firingStates(evaluator: AlertEvaluator): AlertSubjectState[] {
	return evaluator.states().filter(s => s.status === 'warn' || s.status === 'crit');
}

/** 대상 하나의 진행 중 알림 등급 (없으면 null). ruleId를 주면 그 규칙만 본다. */
export function firingLevel(firing: AlertSubjectState[], subjectType: string, subjectId: string | null, ruleId?: string): OverviewLevel | null {
	const list = firing.filter(s => s.subjectType === subjectType && s.subjectId === subjectId && (!ruleId || s.ruleId === ruleId));

	return list.length ? worst(...list.map(s => s.status as OverviewLevel)) : null;
}

/** 지금 값의 등급. 규칙의 경고·심각 값과 비교한다 (화면에는 값만, 기준 숫자는 내보내지 않는다). */
export function valueLevel(evaluator: AlertEvaluator, ruleId: string, value: number | null | undefined): OverviewLevel {
	const rule = evaluator.rules.find(r => r.ruleId === ruleId);

	if (!rule || value === null || value === undefined) {
		return 'ok';
	}

	if (rule.critAbove !== null && value >= rule.critAbove) {
		return 'crit';
	}

	return rule.warnAbove !== null && value >= rule.warnAbove ? 'warn' : 'ok';
}

/** 상태 배너와 하단 "알림" 카드. */
export async function alertSummary(evaluator: AlertEvaluator, store: CommonStore) {
	const firing = firingStates(evaluator);
	const now = Date.now();
	const history = await store.getAlertHistory({ from: new Date(now - 24 * 3600_000), to: new Date(now) }, 500);
	const order = (s: AlertSubjectState) => (s.status === 'crit' ? 0 : 1);

	return {
		level: worst(...firing.map(s => s.status as OverviewLevel)),
		total: firing.length,
		crit: firing.filter(s => s.status === 'crit').length,
		warn: firing.filter(s => s.status === 'warn').length,
		items: [...firing]
			.sort((a, b) => order(a) - order(b) || (a.firingSince?.getTime() ?? 0) - (b.firingSince?.getTime() ?? 0))
			.slice(0, 3)
			.map(s => ({ ruleId: s.ruleId, title: s.title, subjectId: s.subjectId, level: s.status as OverviewLevel, since: s.firingSince })),
		near: evaluator.states().filter(s => s.status === 'near').length,
		last24h: history.length,
	};
}
