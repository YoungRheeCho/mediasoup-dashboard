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
	};
}
