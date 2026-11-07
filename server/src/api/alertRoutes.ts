import type { AlertEvaluator } from '../alerts/evaluator.js';
import type { CommonStore } from '../db/store.js';
import type { HttpServer } from '../http/server.js';
import type { ApiContext } from './common.js';
import { respond } from './common.js';

/**
 * Alerts 화면 (edge·origin 공통). 지금 발동 중 / 곧 울릴 수 있는 항목 / 24시간 이력 / 규칙.
 * 규칙은 읽기 전용이다 (UI에서 수정하지 않음). 확인(acknowledge) 기능은 만들지 않는다 (design/README.md).
 */
export function registerAlertRoutes(http: HttpServer, ctx: ApiContext & { store: CommonStore; evaluator: AlertEvaluator }): void {
	http.route('GET', '/api/alerts', async () => {
		const now = Date.now();
		const range = { from: new Date(now - 24 * 3600_000), to: new Date(now) };

		return respond(ctx, {
			firing: async () => {
				const states = ctx.evaluator.states();
				const db = await ctx.store.getFiringAlerts();

				// DB가 기준(재시작 후에도 남는다). 평가기의 현재 값을 붙인다.
				return db.map(e => {
					const s = states.find(x => x.ruleId === e.ruleId && x.subjectId === e.subjectId && x.subjectType === e.subjectType);

					return { ...e, currentValue: s?.value ?? null, warnAbove: s?.warnAbove ?? null, critAbove: s?.critAbove ?? null };
				});
			},
			near: () =>
				ctx.evaluator
					.states()
					.filter(s => s.status === 'near')
					.map(s => ({
						ruleId: s.ruleId,
						title: s.title,
						subjectType: s.subjectType,
						subjectId: s.subjectId,
						value: s.value,
						warnAbove: s.warnAbove,
						/** 막대 길이: 경고 임계값 대비 현재 값 */
						ratioToWarn: s.warnAbove ? s.value / s.warnAbove : null,
					})),
			history: async () => {
				const events = await ctx.store.getAlertHistory(range, 500);
				const hourly = Array.from({ length: 24 }, (_, i) => ({ t: new Date(now - (24 - i) * 3600_000), count: 0 }));

				for (const e of events) {
					const idx = Math.floor((e.startedAt.getTime() - (now - 24 * 3600_000)) / 3600_000);

					if (idx >= 0 && idx < 24) {
						hourly[idx]!.count++;
					}
				}

				return { total: events.length, hourly, events: events.slice(0, 50) };
			},
			rules: async () => ({
				rules: await ctx.store.getAlertRules(),
				note: '규칙은 이 서버 기준으로 평가됩니다. 외부 알림 채널은 연결되어 있지 않습니다.',
			}),
		});
	});
}
