import type { RawHealth, RawSnapshot, RawTransportDetail } from '../hookProtocol.js';

/**
 * mediasoup 입력. 실제(hook)와 로컬 개발용 시뮬레이터(sim)가 같은 원시 형식을 돌려준다.
 */
export interface MediasoupSource {
	readonly kind: 'hook' | 'sim';
	health(): Promise<RawHealth>;
	snapshot(): Promise<RawSnapshot>;
	transportDetail(transportId: string): Promise<RawTransportDetail>;
	close(): void;
}
