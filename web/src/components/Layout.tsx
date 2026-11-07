import { createContext, useContext, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';

import type { Meta, MetaResponse } from '../lib/api';
import { connection, useConnection } from '../lib/connection';
import { ago, clock, since } from '../lib/format';
import { useNow } from '../lib/usePolling';
import { useTheme } from '../lib/theme';

export const MetaContext = createContext<MetaResponse | null>(null);

export function useMeta(): MetaResponse | null {
	return useContext(MetaContext);
}

const EDGE_NAV = [
	['/overview', 'Overview'],
	['/workers', 'Workers'],
	['/broadcasts', 'Broadcasts (routers)'],
	['/pipe', 'Pipe 수신'],
	['/viewers', 'Viewers'],
	['/alerts', 'Alerts'],
] as const;

const ORIGIN_NAV = [
	['/overview', 'Overview'],
	['/rooms', 'Rooms & Broadcasters'],
	['/edges', 'Connected Edges'],
	['/alerts', 'Alerts'],
] as const;

export function Layout({ children }: { children: ReactNode }) {
	const meta = useMeta();
	const mode = meta?.meta.mode ?? 'edge';
	const nav = mode === 'origin' ? ORIGIN_NAV : EDGE_NAV;

	return (
		<div className="app">
			<aside className="sidebar">
				<div className="brand">
					<svg width="18" height="18" viewBox="0 0 16 16" aria-hidden>
						<circle cx="8" cy="8" r="3" style={{ fill: 'var(--blue)' }} />
						<path d="M8 1v3M8 12v3M1 8h3M12 8h3" strokeWidth="1.5" style={{ stroke: 'var(--blue)' }} />
					</svg>
					SFU Monitor
				</div>
				<div className={`server-box ${mode === 'origin' ? 'origin' : ''}`}>
					<div className="label">{mode === 'origin' ? 'ORIGIN' : '이 서버'}</div>
					<div className="mono">{meta?.meta.serverId ?? '…'}</div>
				</div>
				<ThemeToggle />
				<nav className="nav" aria-label="화면">
					{nav.map(([to, label]) => (
						<NavLink key={to} to={to} className={({ isActive }) => (isActive ? 'active' : '')}>
							{label}
						</NavLink>
					))}
				</nav>
				<div className="sidebar-foot">
					{meta && mode === 'edge' && (
						<div>
							{meta.meta.originUrl ? (
								<a href={meta.meta.originUrl} target="_blank" rel="noreferrer">
									Origin 대시보드 ↗
								</a>
							) : (
								<span className="faint" title="MSDASH_ORIGIN_URL이 설정되지 않았습니다">
									Origin 대시보드 (주소 없음)
								</span>
							)}
						</div>
					)}
				</div>
			</aside>
			<main className="main">
				<ConnectionBanner />
				{children}
			</main>
		</div>
	);
}

/** 서버 연결 불가 배너 (AGENT_TASK 7-5). 마지막 화면은 흐리게 남긴다. */
function ConnectionBanner() {
	const c = useConnection();
	const now = useNow();

	if (c.ok) {
		return null;
	}

	const next = c.nextRetryAt ? Math.max(0, Math.ceil((c.nextRetryAt - now) / 1000)) : null;

	return (
		<div className="banner" role="alert">
			<div>
				<div className="b-title">✕ 이 서버에 연결할 수 없습니다</div>
				<div className="small muted">
					마지막 성공: {c.lastSuccessAt ? `${clock(new Date(c.lastSuccessAt), true)} (${ago(since(new Date(c.lastSuccessAt), now))})` : '없음'} · 자동 재시도 중
					{next !== null ? ` · 다음 시도 ${next}초 후` : ''}
				</div>
			</div>
			<button className="btn" onClick={() => connection.retryNow()}>
				지금 다시 시도
			</button>
		</div>
	);
}

/**
 * 화면 제목 줄. 오른쪽에 갱신 상태: "Live · 10s 갱신" 또는 "마지막 수신 N초 전" (30초 노랑, 2분 빨강).
 * 수집기가 늦거나 서버 연결이 끊기면 stale로 본다 (AGENT_TASK 7-3).
 */
export function PageHeader({
	title,
	mono,
	crumb,
	badge,
	meta,
	refreshSeconds,
	paused,
	lastFetchAt,
	tags,
	right,
	subline,
}: {
	title: ReactNode;
	mono?: boolean;
	crumb?: ReactNode;
	badge?: ReactNode;
	meta: Meta | undefined;
	refreshSeconds: number;
	paused?: boolean;
	lastFetchAt?: number | null;
	tags?: ReactNode;
	right?: ReactNode;
	subline?: ReactNode;
}) {
	return (
		<div className="page-head">
			<div>
				{crumb && <div className="crumb">{crumb}</div>}
				<div className="page-title">
					<h1 className={mono ? 'mono' : undefined}>{title}</h1>
					{badge}
					{meta?.source === 'sim' && (
						<span className="tag sim" title="실제 mediasoup이 아닌 시뮬레이터 데이터입니다 (MSDASH_MEDIASOUP_SOURCE=sim)">
							▲ SIMULATED
						</span>
					)}
					{tags}
				</div>
				{subline && <div className="subline">{subline}</div>}
			</div>
			<div className="head-right">
				<LiveIndicator meta={meta} refreshSeconds={refreshSeconds} paused={paused} lastFetchAt={lastFetchAt} />
				{right}
			</div>
		</div>
	);
}

/** 수집 데이터 나이 = 수집기 마지막 성공 이후 + (연결이 끊겼으면) 마지막 응답 이후 */
export function dataAgeSeconds(meta: Meta | undefined, lastFetchAt: number | null | undefined, now: number): number | null {
	if (!meta) {
		return null;
	}

	const collectorAge = meta.collector.lastSuccessAt ? since(meta.collector.lastSuccessAt, now) : null;

	return collectorAge ?? (lastFetchAt ? (now - lastFetchAt) / 1000 : null);
}

/**
 * 데이터 나이 → 표시 단계. 수집 주기(meta.refresh.listSeconds)보다 짧게 갱신하는 상세 화면도
 * 수집 데이터 자체는 수집 주기마다 바뀌므로, 둘 중 긴 주기를 기준으로 본다.
 */
export function staleLevel(age: number | null, refreshSeconds: number, collectSeconds = refreshSeconds): 'fresh' | 'stale' | 'warn' | 'crit' {
	if (age === null) {
		return 'fresh';
	}

	if (age >= 120) {
		return 'crit';
	}

	if (age >= 30) {
		return 'warn';
	}

	return age > Math.max(refreshSeconds, collectSeconds) * 2.5 ? 'stale' : 'fresh';
}

function LiveIndicator({ meta, refreshSeconds, paused, lastFetchAt }: { meta: Meta | undefined; refreshSeconds: number; paused?: boolean; lastFetchAt?: number | null }) {
	const now = useNow();
	const conn = useConnection();
	const age = dataAgeSeconds(meta, conn.ok ? lastFetchAt : (conn.lastSuccessAt ?? lastFetchAt), now);
	const level = conn.ok ? staleLevel(age, refreshSeconds, meta?.refresh.listSeconds) : 'crit';

	if (paused) {
		return (
			<span className="live paused">
				<span className="dot" /> 갱신 멈춤 (백그라운드)
			</span>
		);
	}

	if (level === 'fresh') {
		return (
			<span className="live">
				<span className="dot" /> Live · {refreshSeconds}s 갱신
			</span>
		);
	}

	return (
		<span className={`live ${level === 'crit' ? 'stale-crit' : 'stale-warn'}`} title={meta?.collector.lastError ?? undefined}>
			▲ 마지막 수신 {ago(age)} · 갱신 지연 중
		</span>
	);
}

/** stale이면 자식 값을 흐리게 (값은 지우지 않는다) */
export function StaleScope({ meta, lastFetchAt, refreshSeconds, children }: { meta: Meta | undefined; lastFetchAt: number | null; refreshSeconds: number; children: ReactNode }) {
	const now = useNow();
	const conn = useConnection();
	const level = conn.ok ? staleLevel(dataAgeSeconds(meta, lastFetchAt, now), refreshSeconds, meta?.refresh.listSeconds) : 'crit';

	return <div className={level === 'warn' || level === 'crit' ? 'is-stale' : undefined}>{children}</div>;
}

export function RangeTabs({ value, options, onChange }: { value: string; options: Array<[string, string]>; onChange: (v: string) => void }) {
	return (
		<div className="tabs" role="tablist" aria-label="기간">
			{options.map(([v, label]) => (
				<button key={v} role="tab" aria-selected={value === v} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>
					{label}
				</button>
			))}
		</div>
	);
}

/** 라이트/다크 전환 스위치. 고른 값은 이 브라우저에 기억한다 (lib/theme.ts). */
function ThemeToggle() {
	const [theme, toggle] = useTheme();

	return (
		<div className="theme-switch" role="group" aria-label="화면 테마">
			{(['light', 'dark'] as const).map(t => (
				<button key={t} type="button" className={theme === t ? 'on' : ''} aria-pressed={theme === t} onClick={() => theme !== t && toggle()}>
					<span aria-hidden="true">{t === 'light' ? '☀' : '☾'}</span> {t === 'light' ? '라이트' : '다크'}
				</button>
			))}
		</div>
	);
}
