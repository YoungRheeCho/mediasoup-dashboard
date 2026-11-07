import type { ReactNode } from 'react';

import type { Meta, Panel as PanelResult } from '../lib/api';
import { Mock } from './Status';

export type EmptyKind = 'rooms' | 'viewers' | 'alerts' | 'alertHistory' | 'edges' | 'broadcasters' | 'data';

/** 빈 상태 문구. 오류가 아니라 정상 상태임을 드러낸다 (AGENT_TASK 7-2). */
const EMPTY: Record<EmptyKind, { title: string; text: string; icon: string }> = {
	rooms: { icon: '⊖', title: '중계 중인 방송이 없습니다', text: 'origin에서 받아 오는 방송이 아직 없습니다. 방송이 시작되면 자동으로 나타납니다.' },
	viewers: { icon: '⊖', title: '지금 시청 중인 viewer가 없습니다', text: '연결된 방송이 없거나, 방송은 있지만 아직 아무도 들어오지 않았습니다.' },
	alerts: { icon: '✓', title: '현재 울리는 알림 없음', text: '모든 규칙이 임계값 아래에 있습니다.' },
	alertHistory: { icon: '✓', title: '지난 24시간 동안 알림이 없었습니다', text: '' },
	edges: { icon: '⊖', title: '연결된 edge가 없습니다', text: '아직 신호를 보낸 edge가 없습니다. edge 사이드카의 MSDASH_ORIGIN_URL 설정을 확인하세요.' },
	broadcasters: { icon: '⊖', title: '송출 중인 broadcaster가 없습니다', text: '방송이 시작되면 자동으로 나타납니다.' },
	data: { icon: '⊖', title: '표시할 데이터가 아직 없습니다', text: '수집이 시작된 지 얼마 되지 않았거나 이 구간에 기록이 없습니다.' },
};

export function Empty({ kind, compact }: { kind: EmptyKind; compact?: boolean }) {
	const e = EMPTY[kind];

	return (
		<div className="empty" style={compact ? { padding: 12 } : undefined}>
			<div aria-hidden style={{ fontSize: 20 }}>
				{e.icon}
			</div>
			<div className="e-title">{e.title}</div>
			{!compact && <div>{e.text}</div>}
		</div>
	);
}

/** 화면 전체가 처음 열릴 때: 카드 모양을 유지한 스켈레톤 (AGENT_TASK 7-1) */
export function PageSkeleton({ slow }: { slow?: boolean }) {
	return (
		<div aria-busy="true">
			<div className="skel" style={{ height: 28, width: 220, marginBottom: 20 }} />
			<div className="small muted" style={{ marginBottom: 12 }}>
				{slow ? '▲ 수집기 응답이 늦습니다' : '● 불러오는 중…'}
			</div>
			<div className="grid g3">
				{[0, 1, 2].map(i => (
					<div key={i} className="card kpi">
						<div className="skel" style={{ width: '40%' }} />
						<div className="skel" style={{ height: 32, width: '60%', marginTop: 12 }} />
					</div>
				))}
			</div>
			<div className="grid g2">
				{[0, 1].map(i => (
					<div key={i} className="card">
						<div className="skel" style={{ width: '35%', marginBottom: 16 }} />
						<div className="skel" style={{ height: 140 }} />
					</div>
				))}
			</div>
		</div>
	);
}

export function Skeleton({ lines = 3, height = 14, slow }: { lines?: number; height?: number; slow?: boolean }) {
	return (
		<div className="skeleton" aria-busy="true">
			<div className="small muted">{slow ? '▲ 수집기 응답이 늦습니다' : '● 불러오는 중…'}</div>
			{Array.from({ length: lines }, (_, i) => (
				<div key={i} className="skel" style={{ height: i === 0 ? height * 3 : height, width: i === lines - 1 ? '60%' : '100%' }} />
			))}
		</div>
	);
}

type Props<T> = {
	title?: ReactNode;
	right?: ReactNode;
	/** 패널 결과. undefined면 아직 응답 전 */
	panel: PanelResult<T> | undefined;
	meta?: Meta;
	slow?: boolean;
	/** 이 패널에서 쓰는 mock 필드 (패널 결과의 mock과 합쳐 배지 표시) */
	mockFields?: string[];
	empty?: { when: (data: T) => boolean; kind: EmptyKind };
	skeletonLines?: number;
	className?: string;
	/** 카드 테두리 없이 (KPI 줄처럼 안에 카드가 있는 경우) */
	bare?: boolean;
	children: (data: T, panel: Extract<PanelResult<T>, { ok: true }>) => ReactNode;
};

/**
 * 화면 패널 하나. 패널마다 따로 상태를 가진다 (AGENT_TASK 7):
 * 로딩 스켈레톤(5초 넘으면 "수집기 응답이 늦습니다"), 빈 상태, 부분 실패, 제외 항목, mock 배지.
 */
export function Panel<T>({ title, right, panel, meta, slow, mockFields, empty, skeletonLines = 3, className, bare, children }: Props<T>) {
	const mock = [...(mockFields ?? []), ...(panel?.ok ? (panel.mock ?? []) : [])];

	if (bare) {
		return (
			<div className={className} style={{ marginBottom: 16 }}>
				<PanelBody panel={panel} slow={slow} empty={empty} skeletonLines={skeletonLines}>
					{children}
				</PanelBody>
			</div>
		);
	}

	return (
		<section className={`card ${className ?? ''}`}>
			{(title || right) && (
				<div className="card-head">
					<h2 className="card-title">
						{title}
						<Mock meta={meta} fields={mock} />
					</h2>
					{right && <div className="card-right">{right}</div>}
				</div>
			)}
			<PanelBody panel={panel} slow={slow} empty={empty} skeletonLines={skeletonLines}>
				{children}
			</PanelBody>
		</section>
	);
}

export function PanelBody<T>({
	panel,
	slow,
	empty,
	skeletonLines = 3,
	children,
}: Pick<Props<T>, 'panel' | 'slow' | 'empty' | 'skeletonLines' | 'children'>) {
	if (!panel) {
		return <Skeleton lines={skeletonLines} slow={slow} />;
	}

	if (!panel.ok) {
		if (panel.reason === 'not_implemented') {
			return <div className="panel-na">○ 구현하지 않은 항목입니다 — {panel.error}</div>;
		}

		if (panel.reason === 'not_found') {
			return <div className="panel-na">⊖ {panel.error}</div>;
		}

		return <div className="panel-error">▲ 이 패널의 데이터를 가져오지 못했습니다 — {panel.error}. 나머지 화면은 정상입니다.</div>;
	}

	if (empty && empty.when(panel.data)) {
		return <Empty kind={empty.kind} />;
	}

	return (
		<div className="stale-dim">
			{children(panel.data, panel)}
			{panel.excluded && panel.excluded.length > 0 && (
				<div className="excluded">▲ {panel.excluded.join(', ')} 통계 수집 실패 (응답 없음) · 합계에서 제외 · 나머지는 정상</div>
			)}
		</div>
	);
}
