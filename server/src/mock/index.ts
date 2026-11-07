/**
 * 서버(mediasoup-demo) 코드를 고쳐야만 얻을 수 있는 값의 mock.
 * 번호는 docs/collection-design.md 4절(M1~M11)과 같다.
 *
 * 규칙
 *  - 값은 id에서 결정적으로 만든다 (새로 고침해도 같은 viewer는 같은 기기·이름).
 *  - API는 MOCK_FIELDS를 함께 내려 화면이 MOCK 배지를 붙인다.
 *  - 알림 평가는 MOCK_FIELDS에 있는 값을 쓰지 않는다.
 *  - 실제 구현으로 바꿀 때는 이 파일의 해당 함수와 MOCK_FIELDS 항목을 같이 지운다.
 */

export type MockId = 'M1' | 'M2' | 'M3' | 'M4' | 'M5' | 'M8';

/**
 * "테이블.컬럼" → mock 번호.
 * M1 칸(peer_id·display_name·device_flag)은 "mock일 수 있는" 칸이다. 서버가 transport appData에 peerId를 넣으면
 * viewer별로 실제 값이 된다(viewer_session.identity_source='peer'). 그래서 API가 응답마다 실제로 mock이 섞였을 때만
 * 패널 mock 목록에 넣는다(edgeRoutes의 viewerIdentityMock).
 */
export const MOCK_FIELDS: Record<string, MockId> = {
	'viewer_session.peer_id': 'M1',
	'viewer_session.display_name': 'M1',
	'viewer_session.device_flag': 'M1',
	// 모바일/PC 구분은 peer 정보(브라우저 이름·버전)에 없고 user agent가 있어야 한다 → M1을 고쳐도 mock으로 남는다.
	// M2 칸도 "mock일 수 있는" 칸이다. 클라이언트가 reportClientStats를 보내면 viewer별로 실제 값이 된다
	// (viewer_sample.client_reported=true). API와 화면은 실제로 mock이 섞였을 때만 배지를 붙인다 (edgeRoutes의 clientMock).
	'viewer_session.device_class': 'M4',
	'viewer_sample.client_reported': 'M2',
	'viewer_sample.client_freeze_count': 'M2',
	'viewer_sample.client_freeze_ms': 'M2',
	'viewer_sample.client_fps': 'M2',
	'viewer_sample.client_jitter_buffer_ms': 'M2',
	'viewer_sample.client_frames_dropped': 'M2',
	'viewer_session.network_type': 'M3',
	'viewer_session.user_agent': 'M4',
	'viewer_session.disconnect_reason': 'M5',
	'broadcaster_sample.fps': 'M8',
	// 화면 전용 파생 값 (DB 컬럼이 아님)
	'viewer_report.playback_state': 'M2',
	'viewer_report.resolution': 'M2',
	'viewer_report.downlink_mbps': 'M3',
	'viewer_report.browser': 'M4',
	'broadcaster_report.*': 'M8',
};

export function isMockField(table: string, column: string): boolean {
	return `${table}.${column}` in MOCK_FIELDS || `${table}.*` in MOCK_FIELDS;
}

const DEVICES = [
	{ flag: 'chrome', cls: 'desktop', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36' },
	{ flag: 'chrome', cls: 'mobile', ua: 'Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36' },
	{ flag: 'safari', cls: 'mobile', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' },
	{ flag: 'safari', cls: 'desktop', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15' },
	{ flag: 'firefox', cls: 'desktop', ua: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0' },
] as const;

const NETWORKS = ['wifi', 'wifi', 'wired', 'lte', '5g'] as const;
const DISCONNECT_REASONS = ['client_closed', 'client_closed', 'client_closed', 'transport_failed', 'timeout'] as const;

/** M1 + M3 + M4: viewer 세션의 정적 정보. */
export function mockViewerIdentity(viewerId: string) {
	const h = hash(viewerId);
	const device = DEVICES[h % DEVICES.length]!;

	return {
		peerId: `peer-${(h >>> 4).toString(36)}`,
		displayName: `viewer-${(h % 10000).toString().padStart(4, '0')}`,
		deviceFlag: device.flag,
		deviceClass: device.cls,
		networkType: device.cls === 'mobile' ? NETWORKS[3 + (h % 2)]! : NETWORKS[h % 3]!,
		userAgent: device.ua,
	};
}

/** M5: 접속 종료 사유. 마지막 transport 상태가 failed면 그것을 쓰고, 아니면 mock. */
export function mockDisconnectReason(viewerId: string, lastTransportState: string | null): string {
	if (lastTransportState === 'failed') {
		return 'transport_failed';
	}

	return DISCONNECT_REASONS[hash(viewerId) % DISCONNECT_REASONS.length]!;
}

/**
 * M2: 브라우저 보고값. 서버가 잰 loss와 어느 정도 맞물리게 만든다 (loss가 높으면 freeze도 잦다).
 * intervalMs 구간의 delta 값을 돌려준다.
 */
export function mockClientReport(viewerId: string, time: number, serverLossRatio: number | null, intervalMs: number) {
	const h = hash(`${viewerId}:${Math.floor(time / intervalMs)}`);
	const loss = serverLossRatio ?? 0;
	const r = (h % 1000) / 1000;
	const freezeCount = loss > 0.05 ? (r < 0.6 ? 1 + (h % 2) : 0) : loss > 0.02 ? (r < 0.25 ? 1 : 0) : r < 0.02 ? 1 : 0;

	return {
		clientFreezeCount: freezeCount,
		clientFreezeMs: freezeCount * (200 + (h % 600)),
		clientFps: Math.max(5, Math.round((30 - loss * 120 - (r < 0.1 ? 4 : 0)) * 10) / 10),
		clientJitterBufferMs: Math.round(40 + loss * 900 + (h % 30)),
		clientFramesDropped: Math.round(loss * 300 * (intervalMs / 10000) + (r < 0.1 ? 1 : 0)),
	};
}

/** M8: broadcaster fps. 활성 레이어가 있으면 30 근처. */
export function mockBroadcasterFps(broadcasterId: string, time: number, sending: boolean): number | null {
	if (!sending) {
		return 0;
	}

	const h = hash(`${broadcasterId}:${Math.floor(time / 10000)}`);

	return Math.round((29 + (h % 20) / 10) * 10) / 10;
}

/**
 * M2·M3·M4: viewer 상세의 "브라우저가 보고한 값" 중 DB에 없는 파생 값.
 * freeze·fps는 mockClientReport 값(DB에 저장된 mock)에서 이어서 만든다.
 */
export function mockViewerPlayback(viewerId: string, freezeCount: number | null, fps: number | null, spatialLayer: number | null) {
	const identity = mockViewerIdentity(viewerId);
	const heights = [180, 360, 720];
	const height = heights[spatialLayer ?? 1] ?? 360;
	const state = (freezeCount ?? 0) > 0 ? 'freeze' : (fps ?? 30) < 20 ? 'buffering' : 'playing';

	return {
		playbackState: state as 'playing' | 'buffering' | 'freeze',
		resolution: `${Math.round((height * 16) / 9)}×${height}`,
		downlinkMbps: identity.networkType === 'lte' ? 0.4 + (hash(viewerId) % 30) / 10 : 5 + (hash(viewerId) % 50),
		browser: browserLabel(identity.userAgent),
	};
}

/** M8: broadcaster 상세의 "브라우저가 보고한 값" (송출 브라우저 getStats). */
export function mockBroadcasterReport(broadcasterId: string, time: number, sending: boolean) {
	const h = hash(`${broadcasterId}:${Math.floor(time / 60000)}`);
	const limited = sending && h % 17 === 0;

	return {
		resolution: sending ? '1280×720' : null,
		framesPerSecond: mockBroadcasterFps(broadcasterId, time, sending),
		qualityLimitationReason: limited ? 'bandwidth' : 'none',
		qualityLimitationSeconds: { bandwidth: limited ? 12 : 0, cpu: 0 },
		availableOutgoingBitrateBps: sending ? 5_800_000 : null,
		encoder: 'VP8 · software',
		camera: sending ? '1280×720 @30' : '꺼짐',
		microphone: sending ? '활성 · opus 38 kbps' : '꺼짐',
		// 네트워크 종류·브라우저는 뺐다. 브라우저와 IP는 실제 값(originRoutes의 broadcasterLive)을 쓴다.
	};
}

function browserLabel(ua: string): string {
	const browser = /Firefox\/(\d+)/.exec(ua)?.[0]?.replace('/', ' ') ?? (/Chrome\/(\d+)/.test(ua) ? `Chrome ${/Chrome\/(\d+)/.exec(ua)![1]}` : `Safari ${/Version\/(\d+)/.exec(ua)?.[1] ?? ''}`);
	const os = /Android [\d.]+/.exec(ua)?.[0] ?? (/iPhone OS (\d+)/.test(ua) ? `iOS ${/iPhone OS (\d+)/.exec(ua)![1]}` : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : 'Linux');

	return `${browser.trim()} / ${os}`;
}

/** FNV-1a 32bit */
export function hash(text: string): number {
	let h = 0x811c9dc5;

	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}

	return h >>> 0;
}
