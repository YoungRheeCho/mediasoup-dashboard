import type { EdgeBatch, OriginBatch } from '../db/rows.js';

/**
 * 알림 평가에 쓰는 지표 하나. metric 이름은 alert_rule.metric과 같다.
 * 알림 기준은 서버 값이다 (AGENT_TASK 4.2-7). mock 값(src/mock MOCK_FIELDS)과 브라우저 보고값은 쓰지 않는다.
 */
export type MetricSample = {
	metric: string;
	subjectType: 'worker' | 'room' | 'pipe' | 'viewer' | 'server' | 'broadcaster' | 'edge';
	subjectId: string | null;
	value: number;
};

/** viewer loss가 이 이상이면 "상태가 나쁜 viewer" (viewer.bad_ratio, Viewers 필터 "loss 5% 이상") */
export const BAD_VIEWER_LOSS = 0.05;

export function edgeMetrics(batch: EdgeBatch): MetricSample[] {
	const out: MetricSample[] = [];

	pushCommon(out, batch);

	// pipe loss: 방송별 이번 구간 sum(lost)/sum(expected)
	const pipe = new Map<string, { lost: number; expected: number }>();

	for (const p of batch.pipeSamples) {
		if (p.packetsExpected === null || p.packetsLost === null || p.packetsExpected <= 0) {
			continue;
		}

		const acc = pipe.get(p.roomId) ?? { lost: 0, expected: 0 };

		acc.lost += p.packetsLost;
		acc.expected += p.packetsExpected;
		pipe.set(p.roomId, acc);
	}

	for (const [roomId, acc] of pipe) {
		out.push({ metric: 'pipe.loss_ratio', subjectType: 'pipe', subjectId: roomId, value: acc.lost / acc.expected });
	}

	// viewer loss p50, 나쁜 viewer 비율: 방송별
	const perRoom = new Map<string, number[]>();

	for (const v of batch.viewerSamples) {
		if (v.packetsExpected === null || v.packetsLost === null || v.packetsExpected <= 0) {
			continue;
		}

		const list = perRoom.get(v.roomId) ?? [];

		list.push(v.packetsLost / v.packetsExpected);
		perRoom.set(v.roomId, list);
	}

	for (const [roomId, losses] of perRoom) {
		out.push({ metric: 'viewer.loss_ratio.p50', subjectType: 'room', subjectId: roomId, value: percentile(losses, 0.5) });
		out.push({
			metric: 'viewer.bad_ratio',
			subjectType: 'room',
			subjectId: roomId,
			value: losses.filter(l => l >= BAD_VIEWER_LOSS).length / losses.length,
		});
	}

	return out;
}

export function originMetrics(batch: OriginBatch): MetricSample[] {
	const out: MetricSample[] = [];

	pushCommon(out, batch);

	for (const b of batch.broadcasterSamples) {
		if (b.packetsExpected !== null && b.packetsLost !== null && b.packetsExpected > 0) {
			out.push({
				metric: 'broadcaster.loss_ratio',
				subjectType: 'broadcaster',
				subjectId: b.broadcasterId,
				value: b.packetsLost / b.packetsExpected,
			});
		}
	}

	const links = new Map<string, { lost: number; expected: number }>();

	for (const p of batch.pipeSendSamples) {
		if (p.packetsExpected === null || p.packetsLost === null || p.packetsExpected <= 0) {
			continue;
		}

		const key = `${p.roomId}→${p.edgeId ?? p.remoteIp}`;
		const acc = links.get(key) ?? { lost: 0, expected: 0 };

		acc.lost += p.packetsLost;
		acc.expected += p.packetsExpected;
		links.set(key, acc);
	}

	for (const [key, acc] of links) {
		out.push({ metric: 'pipe_send.loss_ratio', subjectType: 'pipe', subjectId: key, value: acc.lost / acc.expected });
	}

	return out;
}

function pushCommon(out: MetricSample[], batch: EdgeBatch | OriginBatch): void {
	for (const w of batch.workers) {
		if (w.cpuPct !== null) {
			out.push({ metric: 'worker.cpu_pct', subjectType: 'worker', subjectId: `w${w.workerIdx}`, value: w.cpuPct });
		}
	}

	if (batch.collector.eventLoopLagMs !== null) {
		out.push({ metric: 'collector.event_loop_lag_ms', subjectType: 'server', subjectId: null, value: batch.collector.eventLoopLagMs });
	}
}

export function percentile(values: number[], q: number): number {
	if (values.length === 0) {
		return NaN;
	}

	const sorted = [...values].sort((a, b) => a - b);
	const pos = (sorted.length - 1) * q;
	const lo = Math.floor(pos);
	const hi = Math.ceil(pos);

	return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}
