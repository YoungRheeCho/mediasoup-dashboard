import { useEffect, useState } from 'react';

/**
 * 라이트/다크 테마. 사용자가 고른 값은 이 브라우저에만 저장하고(localStorage), 고른 적이 없으면 시스템 설정을 따른다.
 * <html data-theme="light|dark">로 styles.css의 토큰이 바뀐다. 차트도 CSS 변수를 쓰므로 같이 바뀐다.
 */
export type Theme = 'light' | 'dark';

const KEY = 'msdash-theme';

function stored(): Theme | null {
	try {
		const v = localStorage.getItem(KEY);

		return v === 'light' || v === 'dark' ? v : null;
	} catch {
		return null;
	}
}

function system(): Theme {
	return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** 첫 그리기 전에 부른다 (main.tsx). 깜박임 없이 바로 맞는 테마로 시작한다. */
export function applyInitialTheme(): void {
	// ?theme=light|dark 로 이 탭만 바꿀 수 있다 (캡처·공유용, 저장하지 않음)
	const q = new URLSearchParams(location.search).get('theme');
	const fromUrl = q === 'light' || q === 'dark' ? q : null;

	document.documentElement.dataset.theme = fromUrl ?? stored() ?? system();
}

export function useTheme(): [Theme, () => void] {
	const [theme, setTheme] = useState<Theme>(() => (document.documentElement.dataset.theme as Theme) ?? 'dark');

	useEffect(() => {
		document.documentElement.dataset.theme = theme;
	}, [theme]);

	const toggle = () =>
		setTheme(t => {
			const next = t === 'dark' ? 'light' : 'dark';

			try {
				localStorage.setItem(KEY, next);
			} catch {
				// 저장 못 해도 이번 화면에는 적용된다
			}

			return next;
		});

	return [theme, toggle];
}
