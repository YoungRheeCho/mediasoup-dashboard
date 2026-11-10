import type { RawHealth, RawSnapshot, RawTransportDetail } from '../hookProtocol.js';

/**
 * mediasoup 입력. 실제(hook)와 로컬 개발용 시뮬레이터(sim)가 같은 원시 형식을 돌려준다.
 */
export interface MediasoupSource {
	readonly kind: 'hook' | 'sim';
	health(): Promise<RawHealth>;
	/** spreadMs: 훅이 getStats() 호출을 이 시간 동안 고르게 나눠 보낸다 (0 = 한꺼번에). */
	snapshot(opts?: { spreadMs?: number }): Promise<RawSnapshot>;
	transportDetail(transportId: string): Promise<RawTransportDetail>;
	close(): void;
}
