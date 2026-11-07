/**
 * 정규화된 행. 필드 이름은 DB 컬럼 이름을 camelCase로 옮긴 것이다 (AGENT_TASK 4.2-1).
 * 단위: bitrate bps, 시간 ms, 시각 Date(UTC). 값 없음은 null (0과 구분).
 */

export type CollectorSampleRow = {
	time: Date;
	hookOk: boolean;
	collectDurationMs: number | null;
	collectSkipped: boolean;
	eventLoopLagMs: number | null;
	nodeRssBytes: number | null;
	hostCpuPct: number | null;
};

export type WorkerSampleRow = {
	time: Date;
	workerIdx: number;
	cpuPct: number | null;
	memRssBytes: number | null;
	routerCount: number;
	transportCount: number;
	producerCount: number;
	consumerCount: number;
};

// ---- edge ----

export type EdgeRoomSampleRow = {
	time: Date;
	roomId: string;
	workerIdx: number;
	viewerCount: number;
	producerCount: number | null;
	outBitrateBps: number | null;
	inBitrateBps: number | null;
};

export type PipeSampleRow = {
	time: Date;
	roomId: string;
	producerId: string;
	kind: string;
	packetsExpected: number | null;
	packetsLost: number | null;
	packetsRepaired: number | null;
	bitrateBps: number | null;
	rttMs: number | null;
	jitterMs: number | null;
	nackCount: number | null;
	pliCount: number | null;
};

export type ViewerSampleRow = {
	time: Date;
	viewerId: string;
	roomId: string;
	workerIdx: number | null;
	packetsExpected: number | null;
	packetsLost: number | null;
	nackCount: number | null;
	packetsRetransmitted: number | null;
	rttMs: number | null;
	bitrateBps: number | null;
	spatialLayer: number | null;
	temporalLayer: number | null;
	transportState: string | null;
	/** 실제 브라우저 보고(reportClientStats)가 있었는지. mock으로 채운 구간은 false. */
	clientReported: boolean;
	clientFreezeCount: number | null;
	clientFreezeMs: number | null;
	clientFps: number | null;
	clientJitterBufferMs: number | null;
	clientFramesDropped: number | null;
};

export type ViewerSessionStart = {
	viewerId: string;
	roomId: string;
	workerIdx: number | null;
	connectedAt: Date;
	peerId: string | null;
	displayName: string | null;
	deviceFlag: string | null;
	browserName: string | null;
	browserVersion: string | null;
	remoteIp: string | null;
	/** 'peer' = transport의 peerId로 room의 peer를 찾음(실제 값), 'mock' = mock, null = 없음 */
	identitySource: 'peer' | 'mock' | null;
	deviceClass: string | null;
	networkType: string | null;
	userAgent: string | null;
};

export type ViewerSessionEnd = {
	viewerId: string;
	disconnectedAt: Date;
	disconnectReason: string | null;
};

export type EdgeBatch = {
	mode: 'edge';
	time: Date;
	rooms: string[];
	collector: CollectorSampleRow;
	workers: WorkerSampleRow[];
	roomSamples: EdgeRoomSampleRow[];
	pipeSamples: PipeSampleRow[];
	viewerSamples: ViewerSampleRow[];
	viewerSessionStarts: ViewerSessionStart[];
	viewerSessionEnds: ViewerSessionEnd[];
};

// ---- origin ----

export type BroadcasterSampleRow = {
	time: Date;
	broadcasterId: string;
	roomId: string;
	bitrateBps: number | null;
	fps: number | null;
	packetsExpected: number | null;
	packetsLost: number | null;
	packetsRepaired: number | null;
	rttMs: number | null;
	jitterMs: number | null;
	nackCount: number | null;
	pliCount: number | null;
	layersActive: number | null;
};

export type BroadcasterSessionStart = {
	broadcasterId: string;
	roomId: string;
	displayName: string | null;
	workerIdx: number | null;
	connectedAt: Date;
};

export type BroadcasterSessionUpdate = {
	broadcasterId: string;
	state: 'sending' | 'idle' | 'disconnected';
	disconnectedAt: Date | null;
};

export type OriginRoomSampleRow = {
	time: Date;
	roomId: string;
	viewerCount: number;
	outPipeBitrateBps: number | null;
};

export type PipeSendSampleRow = {
	time: Date;
	roomId: string;
	edgeId: string | null;
	remoteIp: string;
	producerId: string;
	kind: string;
	packetsExpected: number | null;
	packetsLost: number | null;
	bitrateBps: number | null;
	rttMs: number | null;
	nackCount: number | null;
	pliCount: number | null;
};

export type RoomEdgeLinkRow = {
	roomId: string;
	edgeId: string;
	state: 'connected' | 'closed' | 'failed';
	since: Date;
};

export type OriginBatch = {
	mode: 'origin';
	time: Date;
	rooms: string[];
	collector: CollectorSampleRow;
	workers: WorkerSampleRow[];
	broadcasterSamples: BroadcasterSampleRow[];
	broadcasterSessionStarts: BroadcasterSessionStart[];
	broadcasterSessionUpdates: BroadcasterSessionUpdate[];
	roomSamples: OriginRoomSampleRow[];
	pipeSendSamples: PipeSendSampleRow[];
	roomEdgeLinks: RoomEdgeLinkRow[];
	/**
	 * origin에 직접 붙은 viewer의 이번 구간 loss. DB에 저장하지 않는다 (origin 스키마는 viewer를 담지 않음).
	 * O1 "이 서버 viewer 품질", O2 방송별 viewer loss p50의 현재 값으로만 쓴다.
	 */
	viewerLive: Array<{ viewerId: string; roomId: string; lossRatio: number | null }>;
};

export type Batch = EdgeBatch | OriginBatch;
