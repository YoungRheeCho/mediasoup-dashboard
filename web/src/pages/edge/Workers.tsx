import { Findings } from '../../components/Blocks';
import { Sparkline } from '../../components/Charts';
import { PageHeader, RangeTabs, StaleScope } from '../../components/Layout';
import { Panel } from '../../components/Panel';
import { Status } from '../../components/Status';
import { ago, bytes, duration, int, since } from '../../lib/format';
import { usePage, useRange } from '../../lib/usePage';

export function EdgeWorkers() {
	const [range, setRange] = useRange('5m');
	const page = usePage(`/api/edge/workers?range=${range}`, 10);
	const { meta, p } = page;

	return (
		<StaleScope meta={meta} lastFetchAt={page.lastSuccessAt} refreshSeconds={10}>
			<PageHeader
				title="Workers"
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
				Worker는 mediasoup이 띄운 프로세스 하나(CPU 코어 1개)입니다. 이 서버에서 부하가 어디로 쏠리는지, 새 router를 어느 worker에 둘지 판단하는 화면입니다.
			</p>

			<Panel panel={p('workers')} meta={meta} slow={page.slow} bare>
				{(workers: any[]) => (
					<div className="grid g3" style={{ margin: 0 }}>
						{workers.map(w => (
							<div key={w.workerIdx} className={`card ${w.status === 'no_response' ? 'alert-warn' : ''}`}>
								<div className="card-head" style={{ marginBottom: 4 }}>
									<span className="mono">w{w.workerIdx}</span>
									<span className="small">
										{w.status === 'no_response' ? (
											<Status level="warn">응답 없음</Status>
										) : w.restarts > 0 ? (
											<Status level="warn">
												재시작 {w.restarts}회 ({ago(since(w.lastRestartAt))})
											</Status>
										) : (
											<Status level="ok">running</Status>
										)}
									</span>
								</div>
								<div className="k-value mono" style={{ fontSize: 30, display: 'flex', alignItems: 'baseline', gap: 6 }}>
									{w.cpuPct === null ? '—' : Math.round(w.cpuPct)} <span className="k-unit muted small">% CPU</span>
								</div>
								<Sparkline points={w.series.map((s: any) => s.cpuPct)} max={100} />
								<div className="kv-2" style={{ marginTop: 12, fontSize: 12 }}>
									<span className="muted">router {w.routerCount}</span>
									<span className="muted">consumers {int(w.consumerCount)}</span>
									<span className="muted">transports {int(w.transportCount)}</span>
									<span className="muted">producers {int(w.producerCount)}</span>
									<span className="muted">메모리 {bytes(w.memRssBytes)}</span>
									<span className="muted" title="사이드카가 관측을 시작한 이후">관측 {duration(since(w.observedSinceAt))}</span>
								</div>
							</div>
						))}
					</div>
				)}
			</Panel>

			<div className="grid g-wide-l">
				<Panel title="Router 배치" right="블록 높이 = consumers 수" panel={p('placement')} meta={meta} slow={page.slow}>
					{(cols: any[]) => {
						const max = Math.max(1, ...cols.map(c => c.routers.reduce((a: number, r: any) => a + r.consumerCount, 0)));
						const split = new Map<string, number>();

						cols.forEach(c => c.routers.forEach((r: any) => split.set(r.roomId, (split.get(r.roomId) ?? 0) + 1)));

						return (
							<>
								<div className="placement" style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(0, 1fr))` }}>
									{cols.map(c => (
										<div key={c.workerIdx}>
											<div className="col">
												{c.routers.map((r: any) => (
													<div
														key={r.routerId}
														className="blk"
														title={`${r.roomId} · consumers ${r.consumerCount} · viewers ${r.viewerCount}`}
														style={{ height: `${Math.max(14, (r.consumerCount / max) * 100)}%`, background: (split.get(r.roomId) ?? 0) > 1 ? 'var(--blue-2)' : 'var(--blue-3)' }}
													>
														{r.roomId}
														{(split.get(r.roomId) ?? 0) > 1 ? ' ⧉' : ''}
														<br />
														{int(r.consumerCount)}
													</div>
												))}
											</div>
											<div className="foot">
												w{c.workerIdx} · {c.cpuPct === null ? '—' : `${Math.round(c.cpuPct)}%`}
											</div>
										</div>
									))}
								</div>
								{[...split].some(([, n]) => n > 1) && (
									<div className="card-note">
										⧉ 표시는 한 방송이 여러 worker의 router에 나뉘어 담긴 경우입니다. 이 router들은 같은 pipe에서 piped producer를 공유합니다.
									</div>
								)}
							</>
						);
					}}
				</Panel>
				<Panel title="배치 권장" panel={p('advice')} meta={meta} slow={page.slow}>
					{(items: any[]) => <Findings items={items} meta={meta} />}
				</Panel>
			</div>

			<Panel title="리소스 상세" right="worker.getResourceUsage()" panel={p('resources')} meta={meta} slow={page.slow}>
				{(rows: any[]) => (
					<div className="table-wrap">
						<table className="t">
							<thead>
								<tr>
									<th>Worker</th>
									<th className="num">CPU user</th>
									<th className="num">CPU sys</th>
									<th className="num">maxrss</th>
									<th className="num">컨텍스트 스위치 / s</th>
									<th className="num">재시작 (관측 이후)</th>
								</tr>
							</thead>
							<tbody>
								{rows.map(r => (
									<tr key={r.workerIdx}>
										<td>w{r.workerIdx}</td>
										<td className="num">{r.cpuUserPct === null ? '—' : `${Math.round(r.cpuUserPct)}%`}</td>
										<td className="num">{r.cpuSysPct === null ? '—' : `${Math.round(r.cpuSysPct)}%`}</td>
										<td className="num">{bytes(r.maxRssBytes)}</td>
										<td className="num">{int(r.contextSwitchesPerSec)}</td>
										<td className="num">{r.restarts > 0 ? <span className="warn">▲ {r.restarts}</span> : '0'}</td>
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
