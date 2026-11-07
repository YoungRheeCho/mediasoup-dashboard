import type { RawClientStats, RawTransport } from '../hookProtocol.js';

/**
 * 시청자 브라우저 보고값 (M2). 클라이언트(RoomClient.edge.js)가 5초마다 reportClientStats를 보내고,
 * 서버(Peer.ts)가 consumer transport appData.clientStats에 넣어 둔 것을 훅이 읽어 온다.
 */

/** 이보다 오래된 보고는 "보고 없음"으로 본다 (클라이언트 주기 5초의 3배). */
export const CLIENT_STATS_MAX_AGE_MS = 15_000;

/** 이 transport가 브라우저 보고를 한 번이라도 받았는지. 받았으면 mock으로 채우지 않는다. */
export function hasClientStats(t: Pick<RawTransport, 'clientStats'>): boolean {
	return Boolean(t.clientStats);
}

/** 최근 보고. 없거나 오래됐으면 null. */
export function freshClientStats(t: Pick<RawTransport, 'clientStats'>, now: number): RawClientStats | null {
	const s = t.clientStats;

	return s && s.at !== null && now - s.at <= CLIENT_STATS_MAX_AGE_MS ? s : null;
}

/** 예: "1280×720" */
export function resolutionOf(s: Pick<RawClientStats, 'width' | 'height'>): string | null {
	return s.width && s.height ? `${s.width}×${s.height}` : null;
}

/** mockViewerPlayback과 같은 기준: 구간에 freeze가 있으면 freeze, fps 20 미만이면 buffering. */
export function playbackStateOf(freezeCount: number | null, fps: number | null): 'playing' | 'buffering' | 'freeze' {
	return (freezeCount ?? 0) > 0 ? 'freeze' : fps !== null && fps < 20 ? 'buffering' : 'playing';
}
