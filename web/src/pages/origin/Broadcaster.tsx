import { Link, useParams } from 'react-router-dom';

import { Events, Findings, Kpi, Timeline } from '../../components/Blocks';
import { LineChart } from '../../components/Charts';
import { PageHeader, RangeTabs, StaleScope } from '../../components/Layout';
import { Panel } from '../../components/Panel';
import { Flagged, Mock, Status, levelOf } from '../../components/Status';
import { bps, bpsParts, duration, ms, pct, since } from '../../lib/format';
import { usePage, useRange } from '../../lib/usePage';
import { LossTitle } from '../edge/Overview';

export function OriginBroadcaster() {
	const { broadcasterId = '' } = useParams();
	const [range, setRange] = useRange('5m');
	const id = encodeURIComponent(broadcasterId);
	// 상세는 화면이 열린 동안 2초 갱신 (AGENT_TASK 3-8). 추이(DB)는 수집 주기에 맞춰 10초.
	const page = usePage(`/api/origin/broadcasters/${id}?range=${range}`, 10);
	const live = usePage(`/api/origin/broadcasters/${id}/live`, 2);
	const { meta, p } = page;
	const session = p('session');
	const lvPanel = live.p('live');
	const lv = lvPanel?.ok ? lvPanel.data : null;
	const s = session?.ok ? session.data : null;
	const report = p('clientReport');
	const rep = report?.ok ? report.data : null;
	const xLabel: [string, string] = [range === 'session' ? '접속' : `-${range}`, 'now'];
	const diagnosis = p('diagnosis');
	const bad = diagnosis?.ok && diagnosis.data.some((f: any) => f.level === 'warn' || f.level === 'crit');

	if (page.status === 404) {
		return (
			<>
				<div className="crumb">
					<Link to="/rooms">Rooms & Broadcasters</Link>
				</div>
				<div className="card">
					<div className="panel-na">⊖ 이 broadcaster를 찾을 수 없습니다. 보관 기간이 지났거나 주소가 잘못되었습니다.</div>
				</div>
			</>
		);
	}

	const stateBadge = !s ? null : s.disconnectedAt ? (
		<span className="tag">접속 종료</span>
	) : s.state === 'sending' ? (
		<span className={`tag ${bad ? 'status-warn' : 'status-ok'}`}>{bad ? '▲ 송출 중 · 주의' : '● 송출 중 · 정상'}</span>
	) : (
		<span className="tag">○ 대기 (송출 없음)</span>
	);

	return (
		<StaleScope meta={live.meta ?? meta} lastFetchAt={live.lastSuccessAt ?? page.lastSuccessAt} refreshSeconds={2}>
			<PageHeader
				crumb={
					<>
						<Link to="/rooms">Rooms & Broadcasters</Link> › {s ? <Link to={`/rooms/${encodeURIComponent(s.roomId)}`}>{s.roomId}</Link> : '…'} › {s?.displayName ?? '…'}
					</>
				}
				title={s?.displayName ?? '…'}
				mono
				badge={stateBadge}
				meta={live.meta ?? meta}
				refreshSeconds={2}
				paused={live.paused}
				lastFetchAt={live.lastSuccessAt}
				subline={
					s && (
						<>
							<span>
								방송 <b>{s.roomId}</b>
							</span>
							<span>
								Router <b>w{s.workerIdx ?? '?'}</b>
							</span>
							<span>
								접속 <b>{duration(since(s.connectedAt))}</b>
							</span>
							{s.live?.browser && <span>{s.live.browser}</span>}
							{s.live?.remoteIp && (
								<span>
									IP <b>{s.live.remoteIp}</b>
								</span>
							)}
						</>
					)
				}
				right={
					<RangeTabs
						value={range}
						options={[
							['5m', '5m'],
							['1h', '1h'],
							['session', '방송 전체'],
						]}
						onChange={setRange}
					/>
				}
			/>

			<Panel title="진단 요약" panel={diagnosis} meta={meta} slow={page.slow}>
				{(items: any[]) => <Findings items={items} meta={meta} />}
			</Panel>

			<div style={{ height: 16 }} />
			<div className="grid g3">
				<Kpi
					label="송출 상태"
					value={s ? (s.disconnectedAt ? '종료' : s.state === 'sending' ? '송출 중' : '대기') : null}
					level={s && !s.disconnectedAt && s.state !== 'sending' ? 'warn' : undefined}
					sub={s?.live ? `${s.live.kinds.join(' + ')}${s.live.layers.length > 1 ? ` · video ${s.live.layers.length} 레이어` : ''}` : undefined}
				/>
				<Kpi
					label="입력 bitrate"
					value={bpsParts(lv?.bitrateBps ?? s?.bitrateBps)[0]}
					unit={bpsParts(lv?.bitrateBps ?? s?.bitrateBps)[1]}
					sub={
						rep?.availableOutgoingBitrateBps ? (
							<>
								브라우저 추정 가용 {bps(rep.availableOutgoingBitrateBps)} <Mock meta={meta} fields={['broadcaster_report.*']} />
							</>
						) : undefined
					}
				/>
				<Kpi
					label="인코더 fps"
					mock={<Mock meta={meta} fields={['broadcaster_sample.fps']} />}
					value={lv?.fps ?? s?.fps ?? null}
					unit="/ 30"
					sub={rep ? (rep.qualityLimitationReason === 'none' ? '품질 제한 없음' : `▲ ${rep.qualityLimitationReason} 제한`) : undefined}
				/>
				<Kpi label="해상도" mock={<Mock meta={meta} fields={['broadcaster_report.*']} />} value={rep?.resolution ?? null} sub={rep ? `카메라 ${rep.camera}` : undefined} />
				<Kpi
					label={<LossTitle text="전송 loss / RTT" />}
					level={levelOf(s?.lossRatio, 0.02, 0.05)}
					value={pct(s?.lossRatio)}
					unit={`/ ${ms(lv?.rttMs ?? s?.live?.rttMs)}`}
					sub={`jitter ${ms(lv?.jitterMs)}`}
				/>
				<Panel panel={p('serverValues')} meta={meta} slow={page.slow} bare>
					{(v: any) => <Kpi label="Keyframe 요청 (PLI)" value={v.pliPerMin ?? '—'} unit="회/분" sub={`NACK ${v.nackPerMin ?? '—'}회/분`} />}
				</Panel>
			</div>

			<Panel title={`타임라인 (${range === 'session' ? '방송 전체' : `최근 ${range}`})`} right={<span className="legend" style={{ margin: 0 }}>■ 정상 ■ 레이어 중단</span>} panel={p('timeline')} meta={meta} slow={page.slow}>
				{(rows: any[]) => (
					<Timeline
						times={rows.map(r => r.t)}
						lanes={[
							{ label: '송출 상태', values: rows.map(r => (r.sending ? 'sending' : 'idle')), colors: { sending: 'var(--blue)', idle: 'var(--seg-neutral)' }, names: { sending: '송출 중', idle: '송출 없음' } },
							{
								label: '레이어',
								values: rows.map(r => (r.layersActive === null ? null : r.maxLayers && r.layersActive < r.maxLayers ? 'partial' : 'full')),
								colors: { full: 'var(--blue)', partial: 'var(--yellow)' },
								names: { full: '전체 활성', partial: '일부 중단' },
							},
						]}
					/>
				)}
			</Panel>

			<div style={{ height: 16 }} />
			<div className="grid g2">
				<Panel title="입력 bitrate (Mbps)" right={<span className="chart-value">{bps(lastOf(p('series'), 'bitrateBps'))}</span>} panel={p('series')} meta={meta} slow={page.slow}>
					{(d: any) => <LineChart series={[{ label: 'bitrate', points: d.points.map((x: any) => ({ t: x.t, v: x.bitrateBps === null ? null : x.bitrateBps / 1e6 })) }]} height={120} format={v => v.toFixed(1)} xLabel={xLabel} />}
				</Panel>
				<Panel title={<LossTitle text="전송 loss (%)" />} right={<span className="chart-value">{pct(lastOf(p('series'), 'lossRatio'))}</span>} panel={p('series')} meta={meta} slow={page.slow}>
					{(d: any) => <LineChart series={[{ label: 'loss', points: d.points.map((x: any) => ({ t: x.t, v: x.lossRatio === null ? null : x.lossRatio * 100 })) }]} height={120} format={v => v.toFixed(1)} xLabel={xLabel} />}
				</Panel>
				<Panel title="RTT (ms)" right={<span className="chart-value">{ms(lastOf(p('series'), 'rttMs'))}</span>} panel={p('series')} meta={meta} slow={page.slow}>
					{(d: any) => <LineChart series={[{ label: 'RTT', points: d.points.map((x: any) => ({ t: x.t, v: x.rttMs })) }]} height={120} format={v => String(Math.round(v))} xLabel={xLabel} />}
				</Panel>
				<Panel title="인코더 fps" mockFields={['broadcaster_sample.fps']} right={<span className="chart-value">{lastOf(p('series'), 'fps')?.toFixed(1) ?? '—'}</span>} panel={p('series')} meta={meta} slow={page.slow}>
					{(d: any) => <LineChart series={[{ label: 'fps', points: d.points.map((x: any) => ({ t: x.t, v: x.fps })) }]} height={120} yMax={30} format={v => String(Math.round(v))} xLabel={xLabel} />}
				</Panel>
			</div>

			<div className="grid g-wide-r">
				<Panel title="이 broadcaster의 이벤트" panel={p('events')} meta={meta} slow={page.slow}>
					{(items: any[]) => <Events items={items} meta={meta} withSeconds />}
				</Panel>
				<section className="card">
					<div className="grid g2" style={{ margin: 0 }}>
						<div>
							<div className="section-label" style={{ marginTop: 0 }}>
								서버가 본 값 (producer)
							</div>
							<Panel panel={p('serverValues')} meta={meta} slow={page.slow} bare>
								{(v: any) => (
									<dl className="kv">
										<dt>입력 패킷 손실</dt>
										<dd>
											<Flagged level={levelOf(v.lossRatio, 0.02)}>{pct(v.lossRatio)}</Flagged>
										</dd>
										{v.layers.length > 0 && (
											<>
												<dt>레이어 bitrate</dt>
												<dd>{v.layers.map((l: any) => bps(l.bitrateBps).replace(' ', '')).join(' / ')}</dd>
											</>
										)}
										<dt>RTP jitter</dt>
										<dd>{ms(v.jitterMs)}</dd>
										<dt>NACK 수신 / 분</dt>
										<dd>{v.nackPerMin ?? '—'}</dd>
										<dt>PLI 수신 / 분</dt>
										<dd>{v.pliPerMin ?? '—'}</dd>
										<dt>Transport</dt>
										<dd>
											send · {v.transport?.dtlsState ?? v.transport?.type ?? '—'}
										</dd>
									</dl>
								)}
							</Panel>
							<div className="section-label">전달</div>
							<Panel panel={p('delivery')} meta={meta} slow={page.slow} bare>
								{(d: any) => (
									<dl className="kv">
										<dt>이 서버 viewers</dt>
										<dd>{d.viewers ?? '—'}</dd>
										<dt>전달 edge</dt>
										<dd>
											{d.edges}
											{d.sendBitrateBps.length ? ` (각 ${bps(Math.max(...d.sendBitrateBps.filter((x: any) => x !== null)))})` : ''}
										</dd>
									</dl>
								)}
							</Panel>
							<div style={{ marginTop: 8 }}>
								<Link to="/edges">Connected Edges 보기 →</Link>
							</div>
						</div>
						<div>
							<div className="section-label" style={{ marginTop: 0 }}>
								브라우저가 보고한 값 <Mock meta={meta} fields={['broadcaster_report.*']} />
							</div>
							{rep ? (
								<dl className="kv">
									<dt>품질 제한 사유</dt>
									<dd>{rep.qualityLimitationReason}</dd>
									<dt>제한 누적 (bandwidth / cpu)</dt>
									<dd>
										{rep.qualityLimitationSeconds.bandwidth} s / {rep.qualityLimitationSeconds.cpu} s
									</dd>
									<dt>가용 송신 대역폭</dt>
									<dd>{bps(rep.availableOutgoingBitrateBps)}</dd>
									<dt>인코더</dt>
									<dd>{rep.encoder}</dd>
									<dt>카메라</dt>
									<dd>{rep.camera}</dd>
									<dt>마이크</dt>
									<dd>{rep.microphone}</dd>
								</dl>
							) : (
								<div className="small muted">⊖ 브라우저 보고 없음 (클라이언트가 서버로 보내지 않음)</div>
							)}
							<div className="section-label">실시간 (2초)</div>
							{lvPanel && !lvPanel.ok ? (
								<div className="small muted">⊖ {lvPanel.error}</div>
							) : (
								<dl className="kv">
									<dt>입력 bitrate</dt>
									<dd>{bps(lv?.bitrateBps)}</dd>
									<dt>레이어</dt>
									<dd>{lv?.layers?.map((l: any) => `${l.layer} ${bps(l.bitrateBps)}`).join(' · ') || '—'}</dd>
									<dt>Transport</dt>
									<dd>{lv?.transports?.[0] ? <Status level={lv.transports[0].dtlsState === 'connected' || !lv.transports[0].dtlsState ? 'ok' : 'warn'}>{lv.transports[0].dtlsState ?? 'plain'}</Status> : '—'}</dd>
								</dl>
							)}
						</div>
					</div>
				</section>
			</div>
		</StaleScope>
	);
}

function lastOf(panel: any, key: string): any {
	return panel?.ok ? ([...panel.data.points].reverse().find((x: any) => x[key] !== null)?.[key] ?? null) : null;
}
