import { Link, useNavigate, useParams } from 'react-router-dom';

import { LineChart } from '../../components/Charts';
import { PageHeader, RangeTabs, StaleScope } from '../../components/Layout';
import { Empty, Panel, Skeleton } from '../../components/Panel';
import { Flagged, Mock, Status, StatusIcon, levelOf } from '../../components/Status';
import { bps, duration, int, ms, pct, since } from '../../lib/format';
import { usePage, useRange } from '../../lib/usePage';
import { LossTitle } from '../edge/Overview';
import { EdgeState, OpenEdge } from './common';

export function OriginRooms() {
	const { roomId: param } = useParams();
	const navigate = useNavigate();
	const [range, setRange] = useRange('5m');
	const list = usePage('/api/origin/rooms', 10);
	const rooms = list.p<any[]>('rooms');
	const roomId = param ?? (rooms?.ok ? rooms.data[0]?.roomId : undefined);
	const detail = usePage(roomId ? `/api/origin/rooms/${encodeURIComponent(roomId)}?range=${range}` : null, 10);
	const { meta } = list;

	return (
		<StaleScope meta={meta} lastFetchAt={list.lastSuccessAt} refreshSeconds={10}>
			<PageHeader
				title="Rooms & Broadcasters"
				meta={meta}
				refreshSeconds={10}
				paused={list.paused}
				lastFetchAt={list.lastSuccessAt}
				right={
					<RangeTabs
						value={range}
						options={[
							['5m', '5m'],
							['1h', '1h'],
						]}
						onChange={setRange}
					/>
				}
			/>
			<p className="page-desc">방송(room) 하나에 broadcaster가 여러 명일 수 있습니다. 방송을 고르면 broadcaster별 입력 상태와, 이 방송을 받는 edge를 볼 수 있습니다.</p>

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
								<button key={r.roomId} className={`pick ${r.roomId === roomId ? 'on' : ''}`} onClick={() => navigate(`/rooms/${encodeURIComponent(r.roomId)}`)} aria-current={r.roomId === roomId}>
									<div className="row">
										<span className="mono">{r.roomId}</span>
										<StatusIcon level={r.ingest === 'loss' ? 'warn' : r.ingest === 'idle' ? 'info' : 'ok'} label={r.ingest} />
									</div>
									<div className="small muted">
										broadcaster {r.broadcasters} · viewer {int(r.viewerCount)}
									</div>
								</button>
							))}
						</div>
					)}
				</Panel>

				<div>
					{!roomId ? (
						<div className="card">{rooms?.ok ? <Empty kind="rooms" /> : <Skeleton slow={list.slow} />}</div>
					) : (
						<RoomDetail roomId={roomId} page={detail} range={range} />
					)}
				</div>
			</div>
		</StaleScope>
	);
}

function RoomDetail({ roomId, page, range }: { roomId: string; page: ReturnType<typeof usePage>; range: string }) {
	const { meta, p } = page;
	const header = p('header');
	const viewers = p('viewers');

	if (header && !header.ok) {
		return (
			<div className="card">
				<div className="panel-na">⊖ {header.error}</div>
			</div>
		);
	}

	return (
		<>
			<div className="page-head" style={{ marginBottom: 12 }}>
				<h2 className="mono" style={{ margin: 0, fontSize: 20 }}>
					{roomId}
				</h2>
				{header?.ok && (
					<div className="subline" style={{ marginTop: 0 }}>
						<span>
							경과 <b>{duration(since(header.data.createdAt))}</b>
						</span>
						<span>
							이 서버 viewers <b>{int(header.data.viewerCount)}</b>
						</span>
						<span>
							전달 edge <b>{header.data.edgeCount}</b>
						</span>
					</div>
				)}
			</div>

			<Panel panel={p('broadcasters')} meta={meta} slow={page.slow} bare empty={{ when: (d: any[]) => d.length === 0, kind: 'broadcasters' }}>
				{(list: any[]) => (
					<div className="grid g2" style={{ margin: 0 }}>
						{list.map(b => (
							<BroadcasterCard key={b.broadcasterId} b={b} meta={meta} />
						))}
					</div>
				)}
			</Panel>

			<Panel title="입력 bitrate (Mbps)" right={`이 방송 · 최근 ${range}`} panel={p('bitrateSeries')} meta={meta} slow={page.slow}>
				{(pts: any[]) => (
					<LineChart
						series={[{ label: '입력', points: pts.map(x => ({ t: x.t, v: x.inBitrateBps === null ? null : x.inBitrateBps / 1e6 })) }]}
						height={180}
						format={v => v.toFixed(1)}
						xLabel={[`-${range}`, 'now']}
					/>
				)}
			</Panel>

			<div style={{ height: 16 }} />
			<Panel
				title={p('edges')?.ok ? `이 방송을 받는 edge ${(p('edges') as any).data.length}` : '이 방송을 받는 edge'}
				right="origin → edge pipe"
				panel={p('edges')}
				meta={meta}
				slow={page.slow}
				empty={{ when: (d: any[]) => d.length === 0, kind: 'edges' }}
			>
				{(cells: any[]) => (
					<>
						<div className="table-wrap">
							<table className="t">
								<thead>
									<tr>
										<th>Edge</th>
										<th>상태</th>
										<th className="num">송신</th>
										<th className="num">
											<span title="edge가 RTCP RR로 origin에 알려준 유실 비율입니다. broadcaster 입력 유실도 포함됩니다.">수신 측 보고 loss</span>
										</th>
										<th className="num">RTT</th>
										<th className="num">대시보드</th>
									</tr>
								</thead>
								<tbody>
									{cells.map(c => (
										<tr key={c.edgeId}>
											<td>{c.edgeId}</td>
											<td className="text">{c.linkState === 'connected' ? <EdgeState state={c.edgeState} reason={c.edgeReason} /> : <Status level="crit">pipe 닫힘</Status>}</td>
											<td className="num">{bps(c.bitrateBps)}</td>
											<td className="num">
												<Flagged level={levelOf(c.lossRatio, 0.02)}>{pct(c.lossRatio)}</Flagged>
											</td>
											<td className="num">{ms(c.rttMs)}</td>
											<td className="num">
												<OpenEdge url={c.dashboardUrl} state={c.edgeState} />
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
						<div className="card-note">"수신 측 보고 loss"는 edge가 RTCP로 origin에 알려 준 값입니다. edge의 세부 상태는 각 edge 대시보드에서 확인하세요.</div>
					</>
				)}
			</Panel>

			<div style={{ height: 16 }} />
			<section className="card">
				{!viewers ? (
					<Skeleton lines={1} />
				) : !viewers.ok ? (
					<div className="panel-error">▲ {viewers.error}</div>
				) : (
					<div className="grid g3 stale-dim" style={{ margin: 0, alignItems: 'end' }}>
						<div>
							<div className="small muted">이 서버 viewers (이 방송)</div>
							<div className="mono" style={{ fontSize: 22 }}>
								{int(viewers.data.viewers)}
							</div>
						</div>
						<div>
							<div className="small muted">
								<LossTitle text="Viewer loss p50" />
							</div>
							<div className="mono" style={{ fontSize: 22 }}>
								{pct(viewers.data.lossP50)}
							</div>
						</div>
						<div>
							<div className="small muted">loss 5% 이상 viewer</div>
							<div className="mono" style={{ fontSize: 22 }}>
								{pct(viewers.data.badRatio)}
							</div>
						</div>
					</div>
				)}
			</section>
		</>
	);
}

function BroadcasterCard({ b, meta }: { b: any; meta: any }) {
	const sending = b.state === 'sending';
	const layers: any[] = b.live?.layers ?? [];
	const maxBitrate = Math.max(1, ...layers.map(l => l.bitrateBps ?? 0));
	const report = b.report;

	return (
		<div className="card" style={{ marginBottom: 16 }}>
			<div className="card-head" style={{ marginBottom: 8 }}>
				<span style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
					<Link to={`/broadcasters/${encodeURIComponent(b.broadcasterId)}`} className="mono" style={{ fontSize: 16 }}>
						{b.displayName ?? b.broadcasterId}
					</Link>
					{sending ? <Status level="ok">송출 중</Status> : <span className="muted small">○ 대기 (송출 없음)</span>}
				</span>
				<span className="small muted">접속 {duration(since(b.connectedAt))}</span>
			</div>
			{sending ? (
				<>
					<div className="kv-2">
						<div>
							<div className="l">전송 RTT</div>
							<div className="v">{ms(b.live?.rttMs)}</div>
						</div>
						<div>
							<div className="l">입력 bitrate</div>
							<div className="v">{bps(b.bitrateBps)}</div>
						</div>
						<div>
							<div className="l">
								인코더 fps <Mock meta={meta} fields={['broadcaster_sample.fps']} />
							</div>
							<div className="v">{b.fps === null ? '—' : `${Math.round(b.fps)} / 30`}</div>
						</div>
						<div>
							<div className="l">
								<LossTitle text="전송 loss" />
							</div>
							<div className="v">
								<Flagged level={levelOf(b.lossRatio, 0.02)}>{pct(b.lossRatio)}</Flagged>
							</div>
						</div>
					</div>
					{layers.length > 0 && (
						<>
							<div className="section-label">Simulcast 레이어</div>
							<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
								{[...layers].reverse().map((l, i) => (
									<div key={i}>
										<div className="mono small" style={{ display: 'flex', justifyContent: 'space-between' }}>
											<span>{l.layer ?? '단일'}</span>
											<span>{(l.bitrateBps ?? 0) > 0 ? bps(l.bitrateBps) : <span className="warn">▲ 중단</span>}</span>
										</div>
										<div className="bar" style={{ height: 4 }}>
											<span style={{ width: `${((l.bitrateBps ?? 0) / maxBitrate) * 100}%` }} />
										</div>
									</div>
								))}
							</div>
						</>
					)}
					<div style={{ marginTop: 12 }}>
						<Link to={`/broadcasters/${encodeURIComponent(b.broadcasterId)}`}>송출 상세 보기 →</Link>
					</div>
				</>
			) : (
				<>
					<div className="small muted" style={{ marginBottom: 12 }}>
						접속은 되어 있지만 producer의 송출이 멈췄습니다. 송출을 다시 시작하면 이 카드에 입력 상태가 표시됩니다.
					</div>
					<div className="kv-2">
						<div>
							<div className="l">Transport</div>
							<div className="v">
								send · {b.live?.transport?.dtlsState ?? b.live?.transport?.type ?? '—'}
							</div>
						</div>
						<div>
							<div className="l">RTT</div>
							<div className="v">{ms(b.live?.rttMs)}</div>
						</div>
						<div>
							<div className="l">환경</div>
							<div className="v">{[b.live?.browser, b.live?.remoteIp].filter(Boolean).join(' · ') || '—'}</div>
						</div>
					</div>
				</>
			)}
		</div>
	);
}
