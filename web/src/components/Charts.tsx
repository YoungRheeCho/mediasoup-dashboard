import { useCallback, useEffect, useRef, useState } from 'react';

import { DASH } from '../lib/format';

const COLORS = { blue: 'var(--blue)', yellow: 'var(--yellow)', red: 'var(--red)', green: 'var(--green)', orange: 'var(--orange)', grid: 'var(--chart-grid)' };

export type Series = {
	label: string;
	color?: string;
	points: Array<{ t: string | number | Date; v: number | null }>;
	dashed?: boolean;
};

/**
 * 요소 너비. 노드가 붙는 순간 바로 한 번 재고(늦게 마운트돼도 빈 차트가 되지 않게), 이후 크기 변화를 따라간다.
 * 빈 상태 ↔ 차트처럼 노드가 바뀌어도 새 노드를 다시 관찰한다.
 */
function useWidth<T extends HTMLElement>(): [(node: T | null) => void, number] {
	const [width, setWidth] = useState(0);
	const observer = useRef<ResizeObserver | null>(null);

	const ref = useCallback((node: T | null) => {
		observer.current?.disconnect();
		observer.current = null;

		if (!node) {
			return;
		}

		setWidth(Math.floor(node.getBoundingClientRect().width));
		observer.current = new ResizeObserver(entries => setWidth(Math.floor(entries[0]!.contentRect.width)));
		observer.current.observe(node);
	}, []);

	useEffect(() => () => observer.current?.disconnect(), []);

	return [ref, width];
}

const ts = (t: string | number | Date) => (t instanceof Date ? t.getTime() : typeof t === 'number' ? t : new Date(t).getTime());

/**
 * 시계열 선 차트. x축은 시간, 왼쪽 끝과 "now" 라벨. 임계값 점선과 마지막 점을 표시한다.
 * 값 없음(null) 구간은 선을 끊는다.
 */
export function LineChart({
	series,
	height = 140,
	threshold,
	thresholdLabel = '임계치',
	yMax,
	format = v => String(Math.round(v * 10) / 10),
	xLabel = ['', 'now'],
	from,
	to,
}: {
	series: Series[];
	height?: number;
	threshold?: number | null;
	thresholdLabel?: string;
	yMax?: number;
	format?: (v: number) => string;
	xLabel?: [string, string];
	from?: number;
	to?: number;
}) {
	const [ref, width] = useWidth<HTMLDivElement>();
	const [hover, setHover] = useState<number | null>(null);
	const pad = { l: 36, r: 10, t: 10, b: 22 };
	const all = series.flatMap(s => s.points.filter(p => p.v !== null).map(p => ({ x: ts(p.t), y: p.v as number })));
	const x0 = from ?? Math.min(...all.map(p => p.x));
	const x1 = to ?? Math.max(...all.map(p => p.x));
	const dataMax = Math.max(0, ...all.map(p => p.y), threshold ?? 0);
	const top = yMax ?? niceMax(dataMax * 1.15 || 1);
	const w = Math.max(0, width - pad.l - pad.r);
	const h = height - pad.t - pad.b;
	const sx = (x: number) => pad.l + (x1 > x0 ? ((x - x0) / (x1 - x0)) * w : w);
	const sy = (y: number) => pad.t + h - (Math.min(y, top) / top) * h;

	if (all.length === 0) {
		return (
			<div ref={ref} className="chart empty" style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
				⊖ 이 구간에 기록이 없습니다
			</div>
		);
	}

	const hovered =
		hover === null
			? null
			: series.map(s => {
					let best: { t: number; v: number | null } | null = null;

					for (const p of s.points) {
						const x = ts(p.t);

						if (!best || Math.abs(sx(x) - hover) < Math.abs(sx(best.t) - hover)) {
							best = { t: x, v: p.v };
						}
					}

					return { label: s.label, color: s.color ?? COLORS.blue, ...best! };
				});

	return (
		<div ref={ref} className="chart" onMouseLeave={() => setHover(null)}>
			{width > 0 && (
				<svg
					width={width}
					height={height}
					onMouseMove={e => setHover(e.clientX - e.currentTarget.getBoundingClientRect().left)}
					role="img"
					aria-label={series.map(s => s.label).join(', ')}
				>
					{[0, 0.5, 1].map(f => (
						<g key={f}>
							<line x1={pad.l} x2={pad.l + w} y1={sy(top * f)} y2={sy(top * f)} style={{ stroke: COLORS.grid }} />
							<text x={pad.l - 6} y={sy(top * f) + 4} textAnchor="end">
								{format(top * f)}
							</text>
						</g>
					))}
					{threshold !== null && threshold !== undefined && threshold <= top && (
						<g>
							<line x1={pad.l} x2={pad.l + w} y1={sy(threshold)} y2={sy(threshold)} strokeDasharray="5 4" style={{ stroke: COLORS.yellow }} />
							<text x={pad.l + w - 4} y={sy(threshold) - 5} textAnchor="end" style={{ fill: COLORS.yellow }}>
								{thresholdLabel}
							</text>
						</g>
					)}
					{series.map(s => {
						const color = s.color ?? COLORS.blue;
						const segs: string[] = [];
						let cur = '';

						for (const p of s.points) {
							if (p.v === null) {
								if (cur) segs.push(cur);
								cur = '';
								continue;
							}

							cur += `${cur ? 'L' : 'M'}${sx(ts(p.t)).toFixed(1)},${sy(p.v).toFixed(1)}`;
						}

						if (cur) segs.push(cur);

						const last = [...s.points].reverse().find(p => p.v !== null);

						return (
							<g key={s.label}>
								{segs.map((d, i) => (
									<path key={i} d={d} fill="none" strokeWidth={2} style={{ stroke: color }} strokeDasharray={s.dashed ? '4 3' : undefined} strokeLinejoin="round" />
								))}
								{last && <circle cx={sx(ts(last.t))} cy={sy(last.v!)} r={4} style={{ fill: color }} />}
							</g>
						);
					})}
					<text x={pad.l} y={height - 4}>
						{xLabel[0]}
					</text>
					<text x={pad.l + w} y={height - 4} textAnchor="end">
						{xLabel[1]}
					</text>
					{hover !== null && hover >= pad.l && hover <= pad.l + w && <line x1={hover} x2={hover} y1={pad.t} y2={pad.t + h} style={{ stroke: 'var(--border-strong)' }} />}
				</svg>
			)}
			{hovered && hover !== null && hover >= pad.l && (
				<div className="tip" style={{ left: Math.min(hover + 10, Math.max(0, width - 170)), top: 4 }}>
					<div className="muted">{new Date(hovered[0]?.t ?? 0).toLocaleTimeString('ko-KR', { hour12: false })}</div>
					{hovered.map(h => (
						<div key={h.label}>
							<span className="swatch" style={{ background: h.color }} />
							{h.label} {h.v === null ? DASH : format(h.v)}
						</div>
					))}
				</div>
			)}
		</div>
	);
}

/** 작은 추이선 (worker 카드 등). 축 없음. */
export function Sparkline({ points, height = 36, color = COLORS.blue, max }: { points: Array<number | null>; height?: number; color?: string; max?: number }) {
	const [ref, width] = useWidth<HTMLDivElement>();
	const vals = points.filter((v): v is number => v !== null);
	const top = max ?? Math.max(1, ...vals) * 1.1;
	const step = points.length > 1 ? width / (points.length - 1) : 0;
	let d = '';

	points.forEach((v, i) => {
		if (v !== null) {
			d += `${d ? 'L' : 'M'}${(i * step).toFixed(1)},${(height - 4 - (v / top) * (height - 8)).toFixed(1)}`;
		}
	});

	const lastIdx = points.length - 1 - [...points].reverse().findIndex(v => v !== null);
	const last = points[lastIdx];

	return (
		<div ref={ref} className="chart" style={{ height }}>
			{width > 0 && vals.length > 0 && (
				<svg width={width} height={height} aria-hidden>
					<path d={d} fill="none" strokeWidth={1.5} style={{ stroke: color }} />
					{last !== null && last !== undefined && <circle cx={lastIdx * step} cy={height - 4 - (last / top) * (height - 8)} r={3} style={{ fill: color }} />}
				</svg>
			)}
		</div>
	);
}

/** 구간 분포 막대. highlightFrom 이상 구간은 노랑. */
export function Histogram({ bins, height = 120, highlightFrom }: { bins: Array<{ label: string; viewers: number }>; height?: number; highlightFrom?: number }) {
	const max = Math.max(1, ...bins.map(b => b.viewers));

	return (
		<div className="chart" role="img" aria-label="분포">
			<div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height }}>
				{bins.map((b, i) => (
					<div
						key={b.label}
						title={`${b.label}: ${b.viewers}명`}
						style={{
							flex: 1,
							height: `${Math.max(b.viewers > 0 ? 3 : 1, (b.viewers / max) * 100)}%`,
							background: highlightFrom !== undefined && i >= highlightFrom ? COLORS.yellow : COLORS.blue,
							borderRadius: '2px 2px 0 0',
							opacity: b.viewers === 0 ? 0.35 : 1,
						}}
					/>
				))}
			</div>
			<div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
				{bins.map(b => (
					<div key={b.label} className="mono faint" style={{ flex: 1, textAlign: 'center', fontSize: 11 }}>
						{b.label}
					</div>
				))}
			</div>
		</div>
	);
}

/** 시간별 횟수 막대 (Alerts 24시간) */
export function CountBars({ items, height = 70 }: { items: Array<{ t: string; count: number }>; height?: number }) {
	const max = Math.max(1, ...items.map(i => i.count));

	return (
		<div>
			<div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height }}>
				{items.map(i => (
					<div
						key={i.t}
						title={`${new Date(i.t).toLocaleTimeString('ko-KR', { hour: '2-digit', hour12: false })}시 · ${i.count}건`}
						style={{ flex: 1, height: i.count ? `${(i.count / max) * 100}%` : 3, background: i.count ? COLORS.yellow : COLORS.grid, borderRadius: 2 }}
					/>
				))}
			</div>
			<div className="mono faint" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginTop: 6 }}>
				<span>-24h</span>
				<span>-18h</span>
				<span>-12h</span>
				<span>-6h</span>
				<span>now</span>
			</div>
		</div>
	);
}

/** 레이어 비율 (L2(High) / L1(Mid) / L0(Low)) */
export function LayerBar({ mix }: { mix: { high: number; mid: number; low: number; unknown?: number } }) {
	const total = mix.high + mix.mid + mix.low;
	const parts = [
		{ k: 'L2(High)', v: mix.high, c: 'var(--blue)' },
		{ k: 'L1(Mid)', v: mix.mid, c: 'var(--blue-2)' },
		{ k: 'L0(Low)', v: mix.low, c: 'var(--blue-3)' },
	];

	if (total === 0) {
		return <div className="muted small">⊖ 레이어 정보 없음</div>;
	}

	return (
		<div>
			<div className="stack" role="img" aria-label="레이어 비율">
				{parts.map(p => (p.v > 0 ? <span key={p.k} style={{ flex: p.v, background: p.c }} title={`${p.k} ${p.v}명`} /> : null))}
			</div>
			<div className="legend">
				{parts.map(p => (
					<span key={p.k}>
						{p.k} {Math.round((p.v / total) * 100)}%
					</span>
				))}
			</div>
		</div>
	);
}

export function Bar({ value, max = 100, level }: { value: number | null; max?: number; level?: 'warn' | 'crit' | null }) {
	return (
		<div className={`bar ${level ?? ''}`} role="meter" aria-valuenow={value ?? undefined} aria-valuemax={max}>
			<span style={{ width: `${value === null ? 0 : Math.min(100, (value / max) * 100)}%` }} />
		</div>
	);
}

function niceMax(v: number): number {
	const exp = Math.pow(10, Math.floor(Math.log10(v)));
	const f = v / exp;

	return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * exp;
}

export { COLORS };
