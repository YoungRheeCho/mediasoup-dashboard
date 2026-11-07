import { Link } from 'react-router-dom';

import { PageHeader, StaleScope } from '../../components/Layout';
import { Big, Card, FlowLink, LevelText, OvPanel, StatCard, countText, lv, worstLevel, type OvLevel } from '../../components/Overview';
import { ago, bps, bpsParts, int, ms, pct } from '../../lib/format';
import { usePage } from '../../lib/usePage';

/**
 * Origin Overview (handoff/HANDOFF.md). "한눈에 문제 여부와 연결 상태"만 보여 주고 상세는 각 탭으로 보낸다.
 * 상태 배너 → 연결 흐름(broadcaster·viewer → origin → edge) → 카드 3개 → 방송 + 알림.
 */

/** edge 칸은 최대 3개: 1~2개는 카드만, 3개 이상은 카드 2장 + "외 N개" */
const EDGE_CARDS = 2;

const ROOM_STATE: Record<OvLevel, string> = { ok: '정상', warn: '주의', crit: '장애', idle: '송출 없음' };

export function OriginOverview() {
	const page = usePage('/api/origin/overview', 10);
	const { meta, p } = page;

	return (
		<StaleScope meta={meta} lastFetchAt={page.lastSuccessAt} refreshSeconds={10}>
			<PageHeader title="Overview" meta={meta} refreshSeconds={10} paused={page.paused} lastFetchAt={page.lastSuccessAt} />

			<div className="ov">
				<Card title="연결 흐름" hint="송출 → origin → edge / viewer">
					<OvPanel panel={p('flow')} slow={page.slow}>
						{(f: any) => <OriginFlow f={f} />}
					</OvPanel>
				</Card>

				<OvPanel panel={p('kpi')} slow={page.slow}>
					{(k: any) => (
						<div className="ov-row">
							<StatCard label="방송 (room)" value={int(k.rooms.total)} sub={`송출 중 ${k.rooms.sending} · 대기 ${k.rooms.idle}`} />
							<StatCard
								label="연결된 edge"
								value={k.edges.connected}
								unit={` / ${k.edges.total}`}
								level={k.edges.lost > 0 ? 'crit' : k.edges.total === 0 ? 'idle' : 'ok'}
								sub={k.edges.lost > 0 ? `✕ ${k.edges.lost}개 끊김` : k.edges.total === 0 ? '○ 아직 신호 없음' : '모두 연결됨'}
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
					<Card title="방송" className="ov-list-card" right={<Link to="/rooms">Rooms &amp; Broadcasters 보기 →</Link>}>
						<OvPanel panel={p('rooms')} slow={page.slow}>
							{(d: any) =>
								d.items.length === 0 ? (
									<div className="ov-sub">○ 진행 중인 방송이 없습니다. 송출이 시작되면 자동으로 나타납니다.</div>
								) : (
									<>
										{d.items.map((r: any) => (
											<Link key={r.roomId} to={`/rooms/${encodeURIComponent(r.roomId)}`} className={`ov-item ${lv(r.level)}`}>
												<span className="ov-item-name">{r.roomId}</span>
												<LevelText level={r.level}>{ROOM_STATE[r.level as OvLevel]}</LevelText>
												<span className="ov-item-meta">Broadcaster {r.broadcasters}</span>
												<span className="ov-item-meta">Viewer {int(r.viewerCount)}</span>
												<span className="ov-item-num">{bps(r.bitrateBps)}</span>
											</Link>
										))}
										{d.more > 0 && (
											<Link to="/rooms" className="small">
												외 {d.more}개 더 보기 →
											</Link>
										)}
									</>
								)
							}
						</OvPanel>
					</Card>

					<Card title="알림" className="ov-side-card" right={<Link to="/alerts">전체 보기 →</Link>}>
						<OvPanel panel={p('status')} slow={page.slow}>
							{(s: any) => <AlertSummary a={s.alerts} />}
						</OvPanel>
					</Card>
				</div>
			</div>
		</StaleScope>
	);
}

/** 예: "Broadcaster 입력 loss (test-room/…) 외 2건" */
export function alertLine(a: any): string {
	const first = a.items[0];

	return first ? `${first.title}${first.subjectId ? ` (${first.subjectId})` : ''}${a.total > 1 ? ` 외 ${a.total - 1}건` : ''}` : '';
}

export function AlertSummary({ a }: { a: any }) {
	return (
		<>
			{a.total === 0 ? (
				<LevelText level="ok" className="ov-ok-line">
					진행 중인 알림 없음
				</LevelText>
			) : (
				a.items.map((it: any) => (
					<Link key={`${it.ruleId}:${it.subjectId}`} to="/alerts" className={`ov-note ${lv(it.level)}`}>
						<span role="img" aria-label={it.level === 'crit' ? '심각' : '경고'}>
							{it.level === 'crit' ? '✕' : '▲'}
						</span>
						<span>
							{it.title}
							{it.subjectId ? ` · ${it.subjectId}` : ''}
							{it.since ? ` · ${ago((Date.now() - new Date(it.since).getTime()) / 1000).replace(' 전', '')}째` : ''}
						</span>
					</Link>
				))
			)}
			{a.total > a.items.length && <div className="ov-sub">외 {a.total - a.items.length}건</div>}
			<div className="ov-sub">
				{a.near > 0 ? `임계값 근접 ${a.near}개` : '임계값 근접 항목 없음'} · 최근 24시간 {a.last24h}건
			</div>
		</>
	);
}

function OriginFlow({ f }: { f: any }) {
	const b = f.broadcasters;
	const v = f.viewers;
	const edges: any[] = f.edges;
	const shown = edges.length > EDGE_CARDS ? edges.slice(0, EDGE_CARDS) : edges;
	const folded = edges.slice(shown.length);
	const pipeLevel = (e: any): OvLevel => (e.level !== 'ok' ? e.level : e.pipeBps ? 'ok' : 'idle');
	const used = f.origin.capacityBps ? f.origin.egressBps / f.origin.capacityBps : null;
	const [egressValue, egressUnit] = bpsParts(f.origin.egressBps);

	return (
		<>
			<div className="ov-flow">
				<div className="ov-col">
					<Link to="/rooms" className={`ov-node ${b.problems > 0 ? lv(b.level) : ''}`}>
						<div className="ov-kicker">Broadcasters</div>
						<Big value={b.sending} unit="명 송출 중" />
						<LevelText level={b.problems > 0 ? b.level : b.sending === 0 ? 'idle' : 'ok'}>
							문제 {b.problems}명 · 대기 {b.idle}
						</LevelText>
						<div className="ov-sub mono">
							최대 loss {pct(b.maxLossRatio)} · 최대 RTT {ms(b.maxRttMs)}
						</div>
					</Link>
					<div className={`ov-node ${v.problems > 0 ? lv(v.level) : ''}`}>
						<div className="ov-kicker">Viewers</div>
						<Big value={int(v.count)} unit="명 시청 중" />
						{v.problems > 0 ? (
							<LevelText level="warn">문제 {v.problems}명</LevelText>
						) : v.count > 0 ? (
							<LevelText level="ok">문제 0명</LevelText>
						) : (
							<div className="ov-sub">이 서버에 직접 접속한 viewer 없음</div>
						)}
					</div>
				</div>

				<div className="ov-links">
					<FlowLink level={b.inBps ? (b.problems > 0 ? b.level : 'ok') : 'idle'} value={bps(b.inBps ?? 0)} caption="입력 →" />
					<FlowLink level={v.count > 0 ? v.level : 'idle'} value={bps(v.bps)} caption="← 시청" />
				</div>

				<div className="ov-node origin">
					<div className="ov-kicker">Origin</div>
					<div className="ov-name lg">{f.origin.serverId}</div>
					<Big value={egressValue} unit={`${egressUnit} 송신`} />
					<div className="ov-meter" role="img" aria-label={`대역폭 ${pct(used)} 사용`}>
						<div style={{ width: `${Math.min(100, (used ?? 0) * 100)}%` }} />
					</div>
					<div className="ov-sub">
						대역폭 {pct(used)} 사용 ({bps(f.origin.capacityBps)})
					</div>
				</div>

				<div className="ov-links narrow">
					{edges.length === 0 && <FlowLink level="idle" value="—" caption="pipe" />}
					{shown.map(e => (
						<FlowLink key={e.edgeId} level={pipeLevel(e)} value={bps(e.pipeBps ?? 0)} caption="pipe" />
					))}
					{folded.length > 0 && (
						<FlowLink dashed level={worstLevel(folded.map(pipeLevel))} value={bps(folded.reduce((a, e) => a + (e.pipeBps ?? 0), 0))} caption={`pipe ×${folded.length}`} />
					)}
				</div>

				<div className="ov-col ov-col-edges">
					{edges.length === 0 && (
						<div className="ov-node dashed">
							<div className="ov-kicker">Edge</div>
							<div className="ov-sub">○ 아직 신호를 보낸 edge가 없습니다</div>
							<Link to="/edges" className="small">
								Connected Edges →
							</Link>
						</div>
					)}
					{shown.map(e => (
						<EdgeCard key={e.edgeId} e={e} />
					))}
					{folded.length > 0 && <OthersCard edges={folded} />}
				</div>
			</div>

			{f.unmatchedPipe && (
				<div className="ov-flow-note lv-warn">
					▲ 어느 edge인지 알 수 없는 pipe {bps(f.unmatchedPipe.bps)} (상대 IP {f.unmatchedPipe.ips.join(', ')}) — edge 사이드카의 MSDASH_PIPE_IP가 이 주소와 같은지 확인하세요.
				</div>
			)}
		</>
	);
}

function EdgeCard({ e }: { e: any }) {
	const body = (
		<>
			<div className="ov-kicker">Edge</div>
			<div className="ov-name">{e.edgeId}</div>
			{e.state === 'lost' ? (
				<LevelText level="crit">끊김 · 마지막 신호 {ago(e.ageSeconds)}</LevelText>
			) : e.state === 'warning' ? (
				<LevelText level="warn">연결됨 · 수신 loss 주의</LevelText>
			) : (
				<LevelText level="ok">연결됨 · {ago(e.ageSeconds)} 신호</LevelText>
			)}
			<div className="ov-sub mono">수신 측 loss {pct(e.recvLossRatio)}</div>
		</>
	);

	// 카드 전체가 그 edge 대시보드로 가는 링크 (새 탭)
	return e.dashboardUrl ? (
		<a href={e.dashboardUrl} target="_blank" rel="noreferrer" className={`ov-node ${e.level !== 'ok' ? lv(e.level) : ''}`} title={e.reason ?? `${e.edgeId} 대시보드 열기`}>
			{body}
		</a>
	) : (
		<div className={`ov-node ${e.level !== 'ok' ? lv(e.level) : ''}`}>{body}</div>
	);
}

/** 접힌 edge 묶음. 그 안에 문제가 있으면 카드 색을 바꿔 숨기지 않는다. */
function OthersCard({ edges }: { edges: any[] }) {
	const levels: OvLevel[] = edges.map(e => e.level);
	const level = worstLevel(levels);

	return (
		<Link to="/edges" className={`ov-node ${level !== 'ok' ? lv(level) : ''}`}>
			<div className="ov-kicker">Others</div>
			<div style={{ fontSize: 15, fontWeight: 500 }}>외 {edges.length}개 edge</div>
			<LevelText level={level}>{countText(levels, { crit: '끊김', warn: 'loss 주의', ok: '정상', allOk: '모두 연결됨' })}</LevelText>
			<span className="small" style={{ color: 'var(--blue)' }}>
				Connected Edges →
			</span>
		</Link>
	);
}
