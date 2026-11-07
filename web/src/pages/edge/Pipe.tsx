import { COLORS, LineChart } from '../../components/Charts';
import { PageHeader, RangeTabs, StaleScope } from '../../components/Layout';
import { Panel } from '../../components/Panel';
import { Flagged, Status, levelOf } from '../../components/Status';
import { bps, ms, pct } from '../../lib/format';
import { usePage, useRange } from '../../lib/usePage';
import { LossTitle } from './Overview';

export function EdgePipe() {
	const [range, setRange] = useRange('5m');
	const page = usePage(`/api/edge/pipe?range=${range}`, 10);
	const { meta, p } = page;
	const series = p('series');
	const xLabel: [string, string] = [`-${range}`, 'now'];
	const last = (key: string) => (series?.ok ? ([...series.data.points].reverse().find((x: any) => x[key] !== null)?.[key] ?? null) : null);

	return (
		<StaleScope meta={meta} lastFetchAt={page.lastSuccessAt} refreshSeconds={10}>
			<PageHeader
				title="Pipe 수신"
				meta={meta}
				refreshSeconds={10}
				paused={page.paused}
				lastFetchAt={page.lastSuccessAt}
				right={
					<RangeTabs
						value={range}
						options={[
							['5m', '5m'],
							['1h', '1h'],
							['6h', '6h'],
						]}
						onChange={setRange}
					/>
				}
			/>
			<p className="page-desc">
				origin에서 이 서버로 들어오는 PipeTransport 구간의 품질입니다. 이 구간이 나빠지면 이 서버의 모든 viewer가 영향을 받으므로 가장 먼저 확인해야 하는 화면입니다.
			</p>

			<Panel panel={p('status')} meta={meta} slow={page.slow} bare skeletonLines={1}>
				{(s: any) => (
					<div className="band" style={{ margin: 0 }}>
						<span>
							<span className="small">상태</span>
							<br />
							{s.state === 'connected' ? <Status level="ok">connected</Status> : <Status level="warn">pipe 없음</Status>}
						</span>
						<span>
							<span className="small">상대</span>
							<br />
							<span className="mono" style={{ color: 'var(--text)' }}>
								{s.originUrl ? new URL(s.originUrl).host : 'origin'}
							</span>
						</span>
						<span style={{ minWidth: 0 }}>
							<span className="small">경로</span>
							<br />
							<span className="mono" style={{ color: 'var(--text)' }}>
								{s.pipes[0] ? `${s.pipes[0].remote ?? '?'} → ${s.pipes[0].local ?? '?'}` : '—'}
								{s.pipes.length > 1 ? ` 외 ${s.pipes.length - 1}` : ''}
							</span>
						</span>
						<span>
							<span className="small">pipe 수</span>
							<br />
							<span className="mono" style={{ color: 'var(--text)' }}>
								방송별 1개 · 총 {s.total}
							</span>
						</span>
					</div>
				)}
			</Panel>

			<div className="grid g3">
				<Panel title={<LossTitle text="Loss (%)" />} right={<ValueFlag v={last('lossRatio')} warn={series?.ok ? series.data.threshold : 0.02} pctValue />} panel={series} meta={meta} slow={page.slow}>
					{(d: any) => (
						<>
							<LineChart
								series={[
									{ label: '원본 loss', points: d.points.map((x: any) => ({ t: x.t, v: x.lossRatio === null ? null : x.lossRatio * 100 })) },
									{ label: '복구 후', color: COLORS.green, dashed: true, points: d.points.map((x: any) => ({ t: x.t, v: x.recoveredLossRatio === null ? null : x.recoveredLossRatio * 100 })) },
								]}
								threshold={d.threshold * 100}
								format={v => v.toFixed(1)}
								xLabel={xLabel}
								height={120}
							/>
							<div className="legend">
								<span>
									<span className="swatch" style={{ background: COLORS.blue }} />
									원본
								</span>
								<span>
									<span className="swatch" style={{ background: COLORS.green }} />
									복구 후 (RTX)
								</span>
							</div>
						</>
					)}
				</Panel>
				<Panel title="RTT (ms)" right={<span className="chart-value">{ms(last('rttMs'))}</span>} panel={series} meta={meta} slow={page.slow}>
					{(d: any) => <LineChart series={[{ label: 'RTT', points: d.points.map((x: any) => ({ t: x.t, v: x.rttMs })) }]} format={v => String(Math.round(v))} xLabel={xLabel} height={120} />}
				</Panel>
				<Panel title="Jitter (ms)" right={<span className="chart-value">{ms(last('jitterMs'))}</span>} panel={series} meta={meta} slow={page.slow}>
					{(d: any) => <LineChart series={[{ label: 'jitter', points: d.points.map((x: any) => ({ t: x.t, v: x.jitterMs })) }]} format={v => String(Math.round(v))} xLabel={xLabel} height={120} />}
				</Panel>
				<Panel title="수신 bitrate (Mbps)" right={<span className="chart-value">{bps(last('bitrateBps'))}</span>} panel={series} meta={meta} slow={page.slow}>
					{(d: any) => (
						<LineChart
							series={[{ label: 'bitrate', points: d.points.map((x: any) => ({ t: x.t, v: x.bitrateBps === null ? null : x.bitrateBps / 1e6 })) }]}
							format={v => v.toFixed(1)}
							xLabel={xLabel}
							height={120}
						/>
					)}
				</Panel>
			</div>

			<div className="grid g-wide-l">
				<Panel title="스트림별 수신 통계" right="RTP inbound · 최근 수집 구간" panel={p('streams')} meta={meta} slow={page.slow} empty={{ when: (d: any[]) => d.length === 0, kind: 'rooms' }}>
					{(rows: any[]) => {
						const worst = [...rows].filter(r => r.lossRatio !== null).sort((a, b) => b.lossRatio - a.lossRatio)[0];

						return (
							<>
								<div className="table-wrap">
									<table className="t">
										<thead>
											<tr>
												<th>Stream</th>
												<th>방송</th>
												<th className="num">Bitrate</th>
												<th className="num">Lost</th>
												<th className="num">Jitter</th>
												<th className="num">NACK / 분</th>
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
													<td>{s.roomId ?? '—'}</td>
													<td className="num">{bps(s.bitrateBps)}</td>
													<td className="num">
														<Flagged level={levelOf(s.lossRatio, 0.02)}>{pct(s.lossRatio)}</Flagged>
													</td>
													<td className="num">{ms(s.jitterMs)}</td>
													<td className="num">{s.nackPerMin === null ? '—' : Math.round(s.nackPerMin)}</td>
													<td className="num">{s.pliPerMin === null ? '—' : Math.round(s.pliPerMin)}</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
								{worst && worst.lossRatio >= 0.02 && (
									<div className="card-note">
										▲ {worst.roomId} {worst.kind}
										{worst.layer ? ` ${worst.layer}` : ''} 스트림의 손실이 가장 큽니다 ({pct(worst.lossRatio)}). 대역폭 한계나 혼잡, 또는 origin 입력 유실을 의심해 볼 수 있습니다.
									</div>
								)}
							</>
						);
					}}
				</Panel>
				<Panel title="Origin 측 값과 비교" panel={p('originComparison')} meta={meta} slow={page.slow}>
					{() => null}
				</Panel>
			</div>
		</StaleScope>
	);
}

function ValueFlag({ v, warn, pctValue }: { v: number | null; warn: number; pctValue?: boolean }) {
	return (
		<span className="chart-value">
			<Flagged level={levelOf(v, warn)}>{pctValue ? pct(v) : v}</Flagged>
		</span>
	);
}
