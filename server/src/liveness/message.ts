/**
 * edge → origin 생존 신호 (AGENT_TASK 6.4). 요약 숫자만 담는다. 상세 데이터는 보내지 않는다.
 * push(edge가 POST)와 pull(origin이 GET) 모두 이 형식을 쓴다.
 */
export type LivenessMessage = {
	v: 1;
	edgeId: string;
	dashboardUrl: string;
	/** pipe 수신 IP. origin이 PipeTransport 원격 IP와 대조한다 (M7). */
	ip: string | null;
	region: string | null;
	/** edge 자체 점검: 수집기가 최근에 성공했는가 */
	ok: boolean;
	okReason: string | null;
	viewerCount: number | null;
	/** 직전 신호 이후 pipe 수신 delta 합. 비율이 아니라 두 값으로 보낸다. */
	recvPacketsLost: number | null;
	recvPacketsExpected: number | null;
	/** 직전 신호 왕복 시간 (edge가 잰 값). pull에서는 origin이 직접 잰다. */
	lastRttMs: number | null;
	/** 참고용 edge 시각. 저장 시각은 origin이 찍는다 (AGENT_TASK 3-7). */
	sentAt: number;
	/**
	 * 통합 3D 화면용 실시간 값 (1초 주기). 옛 edge는 보내지 않으므로 없을 수 있다.
	 * DB를 거치지 않고 edge 메모리의 최신값을 그대로 담는다.
	 */
	live?: EdgeLive | null;
};

export type EdgeLiveViewer = {
	/** viewer의 consumer용 WebRtcTransport id (edge viewer_session.viewer_id와 같다) */
	id: string;
	roomId: string;
	/** 표시 이름. 서버가 transport에 peerId를 넣지 않으면 mock 이름(M1)이고 nameMock=true. 모르면 null. */
	name: string | null;
	nameMock: boolean;
	/** 접속 시각 (epoch ms). edge 재시작 전부터 있던 viewer는 null. */
	connectedAt: number | null;
	/** 최근 5초 RR 기반 loss 비율 (0~1) */
	lossRatio: number | null;
	rttMs: number | null;
	bitrateBps: number | null;
	spatialLayer: number | null;
	transportState: string | null;
	/** 브라우저 보고(M2). clientReported=false면 mock 값이거나 보고 없음. freezeCount는 접속 후 누적. */
	clientReported: boolean;
	freezeCount: number | null;
	fps: number | null;
};

export type EdgeLive = {
	/** 이 edge Pod가 도는 k8s 노드 (Downward API NODE_NAME). 모르면 null. */
	nodeName: string | null;
	/** 노드 전체 CPU (/proc/stat) */
	hostCpuPct: number | null;
	/** mediasoup worker CPU 합 (코어 1개 = 100%) */
	cpuPct: number | null;
	workerCount: number;
	/** 최근 수집 1회 걸린 시간·지금까지 건너뛴 주기 수 (1초 주기 부하 측정용) */
	collectMs: number | null;
	skippedCycles: number;
	eventLoopLagMs: number | null;
	viewers: EdgeLiveViewer[];
};

export function parseLivenessMessage(input: unknown): LivenessMessage {
	if (!input || typeof input !== 'object') {
		throw new Error('liveness message must be an object');
	}

	const m = input as Record<string, unknown>;
	const str = (k: string, required = false): string | null => {
		const v = m[k];

		if (typeof v === 'string' && v.length > 0 && v.length <= 512) {
			return v;
		}

		if (required) {
			throw new Error(`liveness message: invalid ${k}`);
		}

		return null;
	};
	const num = (k: string): number | null => {
		const v = m[k];

		return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
	};

	if (m.v !== 1) {
		throw new Error(`liveness message: unsupported version ${String(m.v)}`);
	}

	return {
		v: 1,
		edgeId: str('edgeId', true)!,
		dashboardUrl: str('dashboardUrl', true)!,
		ip: str('ip'),
		region: str('region'),
		ok: m.ok === true,
		okReason: str('okReason'),
		viewerCount: num('viewerCount'),
		recvPacketsLost: num('recvPacketsLost'),
		recvPacketsExpected: num('recvPacketsExpected'),
		lastRttMs: num('lastRttMs'),
		sentAt: num('sentAt') ?? 0,
		live: parseLive(m.live),
	};
}

const MAX_LIVE_VIEWERS = 20000;

/** live는 화면 표시에만 쓰므로 형식이 틀린 칸은 null로 두고 버리지 않는다. 전체가 객체가 아니면 null. */
function parseLive(input: unknown): EdgeLive | null {
	if (!input || typeof input !== 'object') {
		return null;
	}

	const m = input as Record<string, unknown>;
	const viewers = Array.isArray(m.viewers) ? m.viewers.slice(0, MAX_LIVE_VIEWERS) : [];

	return {
		nodeName: optStr(m.nodeName),
		hostCpuPct: optNum(m.hostCpuPct),
		cpuPct: optNum(m.cpuPct),
		workerCount: optNum(m.workerCount) ?? 0,
		collectMs: optNum(m.collectMs),
		skippedCycles: optNum(m.skippedCycles) ?? 0,
		eventLoopLagMs: optNum(m.eventLoopLagMs),
		viewers: viewers
			.filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && typeof (v as Record<string, unknown>).id === 'string')
			.map(v => ({
				id: String(v.id).slice(0, 128),
				roomId: optStr(v.roomId) ?? '',
				name: optStr(v.name),
				nameMock: v.nameMock === true,
				connectedAt: optNum(v.connectedAt),
				lossRatio: optNum(v.lossRatio),
				rttMs: optNum(v.rttMs),
				bitrateBps: optNum(v.bitrateBps),
				spatialLayer: optNum(v.spatialLayer),
				transportState: optStr(v.transportState),
				clientReported: v.clientReported === true,
				freezeCount: optNum(v.freezeCount),
				fps: optNum(v.fps),
			})),
	};
}

function optStr(v: unknown): string | null {
	return typeof v === 'string' && v.length > 0 && v.length <= 256 ? v : null;
}

function optNum(v: unknown): number | null {
	return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}
