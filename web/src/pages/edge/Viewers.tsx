import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { COLORS, LineChart } from '../../components/Charts';
import { PageHeader, StaleScope } from '../../components/Layout';
import { Empty, Panel, Skeleton } from '../../components/Panel';
import { Flagged, Mock, levelOf } from '../../components/Status';
import { bps, duration, int, ms, pct } from '../../lib/format';
import { usePage } from '../../lib/usePage';
import { LossTitle } from './Overview';

const SORTS: Array<[string, string]> = [
	['loss', 'Loss'],
	['freeze', 'Freeze'],
	['rtt', 'RTT'],
	['layer', '레이어'],
	['connected', '접속'],
];

export function EdgeViewers() {
	const [params, setParams] = useSearchParams();
	const filter = params.get('filter') ?? 'all';
	const room = params.get('room');
	const sort = params.get('sort') ?? 'loss';
	const [q, setQ] = useState(params.get('q') ?? '');
	const [debounced, setDebounced] = useState(q);
	const [limit, setLimit] = useState(50);
	const [selected, setSelected] = useState<string | null>(null);

	useEffect(() => {
		const t = window.setTimeout(() => setDebounced(q), 300);

		return () => window.clearTimeout(t);
	}, [q]);

	const query = new URLSearchParams({ filter, sort, limit: String(limit), ...(debounced ? { q: debounced } : {}), ...(room ? { room } : {}) });
	const page = usePage(`/api/edge/viewers?${query}`, 10);
	const { meta, p } = page;
	const list = p('viewers');
	const set = (patch: Record<string, string | null>) => {
		const next = new URLSearchParams(params);

		for (const [k, v] of Object.entries(patch)) {
			if (v === null) next.delete(k);
			else next.set(k, v);
		}

		setParams(next, { replace: true });
	};

	useEffect(() => {
		if (list?.ok && !selected && list.data.items[0]) {
			setSelected(list.data.items[0].viewerId);
		}
	}, [list, selected]);

	const counts = list?.ok ? list.data.counts : null;
	const chips: Array<[string, string, number | undefined, Record<string, string | null>]> = [
		['all', '전체', counts?.all, { filter: 'all', room: null }],
		['loss5', 'loss 5% 이상', counts?.loss5, { filter: 'loss5', room: null }],
		['lowlayer', 'L0(Low) 레이어', counts?.lowLayer, { filter: 'lowlayer', room: null }],
	];

	return (
		<StaleScope meta={meta} lastFetchAt={page.lastSuccessAt} refreshSeconds={10}>
			<PageHeader title="Viewers" meta={meta} refreshSeconds={10} paused={page.paused} lastFetchAt={page.lastSuccessAt} />
			<p className="page-desc">
				이 서버에 접속한 viewer를 개별로 봅니다. 기본 정렬은 <b>품질이 나쁜 순</b>이라 문제 viewer가 항상 위에 옵니다. 행을 선택하면 오른쪽에 요약이 열리고, Viewer ID를 누르면 재생 상태 상세 페이지로 이동합니다.
			</p>

			<div className="filters">
				<label className="search">
					검색
					<input value={q} onChange={e => setQ(e.target.value)} placeholder="viewer id, 이름 또는 IP" aria-label="viewer 검색" />
				</label>
				{chips.map(([key, label, n, patch]) => (
					<button key={key} className={`chip ${filter === key && !room ? 'on' : ''}`} onClick={() => set(patch)}>
						{label} {n !== undefined ? int(n) : ''}
					</button>
				))}
				{counts &&
					Object.entries(counts.rooms as Record<string, number>).map(([r, n]) => (
						<button key={r} className={`chip ${room === r ? 'on' : ''}`} onClick={() => set({ filter: 'room', room: r })}>
							{r} {int(n)}
						</button>
					))}
			</div>

			<div className="grid g-side">
				<Panel
					panel={list}
					meta={meta}
					slow={page.slow}
					title="Viewer 목록"
					right={
						<span>
							정렬{' '}
							<select
								value={sort}
								onChange={e => set({ sort: e.target.value })}
								aria-label="정렬"
								style={{ background: 'var(--card)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, minHeight: 32 }}
							>
								{SORTS.map(([v, l]) => (
									<option key={v} value={v}>
										{l}
									</option>
								))}
							</select>
						</span>
					}
					empty={{ when: (d: any) => d.counts.all === 0, kind: 'viewers' }}
				>
					{(d: any) =>
						d.items.length === 0 ? (
							<div className="empty">⊖ 조건에 맞는 viewer가 없습니다</div>
						) : (
							<>
								<div className="table-wrap">
									<table className="t">
										<thead>
											<tr>
												<th>Viewer</th>
												<th>방송</th>
												<th>IP</th>
												<th className="num">
													<LossTitle text={`Loss${sort === 'loss' ? ' ↓' : ''}`} />
												</th>
												<th className="num">
													Freeze {d.items.some((v: any) => v.clientSource === 'mock') && <Mock meta={meta} fields={['viewer_sample.client_freeze_count']} />}
												</th>
												<th className="num">RTT</th>
												<th>레이어</th>
												<th className="num">접속</th>
											</tr>
										</thead>
										<tbody>
											{d.items.map((v: any) => (
												<tr key={v.viewerId} className={`clickable ${selected === v.viewerId ? 'selected' : ''}`} onClick={() => setSelected(v.viewerId)}>
													<td>
														<Link to={`/viewers/${encodeURIComponent(v.viewerId)}`} onClick={e => e.stopPropagation()} title={v.viewerId}>
															{v.displayName ?? v.viewerId.slice(0, 8)}
														</Link>
													</td>
													<td>{v.roomId}</td>
													<td className="mono">{v.remoteIp ?? '—'}</td>
													<td className="num">
														<Flagged level={levelOf(v.lossRatio, 0.05, 0.08)}>{pct(v.lossRatio)}</Flagged>
													</td>
													<td className="num">{v.freezeCount ?? '—'}</td>
													<td className="num">{ms(v.rttMs)}</td>
													<td>{v.layer ?? '—'}</td>
													<td className="num">{duration(v.connectedSeconds)}</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
								<div className="card-head" style={{ marginTop: 12, marginBottom: 0 }}>
									<span className="small muted">
										{int(d.total)}명 중 {int(d.items.length)}명 표시 ({SORTS.find(s => s[0] === sort)?.[1]} 순)
									</span>
									{d.items.length < d.total && (
										<button className="link-btn" onClick={() => setLimit(l => l + 50)}>
											더 보기
										</button>
									)}
								</div>
							</>
						)
					}
				</Panel>

				<ViewerSummary viewerId={selected} />
			</div>
		</StaleScope>
	);
}

/** 선택한 viewer 요약 (10초 갱신) */
function ViewerSummary({ viewerId }: { viewerId: string | null }) {
	const page = usePage(viewerId ? `/api/edge/viewers/${encodeURIComponent(viewerId)}?range=5m` : null, 10);
	const { meta, p } = page;

	if (!viewerId) {
		return (
			<div className="card">
				<Empty kind="viewers" compact />
			</div>
		);
	}

	const session = p('session');
	const series = p('series');
	const diagnosis = p('diagnosis');

	if (!session) {
		return (
			<div className="card">
				<Skeleton slow={page.slow} />
			</div>
		);
	}

	if (!session.ok) {
		return (
			<div className="card">
				<div className="panel-na">⊖ {session.error}</div>
			</div>
		);
	}

	const s = session.data;
	const pts = series?.ok ? series.data.points : [];
	const lastClient = [...pts].reverse().find((x: any) => x.clientFps !== null);

	return (
		<section className="card">
			<div className="card-head">
				<h2 className="card-title mono">{s.displayName ?? viewerId.slice(0, 8)}</h2>
				<span className="small">
					<Flagged level={levelOf(s.lossRatio, 0.05)}>loss {pct(s.lossRatio)}</Flagged>
				</span>
			</div>
			<div className="small muted">Loss (최근 5분, 서버 측정)</div>
			<LineChart series={[{ label: 'loss', color: COLORS.orange, points: pts.map((x: any) => ({ t: x.t, v: x.lossRatio === null ? null : x.lossRatio * 100 })) }]} height={110} format={v => `${v.toFixed(0)}%`} xLabel={['-5m', 'now']} />
			<div className="section-label">서버가 본 값</div>
			<div className="kv-2">
				<div>
					<div className="l">수신 레이어</div>
					<div className="v">
						{s.layer ?? '—'} · {bps(s.bitrateBps)}
					</div>
				</div>
				<div>
					<div className="l">Transport</div>
					<div className="v">recv · {s.transportState ?? '—'}</div>
				</div>
				<div>
					<div className="l">Loss</div>
					<div className="v">
						<Flagged level={levelOf(s.lossRatio, 0.05)}>{pct(s.lossRatio)}</Flagged>
					</div>
				</div>
				<div>
					<div className="l">RTT</div>
					<div className="v">{ms(s.rttMs)}</div>
				</div>
				<div>
					<div className="l">접속 IP</div>
					<div className="v mono">{s.remoteIp ?? '—'}</div>
				</div>
			</div>
			<div className="section-label">
				viewer 브라우저가 보고한 값 {series?.ok && series.data.clientMock && <Mock meta={meta} fields={['viewer_sample.client_fps']} />}
			</div>
			{lastClient ? (
				<div className="kv-2">
					<div>
						<div className="l">Freeze</div>
						<div className="v">{s.freezeCount ?? 0}회 / 최근</div>
					</div>
					<div>
						<div className="l">디코딩 fps</div>
						<div className="v">{lastClient.clientFps === null ? '—' : Math.round(lastClient.clientFps * 10) / 10}</div>
					</div>
					<div>
						<div className="l">Jitter buffer</div>
						<div className="v">{ms(lastClient.clientJitterBufferMs)}</div>
					</div>
					<div>
						<div className="l">브라우저</div>
						<div className="v">{s.environment?.browser ?? '—'}</div>
					</div>
				</div>
			) : (
				<div className="small muted">⊖ 브라우저 보고 없음</div>
			)}
			{diagnosis?.ok && diagnosis.data[0] && (
				<div className="card-note" style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
					{diagnosis.data.map((f: any) => `${f.title}: ${f.detail}`).join(' ')}
				</div>
			)}
			<div style={{ marginTop: 12 }}>
				<Link to={`/viewers/${encodeURIComponent(viewerId)}`}>재생 상태 상세 보기 →</Link>
			</div>
		</section>
	);
}
