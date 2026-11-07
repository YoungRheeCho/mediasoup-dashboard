/** 표시 형식. 값 없음(null)은 "—"로 보여 0과 구분한다 (AGENT_TASK 4.2-5). */

export const DASH = '—';

export function pct(ratio: number | null | undefined, digits = 1): string {
	return ratio === null || ratio === undefined || !Number.isFinite(ratio) ? DASH : `${(ratio * 100).toFixed(digits)}%`;
}

export function pctNum(value: number | null | undefined, digits = 0): string {
	return value === null || value === undefined ? DASH : `${value.toFixed(digits)}`;
}

export function bps(v: number | null | undefined): string {
	if (v === null || v === undefined) {
		return DASH;
	}

	if (v >= 1e9) {
		return `${(v / 1e9).toFixed(1)} Gbps`;
	}

	if (v >= 1e6) {
		return `${(v / 1e6).toFixed(1)} Mbps`;
	}

	return `${Math.round(v / 1e3)} kbps`;
}

/** 값과 단위를 나눈 형태 (KPI 큰 숫자용) */
export function bpsParts(v: number | null | undefined): [string, string] {
	if (v === null || v === undefined) {
		return [DASH, ''];
	}

	if (v >= 1e9) {
		return [(v / 1e9).toFixed(1), 'Gbps'];
	}

	if (v >= 1e6) {
		return [(v / 1e6).toFixed(1), 'Mbps'];
	}

	return [String(Math.round(v / 1e3)), 'kbps'];
}

export function ms(v: number | null | undefined): string {
	return v === null || v === undefined ? DASH : `${Math.round(v)}ms`;
}

export function int(v: number | null | undefined): string {
	return v === null || v === undefined ? DASH : Math.round(v).toLocaleString('en-US');
}

export function bytes(v: number | null | undefined): string {
	if (v === null || v === undefined) {
		return DASH;
	}

	return v >= 1e9 ? `${(v / 1e9).toFixed(1)} GB` : `${Math.round(v / 1e6)} MB`;
}

/** 경과 시간 00:12:40 (하루 넘으면 1d 04h) */
export function duration(seconds: number | null | undefined): string {
	if (seconds === null || seconds === undefined || seconds < 0) {
		return DASH;
	}

	const s = Math.floor(seconds);

	if (s >= 86400) {
		return `${Math.floor(s / 86400)}d ${String(Math.floor((s % 86400) / 3600)).padStart(2, '0')}h`;
	}

	return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map(n => String(n).padStart(2, '0')).join(':');
}

export function since(iso: string | Date | null | undefined, now = Date.now()): number | null {
	if (!iso) {
		return null;
	}

	return Math.max(0, (now - new Date(iso).getTime()) / 1000);
}

/** "N초 전 / N분 전" */
export function ago(seconds: number | null | undefined): string {
	if (seconds === null || seconds === undefined) {
		return DASH;
	}

	if (seconds < 60) {
		return `${Math.round(seconds)}초 전`;
	}

	if (seconds < 3600) {
		return `${Math.round(seconds / 60)}분 전`;
	}

	if (seconds < 86400) {
		return `${Math.round(seconds / 3600)}시간 전`;
	}

	return `${Math.round(seconds / 86400)}일 전`;
}

export function clock(iso: string | Date | null | undefined, withSeconds = false): string {
	if (!iso) {
		return DASH;
	}

	const d = new Date(iso);

	return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: withSeconds ? '2-digit' : undefined, hour12: false });
}

export function shortId(id: string, head = 6): string {
	return id.length > head + 4 ? `${id.slice(0, head)}…${id.slice(-3)}` : id;
}

/** spatial layer 표기. 예: 2 → "L2(High)" (server/src/api/live.ts의 layerName과 같다). */
export function layerLabel(spatial: number | null | undefined): string | null {
	return spatial === null || spatial === undefined ? null : `L${spatial}(${spatial >= 2 ? 'High' : spatial === 1 ? 'Mid' : 'Low'})`;
}
