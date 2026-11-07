/**
 * 훅(hook/msdash-hook.cjs)이 돌려주는 원시 데이터 형식. 훅의 PROTOCOL_VERSION과 맞춘다.
 * 필드 이름은 mediasoup getStats() 그대로다. 정규화는 collector/normalize*.ts가 한다.
 */

export const HOOK_PROTOCOL_VERSION = 1;

export type RawRtpStat = {
	type: string; // 'inbound-rtp' | 'outbound-rtp'
	kind?: string;
	ssrc?: number;
	rid?: string;
	mimeType?: string;
	timestamp?: number;
	packetCount?: number;
	byteCount?: number;
	bitrate?: number;
	bitrateByLayer?: Record<string, number>;
	packetsLost?: number;
	fractionLost?: number;
	jitter?: number;
	packetsDiscarded?: number;
	packetsRetransmitted?: number;
	packetsRepaired?: number;
	nackCount?: number;
	nackPacketCount?: number;
	pliCount?: number;
	firCount?: number;
	roundTripTime?: number;
};

export type RawTransportStat = {
	type: string;
	timestamp?: number;
	bytesReceived?: number;
	recvBitrate?: number;
	bytesSent?: number;
	sendBitrate?: number;
	iceState?: string;
	dtlsState?: string;
	availableOutgoingBitrate?: number;
	iceSelectedTuple?: { remoteIp?: string; remotePort?: number };
	tuple?: { remoteIp?: string; remotePort?: number };
};

export type RawWorker = {
	pid: number;
	idx: number | null;
	/** getResourceUsage() 누적값. ru_*time은 ms, ru_maxrss는 KB(최대치), ru_n*csw는 컨텍스트 스위치 횟수. */
	usage: { ru_utime: number; ru_stime: number; ru_maxrss: number; ru_nvcsw?: number; ru_nivcsw?: number } | null;
	rssBytes: number | null;
};

export type RawRouter = { id: string; workerPid: number };

export type RawTransport = {
	id: string;
	routerId: string;
	type: 'webrtc' | 'pipe' | 'plain' | 'direct' | undefined;
	direction: string | null;
	/** 서버가 transport appData에 peerId를 넣었을 때만 온다 (M1). 없으면 undefined/null. */
	peerId?: string | null;
	iceState: string | null;
	dtlsState: string | null;
	tuple: { localIp: string | null; localPort: number | null; remoteIp: string | null; remotePort: number | null } | null;
	/** 시청자 브라우저 보고값 (서버가 reportClientStats를 받아 appData에 넣었을 때만, M2). 옛 훅이면 undefined. */
	clientStats?: RawClientStats | null;
	stats: RawTransportStat[] | null;
};

/** 브라우저 inbound-rtp 기준. freezeCount·freezeSec·framesDropped는 접속 이후 누적값, at은 서버가 받은 시각(ms). */
export type RawClientStats = {
	freezeCount: number | null;
	freezeSec: number | null;
	framesDropped: number | null;
	fps: number | null;
	jitterBufferMs: number | null;
	width: number | null;
	height: number | null;
	at: number | null;
};

export type RawProducer = {
	id: string;
	transportId: string;
	kind: 'audio' | 'video';
	type?: string;
	paused?: boolean;
	peerId: string | null;
	source: string | null;
	stats: RawRtpStat[] | null;
};

export type RawConsumer = {
	id: string;
	transportId: string;
	producerId: string;
	kind: 'audio' | 'video';
	type?: string;
	paused?: boolean;
	producerPaused?: boolean;
	currentLayers: { spatialLayer: number; temporalLayer: number | null } | null;
	stats: RawRtpStat[] | null;
};

export type RawPeer = {
	peerId: string;
	displayName: string | null;
	device: { flag: string | null; name: string | null; version: string | null } | null;
	remoteAddress: string | null;
};

export type RawRoom = {
	roomId: string;
	createdAt: string | null;
	producerRouterId: string | null;
	consumerRouterId: string | null;
	peers: RawPeer[];
	broadcasterPeers: RawPeer[];
};

export type RawSnapshot = {
	protocol: number;
	time: number;
	durationMs: number;
	process: { pid: number; rssBytes: number; eventLoopLagP99Ms: number | null };
	workers: RawWorker[];
	routers: RawRouter[];
	transports: RawTransport[];
	producers: RawProducer[];
	consumers: RawConsumer[];
	rooms: RawRoom[];
	errors: string[];
	errorCount: number;
};

export type RawTransportDetail =
	| { time: number; found: false }
	| {
			time: number;
			found: true;
			transport: RawTransport;
			consumers: RawConsumer[];
			producers: RawProducer[];
			errors: string[];
	  };

export type RawHealth = {
	protocol: number;
	pid: number;
	mediasoupVersion: string;
	counts: Record<'workers' | 'routers' | 'transports' | 'producers' | 'consumers', number>;
};
