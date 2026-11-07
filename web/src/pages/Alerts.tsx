import { Link } from 'react-router-dom';

import { Bar, CountBars } from '../components/Charts';
import { useMeta, PageHeader, StaleScope } from '../components/Layout';
import { Empty, Panel } from '../components/Panel';
import { Status } from '../components/Status';
import { ago, clock, since } from '../lib/format';
import { usePage } from '../lib/usePage';

/** 알림 값 표시: loss·비율 규칙은 %, 나머지는 숫자 */
function fmt(metric: string, v: number | null): string {
	if (v === null || v === undefined) {
		return '—';
	}

	if (metric.includes('loss') || metric.includes('ratio')) {
		return `${(v * 100).toFixed(1)}%`;
	}

	if (metric.endsWith('_s')) {
		return `${Math.round(v)}초`;
	}

	if (metric.endsWith('_ms')) {
		return `${Math.round(v)}ms`;
	}

	return `${Math.round(v * 10) / 10}${metric.includes('cpu') ? '%' : ''}`;
}

/** 알림이 가리키는 화면 */
function linkFor(subjectType: string, subjectId: string | null, mode: 'edge' | 'origin'): string | null {
	if (mode === 'edge') {
		return subjectType === 'pipe' ? '/pipe' : subjectType === 'worker' ? '/workers' : subjectType === 'room' && subjectId ? `/broadcasts/${encodeURIComponent(subjectId)}` : '/overview';
	}

	return subjectType === 'edge' ? '/edges' : subjectType === 'broadcaster' && subjectId ? `/broadcasters/${encodeURIComponent(subjectId)}` : subjectType === 'pipe' ? '/edges' : '/overview';
}

const SUBJECT_LABEL: Record<string, string> = { pipe: 'Pipe', worker: 'Worker', room: '방송', viewer: 'Viewer', server: '서버', broadcaster: 'Broadcaster', edge: 'Edge' };

export function EdgeAlerts() {
	const page = usePage('/api/alerts', 10);
	const { meta, p } = page;
	const mode = useMeta()?.meta.mode ?? 'edge';
	const rules = p('rules');
	const ruleOf = (id: string) => (rules?.ok ? rules.data.rules.find((r: any) => r.ruleId === id) : undefined);

	return (
		<StaleScope meta={meta} lastFetchAt={page.lastSuccessAt} refreshSeconds={10}>
			<PageHeader title="Alerts" meta={meta} refreshSeconds={10} paused={page.paused} lastFetchAt={page.lastSuccessAt} right={<span className="small muted">규칙은 이 서버 기준으로 평가됩니다</span>} />
			<p className="page-desc">지금 울리고 있는 알림, 곧 울릴 수 있는 항목, 지난 24시간 이력, 그리고 알림 규칙을 한곳에서 봅니다.</p>

			<div className="grid g-wide-l">
				<Panel
					title={p('firing')?.ok ? `진행 중 ${(p('firing') as any).data.length}` : '진행 중'}
					panel={p('firing')}
					meta={meta}
					slow={page.slow}
					empty={{ when: (d: any[]) => d.length === 0, kind: 'alerts' }}
				>
					{(items: any[]) => (
						<div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
							{items.map(a => {
								const rule = ruleOf(a.ruleId);
								const href = linkFor(a.subjectType, a.subjectId, mode);

								return (
									<div key={a.alertId} className={`card alert-${a.severity}`} style={{ padding: 16 }}>
										<div className="card-head" style={{ marginBottom: 6 }}>
											<span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
												<span className={`tag status-${a.severity}`}>{a.severity === 'crit' ? '✕ 심각' : '▲ 경고'}</span>
												<b>
													{a.title} &gt; {fmt(rule?.metric ?? a.ruleId, a.threshold)}
												</b>
											</span>
											<span className="small muted mono">
												{clock(a.startedAt)}부터 · {ago(since(a.startedAt))}
											</span>
										</div>
										<div className="small muted">
											{SUBJECT_LABEL[a.subjectType] ?? a.subjectType} {a.subjectId ?? ''} · 현재 <b className="mono">{fmt(rule?.metric ?? '', a.currentValue ?? a.value)}</b> (임계치 {fmt(rule?.metric ?? '', a.threshold)}, 발동 시 {fmt(rule?.metric ?? '', a.value)})
										</div>
										{href && (
											<div style={{ marginTop: 6 }}>
												<Link to={href}>관련 화면 보기 →</Link>
											</div>
										)}
									</div>
								);
							})}
						</div>
					)}
				</Panel>

				<Panel title="곧 울릴 수 있는 항목" panel={p('near')} meta={meta} slow={page.slow}>
					{(items: any[]) =>
						items.length === 0 ? (
							<div className="empty" style={{ padding: 12 }}>
								✓ 경고 임계값의 80%에 근접한 항목이 없습니다
							</div>
						) : (
							<>
								<div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
									{items.slice(0, 6).map((n, i) => {
										const rule = ruleOf(n.ruleId);

										return (
											<div key={i}>
												<div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
													<span>
														{n.title} {n.subjectId ? <span className="muted">({n.subjectId})</span> : null}
													</span>
													<span className="mono">
														{fmt(rule?.metric ?? '', n.value)} / {fmt(rule?.metric ?? '', n.warnAbove)}
													</span>
												</div>
												<Bar value={n.ratioToWarn} max={1} level={n.ratioToWarn >= 0.9 ? 'warn' : null} />
											</div>
										);
									})}
								</div>
								<div className="card-note">막대는 경고 임계값 대비 현재 값의 비율입니다.</div>
							</>
						)
					}
				</Panel>
			</div>

			<Panel title="지난 24시간 알림 횟수 (시간별)" right={p('history')?.ok ? `합계 ${(p('history') as any).data.total}` : undefined} panel={p('history')} meta={meta} slow={page.slow}>
				{(h: any) => (
					<>
						<CountBars items={h.hourly} />
						<div className="events" style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
							{h.events.length === 0 && <Empty kind="alertHistory" compact />}
							{h.events.slice(0, 12).map((e: any) => (
								<div key={e.alertId} className="ev">
									<time>{clock(e.startedAt)}</time>
									<span>
										{e.state === 'firing' ? (
											<Status level={e.severity === 'crit' ? 'crit' : 'warn'}>
												{e.severity === 'crit' ? '심각' : '경고'} {e.title} ({e.subjectId ?? '서버'}) · 진행 중
											</Status>
										) : (
											<span>
												<span className="muted">{e.severity === 'crit' ? '심각' : '경고'}</span> {e.title} ({e.subjectId ?? '서버'}) · 해소 {clock(e.resolvedAt)}
											</span>
										)}
									</span>
								</div>
							))}
						</div>
					</>
				)}
			</Panel>

			<div style={{ height: 16 }} />
			<Panel title="알림 규칙" right="읽기 전용 · 외부 알림 채널 없음" panel={rules} meta={meta} slow={page.slow}>
				{(d: any) => (
					<div className="table-wrap">
						<table className="t">
							<thead>
								<tr>
									<th>규칙</th>
									<th>지표</th>
									<th>경고</th>
									<th>심각</th>
									<th>유지 시간</th>
									<th>사용</th>
								</tr>
							</thead>
							<tbody>
								{d.rules.map((r: any) => (
									<tr key={r.ruleId}>
										<td className="text">{r.title}</td>
										<td>{r.metric}</td>
										<td>&gt; {fmt(r.metric, r.warnAbove)}</td>
										<td>&gt; {fmt(r.metric, r.critAbove)}</td>
										<td>{r.windowSeconds === 0 ? '즉시' : r.windowSeconds >= 60 ? `${r.windowSeconds / 60}분` : `${r.windowSeconds}초`}</td>
										<td>{r.enabled ? <Status level="ok">사용</Status> : <span className="muted">○ 중지</span>}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</Panel>
		</StaleScope>
	);
}
