/** 사이드카 API 응답 형식 (docs/api.md). */

export type Panel<T> =
	| { ok: true; data: T; excluded?: string[]; mock?: string[]; note?: string }
	| { ok: false; error: string; reason: 'error' | 'not_implemented' | 'not_found' };

export type Meta = {
	serverId: string;
	mode: 'edge' | 'origin';
	generatedAt: string;
	source: 'hook' | 'sim';
	collector: { ok: boolean; lastSuccessAt: string | null; ageSeconds: number | null; lastError: string | null; skippedCycles: number };
	db: { writePending: number; lastError: string | null };
	refresh: { listSeconds: number; detailSeconds: number };
	mockEnabled: boolean;
	mockFields: Record<string, string>;
	originUrl: string | null;
};

export type ApiResponse = { meta: Meta; panels: Record<string, Panel<any>> };

export type MetaResponse = {
	meta: Meta;
	rules: Array<{ ruleId: string; title: string; metric: string; warnAbove: number | null; critAbove: number | null; windowSeconds: number }>;
	publicUrl: string;
};

export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
	}
}

export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
	let res: Response;

	try {
		res = await fetch(path, { signal, headers: { accept: 'application/json' } });
	} catch (error) {
		if ((error as Error).name === 'AbortError') {
			throw error;
		}

		throw new ApiError(0, '서버에 연결할 수 없습니다');
	}

	let body: unknown;

	try {
		body = await res.json();
	} catch {
		throw new ApiError(res.status, `응답을 읽을 수 없습니다 (HTTP ${res.status})`);
	}

	if (!res.ok) {
		throw new ApiError(res.status, (body as { error?: string })?.error ?? `HTTP ${res.status}`);
	}

	return body as T;
}

/** 패널 하나 꺼내기. 응답 전이면 undefined. */
export function panelOf<T = any>(res: ApiResponse | null, name: string): Panel<T> | undefined {
	return res?.panels[name] as Panel<T> | undefined;
}
