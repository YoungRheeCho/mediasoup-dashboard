import { useState } from 'react';

import { Kpi } from '../../components/Blocks';
import { PageHeader, StaleScope } from '../../components/Layout';
import { Panel } from '../../components/Panel';
import { Flagged, StatusIcon, levelOf } from '../../components/Status';
import { ago, bps, bpsParts, clock, duration, pct, since } from '../../lib/format';
import { usePage } from '../../lib/usePage';
import { EdgeState, OpenEdge } from './common';

type Filter = 'all' | 'problem' | 'connected' | 'lost';

export function OriginEdges() {
	const page = usePage('/api/origin/edges', 10);
	const { meta, p } = page;
	const [q, setQ] = useState('');
	const [filter, setFilter] = useState<Filter>('all');
	const edges = p('edges');
	const all: any[] = edges?.ok ? edges.data : [];
	const counts = {
		all: all.length,
		problem: all.filter(e => e.state !== 'connected').length,
		connected: all.filter(e => e.state !== 'lost').length,
		lost: all.filter(e => e.state === 'lost').length,
	};
	const chips: Array<[Filter, string]> = [
		['all', '전체'],
		['problem', '문제 있음'],
		['connected', '연결됨'],
		['lost', '끊김'],
	];

	return (
		<StaleScope meta={meta} lastFetchAt={page.lastSuccessAt} refreshSeconds={10}>
			<PageHeader title="Connected Edges" meta={meta} refreshSeconds={10} paused={page.paused} lastFetchAt={page.lastSuccessAt} />
			<p className="page-desc">
				이 origin에 pipe로 연결된 edge 목록입니다. 여기서는 origin이 직접 아는 정보(pipe 상태, 송신량, 수신 측이 보고한 loss)만 보여 주고, edge 내부 상태는 "대시보드 열기"로 새 탭에서 확인합니다.
			</p>

			<Panel panel={p('summary')} meta={meta} slow={page.slow} bare skeletonLines={1}>
				{(s: any) => (
					<div className="grid g5" style={{ margin: 0 }}>
						<Kpi label="등록된 edge" value={s.registered} />
						<Kpi label="연결됨" value={<span className="ok">{s.connected}</span>} />
						<Kpi label="신호 끊김" level={s.lost > 0 ? 'warn' : undefined} value={s.lost} />
						<Kpi label="수신 측 loss 주의" level={s.recvLossWarning > 0 ? 'warn' : undefined} value={s.recvLossWarning} />
						<Kpi label="총 pipe 송신" value={bpsParts(s.totalPipeSendBps)[0]} unit={bpsParts(s.totalPipeSendBps)[1]} />
					</div>
				)}
			</Panel>

			<div className="filters">
				<label className="search">
					검색
					<input value={q} onChange={e => setQ(e.target.value)} placeholder="edge 이름 또는 지역" aria-label="edge 검색" />
				</label>
				{chips.map(([key, label]) => (
					<button key={key} className={`chip ${filter === key ? 'on' : ''}`} onClick={() => setFilter(key)}>
						{label} {counts[key]}
					</button>
				))}
			</div>

			<Panel panel={edges} meta={meta} slow={page.slow} empty={{ when: (d: any[]) => d.length === 0, kind: 'edges' }}>
				{(list: any[]) => {
					const shown = list.filter(
						e =>
							(!q || e.edgeId.toLowerCase().includes(q.toLowerCase()) || (e.region ?? '').toLowerCase().includes(q.toLowerCase())) &&
							(filter === 'all' ||
								(filter === 'problem' && e.state !== 'connected') ||
								(filter === 'connected' && e.state !== 'lost') ||
								(filter === 'lost' && e.state === 'lost'))
					);

					return (
						<>
							<div className="table-wrap">
								<table className="t">
									<thead>
										<tr>
											<th>Edge</th>
											<th>지역</th>
											<th>상태</th>
											<th className="num">방송</th>
											<th className="num">송신</th>
											<th className="num">수신 측 보고 loss</th>
											<th>마지막 신호</th>
											<th>등록</th>
											<th className="num">대시보드</th>
										</tr>
									</thead>
									<tbody>
										{shown.map(e => (
											<tr key={e.edgeId}>
												<td>{e.edgeId}</td>
												<td>{e.region ?? '—'}</td>
												<td className="text">
													<EdgeState state={e.state} reason={e.reason} />
													{e.reason && <div className="small muted">{e.reason}</div>}
												</td>
												<td className="num">{e.rooms}</td>
												<td className="num">{e.state === 'lost' ? '—' : bps(e.sendBitrateBps)}</td>
												<td className="num">{e.state === 'lost' ? '—' : <Flagged level={levelOf(e.recvLossRatio, 0.02)}>{pct(e.recvLossRatio)}</Flagged>}</td>
												<td>{e.lastSeenAt ? `${clock(e.lastSeenAt, true)} (${ago(e.ageSeconds)})` : '신호 없음'}</td>
												<td>{e.firstSeenAt ? duration(since(e.firstSeenAt)) : '—'}</td>
												<td className="num">
													<OpenEdge url={e.dashboardUrl} state={e.state} />
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
							{shown.length === 0 && <div className="empty">⊖ 조건에 맞는 edge가 없습니다</div>}
							<div className="card-note">문제 있는 edge가 위로 올라옵니다. 신호가 끊긴 edge도 서버 자체는 응답할 수 있으니 대시보드를 열어 직접 확인하세요.</div>
						</>
					);
				}}
			</Panel>

			<div style={{ height: 16 }} />
			<Panel
				title="방송 × Edge 전달 현황"
				right={
					<span className="legend" style={{ margin: 0 }}>
						<span>
							<StatusIcon level="ok" /> 전달 중
						</span>
						<span>
							<StatusIcon level="crit" /> 끊김
						</span>
						<span>· 없음</span>
					</span>
				}
				panel={p('matrix')}
				meta={meta}
				slow={page.slow}
				empty={{ when: (d: any) => d.rooms.length === 0, kind: 'rooms' }}
			>
				{(m: any) => (
					<>
						<div className="table-wrap">
							<table className="t matrix">
								<thead>
									<tr>
										<th>방송</th>
										{m.edges.map((e: string) => (
											<th key={e}>{e}</th>
										))}
									</tr>
								</thead>
								<tbody>
									{m.rooms.map((r: string) => (
										<tr key={r}>
											<td>{r}</td>
											{m.edges.map((e: string) => {
												const cell = m.cells.find((c: any) => c.roomId === r && c.edgeId === e);

												return (
													<td key={e} title={cell ? (cell.state === 'delivering' ? '전달 중' : '끊김') : '없음'}>
														{!cell ? <span className="faint">·</span> : cell.state === 'delivering' ? <StatusIcon level="ok" label="전달 중" /> : <StatusIcon level="crit" label="끊김" />}
													</td>
												);
											})}
										</tr>
									))}
								</tbody>
							</table>
						</div>
						<div className="card-note">각 칸은 해당 방송이 그 edge로 pipe되고 있는지 나타냅니다. edge 신호가 끊겼거나 pipe가 닫히면 끊김으로 표시합니다.</div>
					</>
				)}
			</Panel>
		</StaleScope>
	);
}
