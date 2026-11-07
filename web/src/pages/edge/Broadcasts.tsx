import { Link, useNavigate, useParams } from 'react-router-dom';

import { LayerBar, LineChart } from '../../components/Charts';
import { PageHeader, StaleScope } from '../../components/Layout';
import { Empty, Panel, Skeleton } from '../../components/Panel';
import { Flagged, Status, levelOf } from '../../components/Status';
import { bps, duration, int, ms, pct, since } from '../../lib/format';
import { usePage } from '../../lib/usePage';
import { LossTitle } from './Overview';

export function EdgeBroadcasts() {
	const { roomId: param } = useParams();
	const navigate = useNavigate();
	const list = usePage('/api/edge/broadcasts', 10);
	const rooms = list.p<any[]>('rooms');
	const roomId = param ?? (rooms?.ok ? rooms.data[0]?.roomId : undefined);
	const detail = usePage(roomId ? `/api/edge/broadcasts/${encodeURIComponent(roomId)}?range=1h` : null, 10);
	const { meta } = list;

	return (
		<StaleScope meta={meta} lastFetchAt={list.lastSuccessAt} refreshSeconds={10}>
			<PageHeader title="Broadcasts" meta={meta} refreshSeconds={10} paused={list.paused} lastFetchAt={list.lastSuccessAt} />
			<p className="page-desc">
				이 서버가 중계하는 방송 목록과, 선택한 방송의 흐름(pipe 수신 → router → viewer)을 보여 줍니다. 문제가 pipe 쪽인지, 이 서버 안쪽인지, viewer 쪽인지 구분하는 화면입니다.
			</p>

			<div className="grid g-list">
				<Panel
					title={rooms?.ok ? `방송 ${rooms.data.length}` : '방송'}
					panel={rooms}
					meta={meta}
					slow={list.slow}
					empty={{ when: (d: any[]) => d.length === 0, kind: 'rooms' }}
				>
					{(data: any[]) => (
						<div className="pick-list">
							{data.map(r => (
								<button
									key={r.roomId}
									className={`pick ${r.roomId === roomId ? 'on' : ''}`}
									onClick={() => navigate(`/broadcasts/${encodeURIComponent(r.roomId)}`)}
									aria-current={r.roomId === roomId}
								>
									<div className="row">
										<span className="mono">{r.roomId}</span>
									</div>
									<div className="row small muted">
										<span>{int(r.viewerCount)}명</span>
										<Flagged level={levelOf(r.pipeLossRatio, 0.02)}>loss {pct(r.pipeLossRatio)}</Flagged>
									</div>
								</button>
							))}
						</div>
					)}
				</Panel>

				<div>
					{!roomId ? (
						rooms?.ok ? (
							<div className="card">
								<Empty kind="rooms" />
							</div>
						) : (
							<div className="card">
								<Skeleton slow={list.slow} />
							</div>
						)
					) : (
						<RoomDetail roomId={roomId} page={detail} />
					)}
				</div>
			</div>
		</StaleScope>
	);
}

function RoomDetail({ roomId, page }: { roomId: string; page: ReturnType<typeof usePage> }) {
	const { meta, p } = page;
	const header = p('header');

	return (
		<>
			<div className="page-head" style={{ marginBottom: 12 }}>
				<h2 className="mono" style={{ margin: 0, fontSize: 20 }}>
					{roomId}
				</h2>
				{header?.ok && (
					<div className="subline" style={{ marginTop: 0 }}>
						<span>
							router <b>{header.data.workers.map((w: number) => `w${w}`).join(' · ') || '—'}</b>
						</span>
						<span>
							방송 경과 <b>{duration(since(header.data.createdAt))}</b>
						</span>
						<span>
							viewer loss p50 <b>{pct(header.data.viewerLossP50)}</b>
						</span>
					</div>
				)}
			</div>
			{header && !header.ok ? (
				<div className="card">
					<div className="panel-na">⊖ {header.error}</div>
				</div>
			) : (
				<>
					<Panel title="흐름" panel={p('flow')} meta={meta} slow={page.slow}>
						{(f: any) => (
							<>
								<div className="flow">
									<div className={`flow-box ${levelOf(f.pipe.lossRatio, 0.02) === 'warn' ? 'warn' : ''}`}>
										<div className="fb-title">① Pipe 수신 (origin → 여기)</div>
										<div className="mono">{bps(f.pipe.bitrateBps)}</div>
										<div className="mono">
											<Flagged level={levelOf(f.pipe.lossRatio, 0.02)}>
												<LossTitle text={`loss ${pct(f.pipe.lossRatio)}`} />
											</Flagged>{' '}
											· RTT {ms(f.pipe.rttMs)}
										</div>
										<div className="small muted">piped producer {f.pipe.producerCount}</div>
									</div>
									<div className="flow-arrow" aria-hidden>
										→
									</div>
									<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
										{f.routers.length === 0 && <div className="flow-box muted">⊖ router 없음</div>}
										{f.routers.map((r: any) => (
											<div key={r.routerId} className="flow-box">
												<div className="fb-title">② Router · w{r.workerIdx}</div>
												<div className="mono">
													CPU {r.cpuPct === null ? '—' : `${Math.round(r.cpuPct)}%`} · 입력 {bps(r.inBitrateBps)}
												</div>
											</div>
										))}
									</div>
								</div>
								<div className="flow-box" style={{ marginTop: 8 }}>
									<div className="fb-title">③ Viewers</div>
									<div className="mono">
										{int(f.viewers.total)}명 ({f.viewers.perWorker.map((w: any) => `w${w.workerIdx} ${w.count}`).join(' · ')})
									</div>
									<div className="mono">consumers {int(f.viewers.consumers)}</div>
									{f.viewers.badCount > 0 ? <Status level="warn">loss 5% 이상 {f.viewers.badCount}명</Status> : <Status level="ok">loss 5% 이상 없음</Status>}
								</div>
								{f.finding && <div className="card-note">▲ {f.finding.detail}</div>}
							</>
						)}
					</Panel>

					<div style={{ height: 16 }} />
					<Panel title="Piped producers" panel={p('producers')} meta={meta} slow={page.slow} empty={{ when: (d: any[]) => d.length === 0, kind: 'data' }}>
						{(rows: any[]) => (
							<div className="table-wrap">
								<table className="t">
									<thead>
										<tr>
											<th>Stream</th>
											<th className="num">입력</th>
											<th className="num">Consumers</th>
											<th className="num">PLI / 분</th>
										</tr>
									</thead>
									<tbody>
										{rows.map((s, i) => (
											<tr key={i}>
												<td>
													{s.kind} · {s.codec ?? '—'}
													{s.layer ? ` · ${s.layer}` : ''}
												</td>
												<td className="num">{bps(s.bitrateBps)}</td>
												<td className="num">{int(s.consumerCount)}</td>
												<td className="num">{s.pliPerMin === null ? '—' : <Flagged level={s.pliPerMin >= 10 ? 'warn' : 'ok'}>{s.pliPerMin}</Flagged>}</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)}
					</Panel>

					<div style={{ height: 16 }} />
					<Panel title="Viewer 수" right="최근 1시간" panel={p('viewerSeries')} meta={meta} slow={page.slow}>
						{(pts: any[]) => <LineChart series={[{ label: 'viewers', points: pts.map(x => ({ t: x.t, v: x.viewers })) }]} height={200} format={v => String(Math.round(v))} xLabel={['-1h', 'now']} />}
					</Panel>

					<div style={{ height: 16 }} />
					<Panel title="Consumer 수신 레이어" panel={p('layers')} meta={meta} slow={page.slow}>
						{(d: any) => (
							<>
								<LayerBar mix={d.mix} />
								<div className="small muted" style={{ marginTop: 6 }}>
									레이어 전환 / 분:{' '}
									<span className="mono">
										{d.switchesPerMinute === null ? '—' : (
											<Flagged level={d.switchesPerMinuteBaseline !== null && d.switchesPerMinute > d.switchesPerMinuteBaseline * 2 && d.switchesPerMinute > 5 ? 'warn' : 'ok'}>
												{d.switchesPerMinute}
											</Flagged>
										)}
									</span>
									{d.switchesPerMinuteBaseline !== null && ` (최근 1시간 평균 ${d.switchesPerMinuteBaseline})`}
								</div>
							</>
						)}
					</Panel>
					<div className="card-note">
						<Link to={`/viewers?room=${encodeURIComponent(roomId)}&filter=room`}>이 방송의 viewer 보기 →</Link>
					</div>
				</>
			)}
		</>
	);
}
