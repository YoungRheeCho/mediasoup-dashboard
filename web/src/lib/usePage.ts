import { useSearchParams } from 'react-router-dom';

import type { ApiResponse, Panel } from './api';
import { panelOf } from './api';
import { usePolling } from './usePolling';

/** 화면 하나의 데이터: 주기 갱신 + 패널 꺼내기. */
export function usePage(path: string | null, refreshSeconds: number) {
	const poll = usePolling<ApiResponse>(path, refreshSeconds * 1000);

	return {
		...poll,
		meta: poll.data?.meta,
		p: <T = any>(name: string): Panel<T> | undefined => panelOf<T>(poll.data, name),
	};
}

/** 기간 선택을 URL(?range=)에 둔다. 새로 고침해도 유지된다. */
export function useRange(fallback: string): [string, (v: string) => void] {
	const [params, setParams] = useSearchParams();
	const value = params.get('range') ?? fallback;

	return [
		value,
		v => {
			const next = new URLSearchParams(params);

			next.set('range', v);
			setParams(next, { replace: true });
		},
	];
}
