import type { ReactNode } from 'react';

import { clock, DASH } from '../lib/format';
import { StatusIcon, type Level } from './Status';
import { Mock } from './Status';
import type { Meta } from '../lib/api';

/** KPI 카드 */
export function Kpi({
	label,
	value,
	unit,
	sub,
	level,
	mock,
}: {
	label: ReactNode;
	value: ReactNode;
	unit?: ReactNode;
	sub?: ReactNode;
	level?: Level;
	mock?: ReactNode;
}) {
	const alert = level === 'warn' ? 'alert-warn' : level === 'crit' ? 'alert-crit' : '';

	return (
		<div className={`card kpi ${alert}`}>
			<div className="k-label">
				{label}
				{mock}
			</div>
			<div className="k-value stale-dim">
				{(level === 'warn' || level === 'crit') && <StatusIcon level={level} />}
				<span>{value ?? DASH}</span>
				{unit && <span className="k-unit">{unit}</span>}
			</div>
			{sub && <div className="k-sub stale-dim">{sub}</div>}
		</div>
	);
}

export type FindingItem = { level: Level; title: string; detail: string; mock?: boolean };

/** 진단 요약 문구 목록 */
export function Findings({ items, meta }: { items: FindingItem[]; meta: Meta | undefined }) {
	if (items.length === 0) {
		return <div className="muted small">✓ 특이 사항 없음</div>;
	}

	return (
		<div className="findings">
			{items.map((f, i) => (
				<div key={i} className="finding">
					<StatusIcon level={f.level} />
					<div>
						<b>{f.title}</b> — <span className="muted">{f.detail}</span> {f.mock && <Mock meta={meta} force />}
					</div>
				</div>
			))}
		</div>
	);
}

export type EventItem = { t: string; level: string; text: string; mock?: boolean };

export function Events({ items, meta, withSeconds }: { items: EventItem[]; meta?: Meta; withSeconds?: boolean }) {
	if (items.length === 0) {
		return <div className="muted small">⊖ 이벤트 없음</div>;
	}

	return (
		<div className="events">
			{items.map((e, i) => {
				const level = (['warn', 'crit'].includes(e.level) ? e.level : 'info') as Level;

				return (
					<div key={i} className="ev" style={withSeconds ? { gridTemplateColumns: '80px 1fr' } : undefined}>
						<time>{clock(e.t, withSeconds)}</time>
						<span>
							{level !== 'info' && <StatusIcon level={level} />} <span className={level === 'info' ? undefined : level}>{e.text}</span>{' '}
							{e.mock && <Mock meta={meta} force />}
						</span>
					</div>
				);
			})}
		</div>
	);
}

/** 상태 띠 타임라인. 같은 값이 이어지면 한 칸으로 합친다. */
export function Timeline({
	lanes,
	times,
}: {
	lanes: Array<{ label: ReactNode; values: Array<string | null>; colors: Record<string, string>; names?: Record<string, string> }>;
	times: string[];
}) {
	if (times.length === 0) {
		return <div className="muted small">⊖ 이 구간에 기록이 없습니다</div>;
	}

	const ticks = 5;

	return (
		<div className="timeline">
			{lanes.map((lane, li) => {
				const segs: Array<{ v: string | null; n: number }> = [];

				for (const v of lane.values) {
					const last = segs.at(-1);

					if (last && last.v === v) {
						last.n++;
					} else {
						segs.push({ v, n: 1 });
					}
				}

				return (
					<div key={li} style={{ display: 'contents' }}>
						<div className="muted">{lane.label}</div>
						<div className="lane">
							{segs.map((s, i) => (
								<div
									key={i}
									className="seg"
									title={s.v ? (lane.names?.[s.v] ?? s.v) : '기록 없음'}
									style={{ flex: s.n, background: s.v ? (lane.colors[s.v] ?? 'var(--seg-neutral)') : 'var(--seg-empty)', color: s.v && ['connected'].includes(s.v) ? 'var(--green)' : undefined }}
								>
									{s.n / lane.values.length > 0.12 && s.v ? (lane.names?.[s.v] ?? s.v) : ''}
								</div>
							))}
						</div>
					</div>
				);
			})}
			<div />
			<div className="axis">
				{Array.from({ length: ticks }, (_, i) => {
					const idx = Math.round((i / (ticks - 1)) * (times.length - 1));

					return <span key={i}>{clock(times[idx]!, true)}</span>;
				})}
			</div>
		</div>
	);
}
