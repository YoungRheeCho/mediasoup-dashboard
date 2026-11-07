/**
 * DB 접근 계층 (AGENT_TASK 5.1).
 *  - 쓰기는 saveBatch() 하나. 수집기는 이것만 호출한다.
 *  - 읽기는 화면 목적별 함수. API·화면 코드는 SQL을 직접 쓰지 않는다.
 *  - 시간 구간 집계, 압축, 보관 기간처럼 DB마다 다른 부분은 구현(timescale/) 안에 둔다.
 * DB를 바꿀 때는 이 인터페이스를 새로 구현하면 된다.
 */

import type { NewAlertEvent } from '../alerts/evaluator.js';
import type { Batch, CollectorSampleRow, RoomEdgeLinkRow } from './rows.js';

export type TimeRange = { from: Date; to: Date };

/** 시계열 한 점. bucket은 구간 시작 시각. */
export type SeriesPoint<T> = { bucket: Date } & T;

export type AlertEventRecord = {
	alertId: number;
	ruleId: string;
	title: string;
	severity: 'warn' | 'crit';
	state: 'firing' | 'resolved';
	subjectType: string;
	subjectId: string | null;
	value: number | null;
	threshold: number | null;
	startedAt: Date;
	resolvedAt: Date | null;
};

export type AlertRuleRecord = {
	ruleId: string;
	title: string;
	metric: string;
	warnAbove: number | null;
	critAbove: number | null;
	windowSeconds: number;
	enabled: boolean;
};

export type ServerSeriesPoint = SeriesPoint<{
	hookOkRatio: number;
	collectDurationMs: number | null;
	skippedCycles: number;
	eventLoopLagMs: number | null;
	nodeRssBytes: number | null;
	hostCpuPct: number | null;
}>;

export type WorkerSeriesPoint = SeriesPoint<{
	workerIdx: number;
	cpuPct: number | null;
	memRssBytes: number | null;
	routerCount: number | null;
	transportCount: number | null;
	consumerCount: number | null;
}>;

export interface CommonStore {
	/** 수집기가 부르는 유일한 쓰기 함수. 한 트랜잭션으로 배치 insert 한다. */
	saveBatch(batch: Batch): Promise<void>;
	/** 훅 응답 실패 주기: 수집기 상태 행만 남긴다. */
	saveCollectorFailure(row: CollectorSampleRow): Promise<void>;

	getServerSeries(range: TimeRange, bucketSeconds: number): Promise<ServerSeriesPoint[]>;
	getWorkerSeries(range: TimeRange, bucketSeconds: number): Promise<WorkerSeriesPoint[]>;
	getAlertRules(): Promise<AlertRuleRecord[]>;
	getAlertHistory(range: TimeRange, limit?: number): Promise<AlertEventRecord[]>;
	getFiringAlerts(): Promise<AlertEventRecord[]>;
	/** 알림 평가기(alerts/evaluator.ts)만 쓴다. */
	insertAlertEvent(event: NewAlertEvent): Promise<number>;
	resolveAlertEvent(alertId: number, resolvedAt: Date): Promise<void>;

	/** 보관 기간을 설정값으로 다시 건다. */
	applyRetention(retention: { viewerRawHours: number; rawDays: number; aggregateDays: number }): Promise<void>;
	close(): Promise<void>;
}

// ---------------- edge ----------------

export type RoomSummary = {
	roomId: string;
	viewerCount: number;
	workers: number[];
	producerCount: number | null;
	inBitrateBps: number | null;
	outBitrateBps: number | null;
	/** 최근 구간 viewer loss (sum lost / sum expected) */
	viewerLossRatio: number | null;
	viewerLossP50: number | null;
	pipeLossRatio: number | null;
	lastSeenAt: Date;
};

export type PipeSeriesPoint = SeriesPoint<{
	roomId: string;
	packetsExpected: number | null;
	packetsLost: number | null;
	packetsRepaired: number | null;
	lossRatio: number | null;
	recoveredLossRatio: number | null;
	rttMs: number | null;
	jitterMs: number | null;
	bitrateBps: number | null;
	nackCount: number | null;
	pliCount: number | null;
}>;

export type ViewerListFilter = {
	roomId?: string;
	minLossRatio?: number;
	deviceClass?: string;
	maxSpatialLayer?: number;
	limit?: number;
	/** 'loss' | 'freeze' | 'rtt' | 'layer' | 'connected' */
	sort?: string;
};

export type ViewerListItem = {
	viewerId: string;
	roomId: string;
	workerIdx: number | null;
	connectedAt: Date;
	disconnectedAt: Date | null;
	disconnectReason: string | null;
	peerId: string | null;
	displayName: string | null;
	deviceFlag: string | null;
	browserName: string | null;
	browserVersion: string | null;
	remoteIp: string | null;
	identitySource: 'peer' | 'mock' | null;
	deviceClass: string | null;
	networkType: string | null;
	/** 최근 구간 loss */
	lossRatio: number | null;
	rttMs: number | null;
	bitrateBps: number | null;
	spatialLayer: number | null;
	temporalLayer: number | null;
	transportState: string | null;
	freezeCount: number | null;
	/** 최근 구간에 실제 브라우저 보고가 있었는지 (M2). false인데 freezeCount가 있으면 mock 값이다. */
	clientReported: boolean;
	lastSampleAt: Date | null;
};

export type ViewerSeriesPoint = SeriesPoint<{
	packetsExpected: number | null;
	packetsLost: number | null;
	lossRatio: number | null;
	nackCount: number | null;
	packetsRetransmitted: number | null;
	rttMs: number | null;
	bitrateBps: number | null;
	spatialLayer: number | null;
	transportState: string | null;
	clientReported: boolean;
	clientFreezeCount: number | null;
	clientFreezeMs: number | null;
	clientFps: number | null;
	clientJitterBufferMs: number | null;
	clientFramesDropped: number | null;
}>;

export type ViewerLossPercentilePoint = SeriesPoint<{ p50: number | null; p95: number | null; viewers: number }>;

export type LossDistribution = Array<{ label: string; lower: number; upper: number | null; viewers: number }>;

export interface EdgeStore extends CommonStore {
	getRoomSummary(windowSeconds?: number): Promise<RoomSummary[]>;
	getRoomViewerSeries(roomId: string, range: TimeRange, bucketSeconds: number): Promise<SeriesPoint<{ viewerCount: number }>[]>;
	getPipeSeries(range: TimeRange, bucketSeconds: number, roomId?: string): Promise<PipeSeriesPoint[]>;
	getViewerList(filter: ViewerListFilter, windowSeconds?: number): Promise<ViewerListItem[]>;
	getViewerSession(viewerId: string): Promise<ViewerListItem | null>;
	getViewerSeries(viewerId: string, range: TimeRange, bucketSeconds: number): Promise<ViewerSeriesPoint[]>;
	getViewerLossPercentiles(range: TimeRange, bucketSeconds: number, roomId?: string): Promise<ViewerLossPercentilePoint[]>;
	getViewerLossDistribution(windowSeconds?: number, roomId?: string): Promise<LossDistribution>;
	/** 수집기 재시작 시 열린 viewer 세션 id */
	getOpenViewerSessionIds(): Promise<string[]>;
	/** 특정 시각 근처 구간의 "loss 5% 이상 viewer" 비율 (Overview "30분 전 3.1%") */
	getBadViewerRatioAt(at: Date, windowSeconds: number, threshold: number): Promise<number | null>;
	/** 최근 구간 viewer 레이어 전환 횟수 / 분 (Broadcasts "레이어 전환 / 분") */
	getLayerSwitchesPerMinute(roomId: string, windowSeconds: number): Promise<number | null>;
	/** 이벤트 목록용: 구간 안에서 처음 본 방송 */
	getRoomsFirstSeen(since: Date): Promise<Array<{ roomId: string; firstSeenAt: Date }>>;
}

// ---------------- origin ----------------

export type BroadcasterRecord = {
	broadcasterId: string;
	roomId: string;
	displayName: string | null;
	workerIdx: number | null;
	connectedAt: Date;
	disconnectedAt: Date | null;
	state: 'sending' | 'idle' | 'disconnected';
	bitrateBps: number | null;
	lossRatio: number | null;
	fps: number | null;
	layersActive: number | null;
	lastSampleAt: Date | null;
};

export type BroadcasterSeriesPoint = SeriesPoint<{
	bitrateBps: number | null;
	fps: number | null;
	packetsExpected: number | null;
	packetsLost: number | null;
	packetsRepaired: number | null;
	lossRatio: number | null;
	recoveredLossRatio: number | null;
	rttMs: number | null;
	jitterMs: number | null;
	nackCount: number | null;
	pliCount: number | null;
	layersActive: number | null;
}>;

export type OriginRoomSummary = {
	roomId: string;
	broadcasters: number;
	sendingBroadcasters: number;
	viewerCount: number;
	edgeCount: number;
	inBitrateBps: number | null;
	outPipeBitrateBps: number | null;
	ingestLossRatio: number | null;
	lastSeenAt: Date;
};

export type EdgeRecord = {
	edgeId: string;
	dashboardUrl: string;
	region: string | null;
	ip: string | null;
	firstSeenAt: Date;
	lastHeartbeatAt: Date | null;
	lastOk: boolean | null;
	viewerCount: number | null;
	recvLossRatio: number | null;
	heartbeatRttMs: number | null;
};

export type RoomEdgeCell = {
	roomId: string;
	edgeId: string;
	linkState: string | null;
	bitrateBps: number | null;
	lossRatio: number | null;
	rttMs: number | null;
};

export type HeartbeatInput = {
	time: Date;
	edgeId: string;
	ok: boolean;
	rttMs: number | null;
	viewerCount: number | null;
	recvPacketsLost: number | null;
	recvPacketsExpected: number | null;
};

export interface OriginStore extends CommonStore {
	getOriginRoomSummary(windowSeconds?: number): Promise<OriginRoomSummary[]>;
	getBroadcasters(roomId?: string, windowSeconds?: number): Promise<BroadcasterRecord[]>;
	getBroadcasterSeries(broadcasterId: string, range: TimeRange, bucketSeconds: number): Promise<BroadcasterSeriesPoint[]>;
	getRoomBitrateSeries(roomId: string, range: TimeRange, bucketSeconds: number): Promise<SeriesPoint<{ inBitrateBps: number | null; outPipeBitrateBps: number | null }>[]>;
	getEdges(): Promise<EdgeRecord[]>;
	getRoomEdgeMatrix(windowSeconds?: number): Promise<RoomEdgeCell[]>;
	/** heartbeat(6.4) — 3단계에서 API가 부른다. */
	upsertEdge(edge: { edgeId: string; dashboardUrl: string; region?: string | null; ip?: string | null }): Promise<void>;
	saveHeartbeat(hb: HeartbeatInput): Promise<void>;
	getOpenBroadcasterSessions(): Promise<Array<{ broadcasterId: string; roomId: string; key: string; state: 'sending' | 'idle' }>>;
	getConnectedLinks(): Promise<RoomEdgeLinkRow[]>;
	/** 종료된 세션도 포함해 하나 */
	getBroadcaster(broadcasterId: string): Promise<BroadcasterRecord | null>;
	/** 이벤트 목록용: 구간 안에서 시작한 broadcaster 세션 */
	getRecentBroadcasterSessions(since: Date): Promise<BroadcasterRecord[]>;
}
