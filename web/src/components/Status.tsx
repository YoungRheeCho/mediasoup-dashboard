import type { ReactNode } from 'react';

import type { Meta } from '../lib/api';

/** 상태는 색만으로 구분하지 않는다: 아이콘 + 문구 (AGENT_TASK 7, 8). */
export type Level = 'ok' | 'info' | 'warn' | 'crit';

const ICON: Record<Level, string> = { ok: '✓', info: '●', warn: '▲', crit: '✕' };
const CLS: Record<Level, string> = { ok: 'ok', info: 'muted', warn: 'warn', crit: 'crit' };

export function StatusIcon({ level, label }: { level: Level; label?: string }) {
	return (
		<span className={CLS[level]} aria-label={label ?? level} role="img">
			{ICON[level]}
		</span>
	);
}

/** 아이콘 + 문구 */
export function Status({ level, children }: { level: Level; children: ReactNode }) {
	return (
		<span className={CLS[level]} style={{ whiteSpace: 'nowrap' }}>
			{ICON[level]} {children}
		</span>
	);
}

/** 임계값 기준으로 level 고르기 */
export function levelOf(value: number | null | undefined, warn: number | null | undefined, crit?: number | null): Level {
	if (value === null || value === undefined || warn === null || warn === undefined) {
		return 'info';
	}

	if (crit !== null && crit !== undefined && value > crit) {
		return 'crit';
	}

	return value > warn ? 'warn' : 'ok';
}

/** 값 앞에 경고 아이콘을 붙인다 (정상이면 값만). */
export function Flagged({ level, children }: { level: Level; children: ReactNode }) {
	if (level === 'warn' || level === 'crit') {
		return (
			<span className={CLS[level]}>
				{ICON[level]} {children}
			</span>
		);
	}

	return <>{children}</>;
}

const MOCK_TEXT: Record<string, string> = {
	M1: 'viewer↔peer 연결은 서버 코드 수정이 필요해 mock입니다 (M1)',
	M2: '브라우저 보고값은 클라이언트가 서버로 보내지 않아 mock입니다 (M2)',
	M3: '네트워크 종류는 브라우저만 알아 mock입니다 (M3)',
	M4: 'user agent 원문은 서버가 저장하지 않아 mock입니다 (M4)',
	M5: '접속 종료 사유는 서버가 내보내지 않아 mock입니다 (M5)',
	M8: 'broadcaster 브라우저 보고값(fps 등)은 mock입니다 (M8)',
};

/**
 * MOCK 배지. 서버 코드를 고쳐야 얻을 수 있는 값이라 임시로 만든 값임을 표시한다.
 * fields 중 하나라도 meta.mockFields에 있으면 보인다.
 */
export function Mock({ meta, fields, force }: { meta: Meta | undefined; fields?: string[]; force?: boolean }) {
	if (!meta?.mockEnabled) {
		return null;
	}

	const ids = new Set<string>();

	for (const f of fields ?? []) {
		const id = meta.mockFields[f] ?? (f.includes('.') ? meta.mockFields[`${f.split('.')[0]}.*`] : undefined);

		if (id) {
			ids.add(id);
		}
	}

	if (!force && ids.size === 0) {
		return null;
	}

	const title = [...ids].map(id => MOCK_TEXT[id] ?? id).join('\n') || '서버 코드 수정이 필요해 mock으로 채운 값입니다';

	return (
		<span className="mock" title={title} aria-label={`MOCK: ${title}`}>
			◇ MOCK
		</span>
	);
}
