import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import type { Panel as PanelResult } from '../lib/api';
import { PanelBody } from './Panel';

/**
 * Overview 화면 조각 (handoff/HANDOFF.md). 스타일은 styles.css의 .ov / .lv-* 에 있다.
 * 상태는 색만으로 구분하지 않는다: 아이콘(✓ ▲ ✕ ○)과 문구를 항상 함께 쓴다.
 */

/** 서버가 알림 규칙으로 판정한 등급. idle = 신호·트래픽 없음(회색) */
export type OvLevel = 'ok' | 'warn' | 'crit' | 'idle';

export const LV_ICON: Record<OvLevel, string> = { ok: '✓', warn: '▲', crit: '✕', idle: '○' };
const LV_LABEL: Record<OvLevel, string> = { ok: '정상', warn: '주의', crit: '장애', idle: '신호 없음' };

export function lv(level: OvLevel | null | undefined): string {
	return `lv-${level ?? 'idle'}`;
}

const RANK: Record<OvLevel, number> = { idle: -1, ok: 0, warn: 1, crit: 2 };

/** 가장 나쁜 등급. 전부 idle이면 idle (빈 목록은 ok). */
export function worstLevel(levels: OvLevel[]): OvLevel {
	return levels.reduce<OvLevel>((a, l) => (RANK[l] > RANK[a] ? l : a), levels[0] ?? 'ok');
}

/** 아이콘 + 문구. 아이콘에는 텍스트 대체를 붙인다. */
export function LevelText({ level, children, className }: { level: OvLevel; children: ReactNode; className?: string }) {
	return (
		<span className={`ov-state ${lv(level)} ${className ?? ''}`}>
			<span role="img" aria-label={LV_LABEL[level]}>
				{LV_ICON[level]}
			</span>
			{children}
		</span>
	);
}

export function Banner({ level, title, desc, chips }: { level: OvLevel; title: ReactNode; desc: ReactNode; chips: Array<{ level: OvLevel; text: string; to?: string }> }) {
	return (
		<section className={`ov-banner ${lv(level)}`} role="status">
			<div className="ov-banner-icon" role="img" aria-label={LV_LABEL[level]}>
				{level === 'ok' ? (
					<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
						<path d="M5 12.5l4.5 4.5L19 7.5" />
					</svg>
				) : (
					<span aria-hidden="true">{LV_ICON[level]}</span>
				)}
			</div>
			<div className="ov-banner-text">
				<div className="ov-banner-title">{title}</div>
				<div className="ov-banner-desc">{desc}</div>
			</div>
			<div className="ov-chips">
				{chips.map(c =>
					c.to ? (
						<Link key={c.text} to={c.to} className={`ov-chip ${lv(c.level)}`}>
							{c.level !== 'ok' && <span aria-hidden="true">{LV_ICON[c.level]} </span>}
							{c.text}
						</Link>
					) : (
						<span key={c.text} className={`ov-chip ${lv(c.level)}`}>
							{c.level !== 'ok' && <span aria-hidden="true">{LV_ICON[c.level]} </span>}
							{c.text}
						</span>
					)
				)}
			</div>
		</section>
	);
}

/** 연결선 하나: 위 값, 가운데 선(상태색 / 점선), 아래 설명 */
export function FlowLink({ level, value, caption, mono, dashed }: { level: OvLevel; value: ReactNode; caption: ReactNode; mono?: boolean; dashed?: boolean }) {
	return (
		<div className={`ov-link ${lv(level)} ${level === 'idle' ? 'idle' : ''} ${dashed ? 'dashed' : ''}`}>
			<div className="ov-link-value">{value}</div>
			<div className="ov-link-line" role="img" aria-label={`연결 ${LV_LABEL[level]}`} />
			<div className={`ov-link-caption ${mono ? 'mono' : ''}`}>{caption}</div>
		</div>
	);
}

/** 큰 숫자 + 작은 단위 문구 */
export function Big({ value, unit }: { value: ReactNode; unit?: ReactNode }) {
	return (
		<div className="ov-big">
			{value}
			{unit && <small>{unit}</small>}
		</div>
	);
}

export function StatCard({ label, value, unit, sub, level }: { label: ReactNode; value: ReactNode; unit?: ReactNode; sub?: ReactNode; level?: OvLevel | null }) {
	return (
		<div className={`ov-card ov-stat ${level ? lv(level) : ''}`}>
			<div className="ov-stat-label">{label}</div>
			<div className="ov-stat-value">
				{value}
				{unit && <small>{unit}</small>}
			</div>
			{sub && <div className="ov-stat-sub">{sub}</div>}
		</div>
	);
}

export function Card({ title, hint, right, className, children }: { title: ReactNode; hint?: ReactNode; right?: ReactNode; className?: string; children: ReactNode }) {
	return (
		<section className={`ov-card ${className ?? ''}`}>
			<div className="ov-card-head">
				<h2>{title}</h2>
				{hint && <span className="ov-hint">{hint}</span>}
				{right}
			</div>
			{children}
		</section>
	);
}

/** 패널 결과를 Overview 카드 안에서 그린다 (로딩·부분 실패 표시는 기존 PanelBody 그대로). */
export function OvPanel<T>({ panel, slow, children }: { panel: PanelResult<T> | undefined; slow?: boolean; children: (data: T) => ReactNode }) {
	return (
		<PanelBody panel={panel} slow={slow} skeletonLines={2}>
			{d => children(d)}
		</PanelBody>
	);
}

/** "끊김 / 주의 / 정상" 개수 문구: 예) "1개 loss 주의 · 나머지 정상" */
export function countText(levels: OvLevel[], labels: { crit: string; warn: string; ok: string; allOk: string }): string {
	const crit = levels.filter(l => l === 'crit').length;
	const warn = levels.filter(l => l === 'warn').length;

	if (crit === 0 && warn === 0) {
		return labels.allOk;
	}

	const parts = [crit && `${crit}개 ${labels.crit}`, warn && `${warn}개 ${labels.warn}`].filter(Boolean);

	return crit + warn < levels.length ? `${parts.join(' · ')} · 나머지 ${labels.ok}` : parts.join(' · ');
}
