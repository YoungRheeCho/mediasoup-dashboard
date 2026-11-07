import { Link } from 'react-router-dom';

import { PageHeader, RangeTabs, StaleScope } from '../../components/Layout';
import { Big, Card, FlowLink, LevelText, OvPanel, StatCard, lv, type OvLevel } from '../../components/Overview';
import { ago, bps, int, ms, pct, since } from '../../lib/format';
import { usePage, useRange } from '../../lib/usePage';
import { useNow } from '../../lib/usePolling';

/**
 * Edge Overview (handoff/HANDOFF.md). 상태 배너 → 연결 흐름(origin → 이 edge → viewer) → 카드 2개 → 중계 중인 방송 + 참고.
 * 구간 토글(5m/1h/6h)은 "Pipe 수신 loss" 카드의 집계 구간이다.
 */

const RANGES: Array<[string, string]> = [
	['5m', '5m'],
	['1h', '1h'],
	['6h', '6h'],
];

const ROOM_STATE: Record<OvLevel, string> = { ok: '수신 중', warn: '수신 중 · 주의', crit: '수신 중 · 장애', idle: '신호 없음' };

export function EdgeOverview() {
	const [range, setRange] = useRange('5m');
	const page = usePage(`/api/edge/overview?range=${range}`, 10);
	const { meta, p } = page;

	return (
		<StaleScope meta={meta} lastFetchAt={page.lastSuccessAt} refreshSeconds={10}>
			<PageHeader
				title={meta?.serverId ?? '…'}
				mono
				meta={meta}
				refreshSeconds={10}
				paused={page.paused}
				lastFetchAt={page.lastSuccessAt}
				right={<RangeTabs value={range} options={RANGES} onChange={setRange} />}
			/>

			<div className="ov">
				<Card title="연결 흐름" hint="origin → 이 edge → viewer">
					<OvPanel panel={p('flow')} slow={page.slow}>
						{(f: any) => <EdgeFlow f={f} level={p('status')?.ok ? (p('status') as any).data.level : 'ok'} />}
					</OvPanel>
				</Card>

				<OvPanel panel={p('kpi')} slow={page.slow}>
					{(k: any) => (
						<div className="ov-row">
							<StatCard
								label="Pipe 수신 loss"
								value={k.pipe.lossRatio === null ? '—' : (k.pipe.lossRatio * 100).toFixed(1)}
								unit={k.pipe.lossRatio === null ? undefined : '%'}
								level={k.pipe.level !== 'ok' ? k.pipe.level : null}
								sub={k.pipe.level !== 'ok' ? `▲ 알림 발생 중 · 최근 ${range}` : `최근 ${range}`}
							/>
							<StatCard
								label="Workers"
								value={k.workers.running}
								unit={` / ${k.workers.total}`}
								level={k.workers.problems > 0 ? 'warn' : 'ok'}
								sub={k.workers.problems > 0 ? `▲ ${k.workers.problems}개 응답 없음` : '모두 실행 중'}
							/>
						</div>
					)}
				</OvPanel>

				<div className="ov-row">
					<Card title="중계 중인 방송" className="ov-list-card" right={<Link to="/broadcasts">전체 보기 →</Link>}>
						<OvPanel panel={p('rooms')} slow={page.slow}>
							{(d: any) =>
								d.items.length === 0 ? (
									<div className="ov-sub">○ origin에서 받아 오는 방송이 없습니다. 방송이 시작되면 자동으로 나타납니다.</div>
								) : (
									<>
										{d.items.map((r: any) => (
											<Link key={r.roomId} to={`/broadcasts/${encodeURIComponent(r.roomId)}`} className={`ov-item ${lv(r.level)}`}>
												<span className="ov-item-name">{r.roomId}</span>
												<LevelText level={r.level}>{ROOM_STATE[r.level as OvLevel]}</LevelText>
												<span className="ov-item-meta">Viewer {int(r.viewerCount)}</span>
												<span className="ov-item-num" style={r.bitrateBps === null ? { color: 'var(--ov-muted)' } : undefined}>
													{r.bitrateBps === null ? '—' : `${bps(r.bitrateBps)} · loss ${pct(r.lossRatio)}`}
												</span>
											</Link>
										))}
										{d.more > 0 && (
											<Link to="/broadcasts" className="small">
												외 {d.more}개 더 보기 →
											</Link>
										)}
									</>
								)
							}
						</OvPanel>
					</Card>

					<Card title="참고" className="ov-side-card">
						<OvPanel panel={p('notes')} slow={page.slow}>
							{(n: any) => <Notes n={n} alerts={p('status')?.ok ? (p('status') as any).data.alerts : null} />}
						</OvPanel>
					</Card>
				</div>
			</div>
		</StaleScope>
	);
}

function EdgeFlow({ f, level }: { f: any; level: OvLevel }) {
	const v = f.viewers;
	const pipe: OvLevel = f.pipe.level ?? 'idle';
	let originHost: string | null = null;

	try {
		originHost = f.origin.url ? new URL(f.origin.url).host : null;
	} catch {
		originHost = f.origin.url;
	}

	const origin = (
		<>
			<div className="ov-kicker">Origin</div>
			<div className="ov-name lg">origin</div>
			<div className="ov-sub mono">{originHost ?? '주소 설정 없음 (MSDASH_ORIGIN_URL)'}</div>
		</>
	);

	return (
		<div className="ov-flow">
			{f.origin.url ? (
				<a href={f.origin.url} target="_blank" rel="noreferrer" className="ov-node origin side" title="origin 대시보드 열기">
					{origin}
				</a>
			) : (
				<div className="ov-node origin side">
					{origin}
				</div>
			)}

			<div className="ov-links wide">
				<FlowLink level={pipe} value={bps(f.pipe.bps ?? 0)} caption={`loss ${pct(f.pipe.lossRatio)} · RTT ${ms(f.pipe.rttMs)}`} mono />
			</div>

			<div className={`ov-node this-edge ${lv(level)}`}>
				<div className="ov-kicker">This edge</div>
				<div className="ov-name lg">{f.edge.serverId}</div>
				<Big value={f.edge.workers.running} unit={`/ ${f.edge.workers.total} worker 실행 중`} />
				<div className="ov-sub">
					방송 {f.edge.rooms} · 송신 {bps(f.edge.egressBps)} / {bps(f.edge.capacityBps)}
				</div>
			</div>

			<div className="ov-links narrow">
				<FlowLink level={v.count > 0 ? v.level : 'idle'} value={bps(v.bps)} caption="송신" />
			</div>

			<Link to={v.problems > 0 ? '/viewers?filter=loss5' : '/viewers'} className={`ov-node side ${v.count === 0 ? 'dashed' : v.problems > 0 ? lv('warn') : ''}`}>
				<div className="ov-kicker">Viewers</div>
				<Big value={int(v.count)} unit="명" />
				{v.count === 0 ? (
					<div className="ov-sub">시청 중인 viewer 없음</div>
				) : v.problems > 0 ? (
					<LevelText level="warn">문제 {v.problems}명</LevelText>
				) : (
					<LevelText level="ok">모두 정상</LevelText>
				)}
			</Link>
		</div>
	);
}

function Notes({ n, alerts }: { n: any; alerts: any }) {
	const now = useNow(10_000);
	const firing: any[] = alerts?.items ?? [];

	return (
		<>
			{firing.map(it => (
				<Link key={`${it.ruleId}:${it.subjectId}`} to="/alerts" className={`ov-note ${lv(it.level)}`}>
					<span role="img" aria-label={it.level === 'crit' ? '심각' : '경고'}>
						{it.level === 'crit' ? '✕' : '▲'}
					</span>
					<span>
						{it.title}
						{it.subjectId ? ` · ${it.subjectId}` : ''}
					</span>
				</Link>
			))}
			{n.items.map((it: any) => (
				<Link key={`${it.kind}:${it.workerIdx}`} to="/workers" className="ov-note lv-warn">
					<span role="img" aria-label="주의">
						▲
					</span>
					<span>
						{it.kind === 'restart'
							? `w${it.workerIdx}이 관측 이후 ${it.restarts}회 재시작했습니다${it.lastRestartAt ? ` (마지막 ${ago(since(it.lastRestartAt, now))})` : ''}. 부하를 늘리기 전에 안정성을 확인하세요.`
							: `w${it.workerIdx}이 통계 요청에 응답하지 않습니다. 합계에서 제외했습니다.`}
					</span>
				</Link>
			))}
			{firing.length === 0 && n.items.length === 0 && (
				<LevelText level="ok" className="ov-ok-line">
					확인할 항목 없음
				</LevelText>
			)}
			<div className="ov-sub">
				{n.events24h > 0 ? `최근 24시간 서버 이벤트 ${n.events24h}건` : '서버 이벤트 없음'} · 알림 {n.alerts}건 · <Link to="/alerts">Alerts →</Link>
			</div>
		</>
	);
}

/** loss 제목 옆 정의 툴팁 (AGENT_TASK 4.4) */
export function LossTitle({ text }: { text: string }) {
	return (
		<span
			title="최근 10초 구간의 sum(유실 패킷) / sum(와야 했던 패킷). pipe 수신 loss는 복구 전 원본 기준이며 broadcaster → origin 구간 유실을 포함합니다. viewer loss는 viewer가 보낸 RTCP RR 기준(복구 후에 가까움)입니다."
			style={{ borderBottom: '1px dotted var(--muted)', cursor: 'help' }}
		>
			{text}
		</span>
	);
}
