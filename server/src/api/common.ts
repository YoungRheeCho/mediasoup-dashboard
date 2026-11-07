import type { Config } from '../config.js';
import type { Collector } from '../collector/collector.js';
import type { BatchWriter } from '../db/writer.js';
import { HttpError } from '../http/server.js';
import { createLogger } from '../log.js';
import { MOCK_FIELDS } from '../mock/index.js';

const logger = createLogger('api');

/**
 * 모든 API 응답의 형식.
 *  - meta: 이 서버, 수집 상태(stale 판단용 시각), mock 필드 목록, 갱신 주기.
 *  - panels: 화면 패널마다 따로 성공/실패를 담는다 (AGENT_TASK 7-4 부분 실패).
 */
export type ApiResponse = { meta: Meta; panels: Record<string, Panel<unknown>> };

export type Panel<T> =
	| { ok: true; data: T; excluded?: string[]; mock?: string[]; note?: string }
	| { ok: false; error: string; reason: 'error' | 'not_implemented' | 'not_found' };

export type Meta = {
	serverId: string;
	mode: Config['mode'];
	generatedAt: string;
	/** 'sim'이면 화면에 SIMULATED 표시 */
	source: 'hook' | 'sim';
	collector: {
		ok: boolean;
		/** 화면의 "마지막 수신 N초 전" 기준 (수집 서버 시각) */
		lastSuccessAt: string | null;
		ageSeconds: number | null;
		lastError: string | null;
		skippedCycles: number;
	};
	db: { writePending: number; lastError: string | null };
	refresh: { listSeconds: number; detailSeconds: number };
	mockEnabled: boolean;
	/** "테이블.컬럼" 또는 화면 파생 값 → mock 번호 (docs/collection-design.md M1~M8) */
	mockFields: Record<string, string>;
	originUrl: string | null;
};

export type ApiContext = {
	config: Config;
	collector: Collector;
	writer: BatchWriter;
};

export function meta(ctx: ApiContext): Meta {
	const s = ctx.collector.status;
	const last = s.lastSuccessAt;

	return {
		serverId: ctx.config.serverId,
		mode: ctx.config.mode,
		generatedAt: new Date().toISOString(),
		source: ctx.config.mediasoupSource,
		collector: {
			ok: s.ok,
			lastSuccessAt: last?.toISOString() ?? null,
			ageSeconds: last ? Math.round((Date.now() - last.getTime()) / 1000) : null,
			lastError: s.lastError,
			skippedCycles: s.skippedCycles,
		},
		db: { writePending: ctx.writer.pending, lastError: ctx.writer.lastError },
		refresh: { listSeconds: Math.round(ctx.config.collectIntervalMs / 1000), detailSeconds: 2 },
		mockEnabled: ctx.config.mockEnabled,
		mockFields: ctx.config.mockEnabled ? MOCK_FIELDS : {},
		originUrl: ctx.config.mode === 'edge' ? ctx.config.liveness.originUrl : null,
	};
}

/** 패널 하나를 계산한다. 실패해도 다른 패널에 영향을 주지 않는다. */
export async function panel<T>(name: string, fn: () => Promise<T | Panel<T>> | T | Panel<T>): Promise<Panel<T>> {
	try {
		const result = await fn();

		if (result && typeof result === 'object' && 'ok' in result && (result.ok === true || result.ok === false) && ('data' in result || 'error' in result)) {
			return result as Panel<T>;
		}

		return { ok: true, data: result as T };
	} catch (error) {
		logger.warn('panel %s failed: %s', name, (error as Error).message);

		return { ok: false, error: (error as Error).message, reason: 'error' };
	}
}

/** 여러 패널을 병렬로 계산해 응답을 만든다. */
export async function respond(ctx: ApiContext, panels: Record<string, () => unknown>): Promise<{ body: ApiResponse }> {
	const names = Object.keys(panels);
	const results = await Promise.all(names.map(name => panel(name, panels[name] as () => unknown)));

	return { body: { meta: meta(ctx), panels: Object.fromEntries(names.map((n, i) => [n, results[i]!])) } };
}

export function notImplemented(note: string): Panel<never> {
	return { ok: false, error: note, reason: 'not_implemented' };
}

/** 화면의 기간 선택 (5m / 1h / 6h / 24h). bucket은 차트 점 간격. */
export const RANGES: Record<string, { seconds: number; bucketSeconds: number }> = {
	'5m': { seconds: 300, bucketSeconds: 10 },
	'15m': { seconds: 900, bucketSeconds: 10 },
	'1h': { seconds: 3600, bucketSeconds: 60 },
	'6h': { seconds: 21600, bucketSeconds: 300 },
	'24h': { seconds: 86400, bucketSeconds: 3600 },
};

export function parseRange(value: string | null, fallback = '5m'): { from: Date; to: Date; bucketSeconds: number; key: string } {
	const key = value ?? fallback;
	const range = RANGES[key];

	if (!range) {
		throw new HttpError(400, `invalid range: ${key} (use ${Object.keys(RANGES).join(', ')})`);
	}

	const to = new Date();

	return { from: new Date(to.getTime() - range.seconds * 1000), to, bucketSeconds: range.bucketSeconds, key };
}

/** 접속 전체(session) 구간: 시작 시각부터 지금까지. bucket은 점이 120개 안팎이 되게. */
export function sessionRange(since: Date): { from: Date; to: Date; bucketSeconds: number; key: string } {
	const to = new Date();
	const seconds = Math.max(60, (to.getTime() - since.getTime()) / 1000);
	const bucketSeconds = [10, 30, 60, 300, 900, 3600].find(b => seconds / b <= 150) ?? 3600;

	return { from: since, to, bucketSeconds, key: 'session' };
}

export function num(value: string | null): number | undefined {
	if (value === null || value === '') {
		return undefined;
	}

	const n = Number(value);

	if (!Number.isFinite(n)) {
		throw new HttpError(400, `invalid number: ${value}`);
	}

	return n;
}

/** 분당 비율로 환산 (구간 delta → /분). */
export function perMinute(count: number | null, seconds: number): number | null {
	return count === null || seconds <= 0 ? null : Math.round((count / seconds) * 60 * 10) / 10;
}
