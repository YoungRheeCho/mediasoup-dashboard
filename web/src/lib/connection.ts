import { useSyncExternalStore } from 'react';

/**
 * 이 서버(사이드카)에 연결되는지에 대한 전역 상태 (AGENT_TASK 7-5).
 * 여러 화면 polling이 결과를 보고하고, 배너가 구독한다.
 */
export type ConnectionState = {
	ok: boolean;
	lastSuccessAt: number | null;
	failures: number;
	nextRetryAt: number | null;
	error: string | null;
};

let state: ConnectionState = { ok: true, lastSuccessAt: null, failures: 0, nextRetryAt: null, error: null };
const listeners = new Set<() => void>();
const retryers = new Set<() => void>();

function emit(next: ConnectionState): void {
	state = next;
	listeners.forEach(l => l());
}

export const connection = {
	reportSuccess(): void {
		emit({ ok: true, lastSuccessAt: Date.now(), failures: 0, nextRetryAt: null, error: null });
	},
	/** 연결 자체가 안 될 때만 (HTTP 0 / 5xx). 404 같은 응답은 연결 문제가 아니다. */
	reportFailure(error: string, nextRetryAt: number, failures: number): void {
		emit({ ...state, ok: false, error, nextRetryAt, failures: Math.max(state.failures, failures) });
	},
	/** "지금 다시 시도" — 등록된 모든 polling을 즉시 실행 */
	retryNow(): void {
		retryers.forEach(r => r());
	},
	registerRetry(fn: () => void): () => void {
		retryers.add(fn);

		return () => retryers.delete(fn);
	},
};

export function useConnection(): ConnectionState {
	return useSyncExternalStore(
		l => {
			listeners.add(l);

			return () => listeners.delete(l);
		},
		() => state
	);
}
