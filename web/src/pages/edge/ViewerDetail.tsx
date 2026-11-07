import { Link, useParams } from 'react-router-dom';

import { Events, Findings, Kpi, Timeline } from '../../components/Blocks';
import { LineChart } from '../../components/Charts';
import { PageHeader, RangeTabs, StaleScope } from '../../components/Layout';
import { Panel, Skeleton } from '../../components/Panel';
import { Flagged, Mock, levelOf } from '../../components/Status';
import { bps, bpsParts, duration, layerLabel, ms, pct, shortId } from '../../lib/format';
import { usePage, useRange } from '../../lib/usePage';
import { LossTitle } from './Overview';

const LAYER_COLORS = { 'L2(High)': 'var(--blue)', 'L1(Mid)': 'var(--blue-2)', 'L0(Low)': 'var(--blue-3)' };
const PLAYBACK = { playing: 'var(--blue)', buffering: 'var(--yellow)', freeze: 'var(--red)' };
const PLAYBACK_NAME = { playing: '재생', buffering: '버퍼링', freeze: 'Freeze' };

export function EdgeViewerDetail() {
	const { viewerId = '' } = useParams();
	const [range, setRange] = useRange('5m');
	const id = encodeURIComponent(viewerId);
	// 상세는 화면이 열린 동안 2초 갱신 (AGENT_TASK 3-8). 추이(DB)는 수집 주기에 맞춰 10초.
	const page = usePage(`/api/edge/viewers/${id}?range=${range}`, 10);
	const live = usePage(`/api/edge/viewers/${id}/live`, 2);
	const { meta, p } = page;
	const session = p('session');
	const liveData = live.p('live');
	const lv = liveData?.ok ? liveData.data : null;
	const xLabel: [string, string] = [range === 'session' ? '접속' : `-${range}`, 'now'];

	if (page.status === 404) {
		return (
			<>
				<div className="crumb">
					<Link to="/viewers">Viewers</Link> › {shortId(viewerId)}
				</div>
				<div className="card">
					<div className="panel-na">⊖ 이 viewer를 찾을 수 없습니다. 기록 보관 기간(기본 48시간)이 지났거나 다른 서버의 viewer입니다.</div>
				</div>
			</>
		);
	}

	const s = session?.ok ? session.data : null;
	const diagnosis = p('diagnosis');
	const bad = diagnosis?.ok && diagnosis.data.some((f: any) => f.level === 'warn' || f.level === 'crit');
	// 실시간 브라우저 값: mock은 2초 구간, 실제 보고는 최근 보고 두 개 사이(약 5초) 구간이다.
	const clientMock = lv?.client?.source === 'mock';
	const win = lv?.client?.windowSeconds ?? null;
	const freezePerMin = lv?.client && lv.client.clientFreezeCount !== null && win ? Math.round((lv.client.clientFreezeCount * 60) / win) : null;
	const seriesPanel = p('series');
	const seriesClientMock = Boolean(seriesPanel?.ok && seriesPanel.data.clientMock);
	const winText = win ? `최근 ${win}초` : '구간 계산 중';

	return (
		<StaleScope meta={live.meta ?? meta} lastFetchAt={live.lastSuccessAt ?? page.lastSuccessAt} refreshSeconds={2}>
			<PageHeader
				crumb={
					<>
						<Link to="/viewers">Viewers</Link> › {s?.displayName ?? shortId(viewerId)}
					</>
				}
				title={s?.displayName ?? shortId(viewerId)}
				mono
				badge={bad ? <span className="tag status-warn">▲ 재생 품질 낮음</span> : s?.disconnectedAt ? <span className="tag">접속 종료</span> : null}
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
								접속 <b>{duration(s.connectedSeconds)}</b>
							</span>
							<span>
								{s.environment?.browser ?? '—'} {s.identitySource !== 'peer' && <Mock meta={meta} fields={['viewer_report.browser']} />}
							</span>
							{(s.remoteIp ?? lv?.remoteIp) && (
								<span>
									IP <b>{s.remoteIp ?? lv?.remoteIp}</b>
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
							['session', '접속 전체'],
						]}
						onChange={setRange}
					/>
				}
			/>

			<Panel title="진단 요약" panel={diagnosis} meta={meta} slow={page.slow}>
				{(items: any[]) => <Findings items={items} meta={meta} />}
			</Panel>

			<div style={{ height: 16 }} />
			{!liveData ? (
				<div className="card" style={{ marginBottom: 16 }}>
					<Skeleton lines={2} slow={live.slow} />
				</div>
			) : !liveData.ok ? (
				<div className="card" style={{ marginBottom: 16 }}>
					<div className="panel-na">⊖ 실시간 값: {liveData.error}</div>
				</div>
			) : (
				<div className="grid g3">
					<Kpi
						label="현재 재생 상태"
						mock={clientMock && <Mock meta={meta} fields={['viewer_report.playback_state']} />}
						level={lv?.client?.playbackState === 'freeze' ? 'crit' : lv?.client?.playbackState === 'buffering' ? 'warn' : undefined}
						value={lv?.client ? PLAYBACK_NAME[lv.client.playbackState as keyof typeof PLAYBACK_NAME] : '보고 없음'}
						sub={lv?.transport ? `transport ${lv.transport.dtlsState ?? '—'}` : undefined}
					/>
					<Kpi
						label="디코딩 fps"
						mock={clientMock && <Mock meta={meta} fields={['viewer_sample.client_fps']} />}
						value={lv?.client?.clientFps ?? null}
						unit="/ 30"
						sub={lv?.client ? `dropped ${lv.client.clientFramesDropped ?? '—'} 프레임 (${winText})` : undefined}
					/>
					{/* 레이어는 서버 값(consumer.currentLayers), 해상도는 브라우저 보고(M2)라 mock일 때 배지를 해상도 쪽에만 붙인다. */}
					<Kpi
						label="수신 레이어"
						value={layerLabel(lv?.video?.layer?.spatialLayer)}
						sub={
							lv?.client?.resolution ? (
								<>
									해상도 {lv.client.resolution} {clientMock && <Mock meta={meta} fields={['viewer_report.resolution']} />}
								</>
							) : undefined
						}
					/>
					<Kpi
						label="Freeze"
						mock={clientMock && <Mock meta={meta} fields={['viewer_sample.client_freeze_count']} />}
						level={freezePerMin !== null && freezePerMin >= 2 ? 'crit' : undefined}
						value={freezePerMin === null ? null : `${freezePerMin}회/분`}
						sub={lv?.client && lv.client.clientFreezeMs !== null ? `${winText} ${(lv.client.clientFreezeMs / 1000).toFixed(1)}s` : undefined}
					/>
					<Kpi label="Jitter buffer" mock={clientMock && <Mock meta={meta} fields={['viewer_sample.client_jitter_buffer_ms']} />} value={lv?.client?.clientJitterBufferMs ?? null} unit="ms" />
					<Kpi label="수신 bitrate" value={bpsParts(lv?.video?.bitrateBps)[0]} unit={bpsParts(lv?.video?.bitrateBps)[1]} sub={`서버 측정 · RTT ${ms(lv?.video?.rttMs)}`} />
				</div>
			)}

			<Panel title={`타임라인 (${range === 'session' ? '접속 전체' : '최근 5분'})`} right={<span className="legend" style={{ margin: 0 }}>■ 재생 ■ 버퍼링 ■ Freeze</span>} panel={p('timeline')} meta={meta} slow={page.slow}>
				{(rows: any[]) => (
					<Timeline
						times={rows.map(r => r.t)}
						lanes={[
							{ label: '재생 상태', values: rows.map(r => r.playback), colors: PLAYBACK, names: PLAYBACK_NAME },
							{ label: '수신 레이어', values: rows.map(r => r.layer), colors: LAYER_COLORS },
							{ label: '연결', values: rows.map(r => r.connection), colors: { connected: 'var(--seg-ok)', new: 'var(--seg-neutral)', disconnected: 'var(--yellow)', failed: 'var(--red)' } },
						]}
					/>
				)}
			</Panel>

			<div style={{ height: 16 }} />
			<div className="grid g2">
				<Panel title={<LossTitle text="Loss (%)" />} right={<span className="chart-value">{pct(lastOf(p('series'), 'lossRatio'))}</span>} panel={p('series')} meta={meta} slow={page.slow}>
					{(d: any) => <LineChart series={[{ label: 'loss', points: d.points.map((x: any) => ({ t: x.t, v: x.lossRatio === null ? null : x.lossRatio * 100 })) }]} height={120} format={v => v.toFixed(1)} xLabel={xLabel} />}
				</Panel>
				<Panel title="RTT (ms)" right={<span className="chart-value">{ms(lastOf(p('series'), 'rttMs'))}</span>} panel={p('series')} meta={meta} slow={page.slow}>
					{(d: any) => <LineChart series={[{ label: 'RTT', points: d.points.map((x: any) => ({ t: x.t, v: x.rttMs })) }]} height={120} format={v => String(Math.round(v))} xLabel={xLabel} />}
				</Panel>
				<Panel title="디코딩 fps" mockFields={seriesClientMock ? ['viewer_sample.client_fps'] : undefined} right={<span className="chart-value">{lastOf(p('series'), 'clientFps')?.toFixed(1) ?? '—'}</span>} panel={p('series')} meta={meta} slow={page.slow}>
					{(d: any) => <LineChart series={[{ label: 'fps', points: d.points.map((x: any) => ({ t: x.t, v: x.clientFps })) }]} height={120} yMax={30} format={v => String(Math.round(v))} xLabel={xLabel} />}
				</Panel>
				<Panel title="Jitter buffer (ms)" mockFields={seriesClientMock ? ['viewer_sample.client_jitter_buffer_ms'] : undefined} right={<span className="chart-value">{ms(lastOf(p('series'), 'clientJitterBufferMs'))}</span>} panel={p('series')} meta={meta} slow={page.slow}>
					{(d: any) => <LineChart series={[{ label: 'jitter buffer', points: d.points.map((x: any) => ({ t: x.t, v: x.clientJitterBufferMs })) }]} height={120} format={v => String(Math.round(v))} xLabel={xLabel} />}
				</Panel>
			</div>

			<div className="grid g-wide-r">
				<Panel title="이 viewer의 이벤트" panel={p('events')} meta={meta} slow={page.slow}>
					{(items: any[]) => <Events items={items} meta={meta} withSeconds />}
				</Panel>
				<section className="card">
					<div className="grid g2" style={{ margin: 0 }}>
						<div>
							<div className="section-label" style={{ marginTop: 0 }}>
								서버가 본 값 (consumer)
							</div>
							{lv ? (
								<dl className="kv">
									<dt>
										<LossTitle text="이 viewer loss" />
									</dt>
									<dd>
										<Flagged level={levelOf(lv.video?.lossRatio, 0.05)}>{pct(lv.video?.lossRatio)}</Flagged>
									</dd>
									<dt>현재 레이어 (spatial / temporal)</dt>
									<dd>{lv.video?.layer ? `${layerLabel(lv.video.layer.spatialLayer)} / T${lv.video.layer.temporalLayer ?? '—'}` : '—'}</dd>
									<dt>송신 bitrate</dt>
									<dd>{bps(lv.video?.bitrateBps)}</dd>
									<dt>NACK 수신 / 분</dt>
									<dd>{lv.video?.nackPerMin ?? '—'}</dd>
									<dt>PLI 수신 / 분</dt>
									<dd>{lv.video?.pliPerMin ?? '—'}</dd>
									<dt>Transport</dt>
									<dd>
										recv · {lv.transport?.dtlsState ?? '—'} / ice {lv.transport?.iceState ?? '—'}
									</dd>
								</dl>
							) : (
								<div className="small muted">⊖ 실시간 값 없음</div>
							)}
							<div className="section-label">접속 환경</div>
							{s && (
								<dl className="kv">
									<dt>브라우저</dt>
									<dd>
										{s.environment?.browser ?? '—'} {s.identitySource !== 'peer' && <Mock meta={meta} fields={['viewer_report.browser']} />}
									</dd>
									<dt>접속 IP</dt>
									<dd className="mono">{s.remoteIp ?? lv?.remoteIp ?? '—'}</dd>
									<dt>Transport id</dt>
									<dd title={viewerId}>{shortId(viewerId, 8)}</dd>
								</dl>
							)}
						</div>
						<div>
							<div className="section-label" style={{ marginTop: 0 }}>
								브라우저가 보고한 값 {clientMock && <Mock meta={meta} fields={['viewer_sample.client_fps']} />}
							</div>
							{lv?.client ? (
								<dl className="kv">
									<dt>디코딩 fps</dt>
									<dd>{lv.client.clientFps ?? '—'}</dd>
									<dt>Dropped ({winText})</dt>
									<dd>{lv.client.clientFramesDropped ?? '—'}</dd>
									<dt>Freeze ({winText})</dt>
									<dd>
										{lv.client.clientFreezeCount === null ? '—' : `${lv.client.clientFreezeCount}회 · ${((lv.client.clientFreezeMs ?? 0) / 1000).toFixed(1)}s`}
									</dd>
									<dt>Jitter buffer</dt>
									<dd>{ms(lv.client.clientJitterBufferMs)}</dd>
									<dt>해상도</dt>
									<dd>{lv.client.resolution ?? '—'}</dd>
								</dl>
							) : (
								<div className="small muted">⊖ 브라우저 보고 없음 (클라이언트가 서버로 보내지 않음)</div>
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
