import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, getJson } from './api';
import { connection } from './connection';

/** 서버 연결 불가 시 재시도 간격 (AGENT_TASK 7-5: 2→4→8초로 늘리다 30초에서 멈춤) */
export const RETRY_STEPS_MS = [2000, 4000, 8000, 16000, 30000];

export type PollState<T> = {
	data: T | null;
	/** 마지막 요청이 실패했으면 그 사유 (이전 data는 남겨 둔다) */
	error: string | null;
	/** 404처럼 연결은 됐지만 대상이 없는 경우 */
	status: number | null;
	/** 첫 응답 전 */
	loading: boolean;
	/** 첫 응답이 5초 넘게 없음 → "수집기 응답이 늦습니다" (AGENT_TASK 7-1) */
	slow: boolean;
	lastSuccessAt: number | null;
	paused: boolean;
	refresh: () => void;
};

/**
 * 주기 갱신 (AGENT_TASK 3-8).
 *  - intervalMs마다 다시 읽는다. 목록·개요는 10초, 상세는 2초.
 *  - 탭이 백그라운드면 멈추고, 돌아오면 즉시 1회 읽는다.
 *  - 실패하면 이전 값을 지우지 않고 2→4→8→16→30초 간격으로 재시도한다.
 *  - path가 null이면 아무것도 하지 않는다.
 */
export function usePolling<T>(path: string | null, intervalMs: number): PollState<T> {
	const [state, setState] = useState<Omit<PollState<T>, 'refresh'>>({
		data: null,
		error: null,
		status: null,
		loading: true,
		slow: false,
		lastSuccessAt: null,
		paused: false,
	});
	const timer = useRef<number | null>(null);
	const failures = useRef(0);
	const controller = useRef<AbortController | null>(null);
	const run = useRef<() => void>(() => {});

	useEffect(() => {
		if (!path) {
			return;
		}

		let disposed = false;

		setState({ data: null, error: null, status: null, loading: true, slow: false, lastSuccessAt: null, paused: document.hidden });
		failures.current = 0;

		const slowTimer = window.setTimeout(() => !disposed && setState(s => (s.loading ? { ...s, slow: true } : s)), 5000);

		const schedule = (ms: number) => {
			if (timer.current !== null) {
				window.clearTimeout(timer.current);
			}

			timer.current = document.hidden ? null : window.setTimeout(() => void tick(), ms);
		};

		const tick = async () => {
			if (disposed || document.hidden) {
				return;
			}

			controller.current?.abort();
			controller.current = new AbortController();

			try {
				const data = await getJson<T>(path, controller.current.signal);

				if (disposed) {
					return;
				}

				failures.current = 0;
				connection.reportSuccess();
				setState(s => ({ ...s, data, error: null, status: 200, loading: false, slow: false, lastSuccessAt: Date.now() }));
				schedule(intervalMs);
			} catch (error) {
				if (disposed || (error as Error).name === 'AbortError') {
					return;
				}

				const status = error instanceof ApiError ? error.status : 0;
				const connectionProblem = status === 0 || status >= 500;

				if (connectionProblem) {
					failures.current++;

					const delay = RETRY_STEPS_MS[Math.min(failures.current - 1, RETRY_STEPS_MS.length - 1)]!;

					connection.reportFailure((error as Error).message, Date.now() + delay, failures.current);
					setState(s => ({ ...s, error: (error as Error).message, status, loading: s.data === null && s.loading }));
					schedule(delay);
				} else {
					connection.reportSuccess();
					setState(s => ({ ...s, error: (error as Error).message, status, loading: false, slow: false }));
					schedule(intervalMs);
				}
			}
		};

		const onVisibility = () => {
			if (document.hidden) {
				if (timer.current !== null) {
					window.clearTimeout(timer.current);
					timer.current = null;
				}

				controller.current?.abort();
				setState(s => ({ ...s, paused: true }));
			} else {
				setState(s => ({ ...s, paused: false }));
				void tick();
			}
		};

		run.current = () => void tick();
		document.addEventListener('visibilitychange', onVisibility);

		const unregister = connection.registerRetry(() => void tick());

		void tick();

		return () => {
			disposed = true;
			window.clearTimeout(slowTimer);

			if (timer.current !== null) {
				window.clearTimeout(timer.current);
			}

			controller.current?.abort();
			document.removeEventListener('visibilitychange', onVisibility);
			unregister();
		};
	}, [path, intervalMs]);

	const refresh = useCallback(() => run.current(), []);

	return { ...state, refresh };
}

/** 1초마다 다시 그려 "N초 전" 표시를 갱신한다. */
export function useNow(intervalMs = 1000): number {
	const [now, setNow] = useState(Date.now());

	useEffect(() => {
		const t = window.setInterval(() => setNow(Date.now()), intervalMs);

		return () => window.clearInterval(t);
	}, [intervalMs]);

	return now;
}
