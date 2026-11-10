import type {
	Batch,
	BroadcasterSampleRow,
	EdgeBatch,
	EdgeRoomSampleRow,
	OriginBatch,
	OriginRoomSampleRow,
	PipeSampleRow,
	PipeSendSampleRow,
	ViewerSampleRow,
	WorkerSampleRow,
} from './rows.js';

/**
 * 1초 수집 묶음을 DB 기록 주기(기본 10초)로 합친다.
 *
 * 수집은 화면 실시간 갱신을 위해 1초마다 하지만, DB에 1초마다 쓰면 viewer 행이 10배가 된다.
 * 그래서 메모리의 최신값(collector.latest)은 1초마다 바뀌고, DB 기록과 알림 평가는 합친 묶음으로 한다.
 * 합친 묶음은 예전 10초 수집 한 번과 같은 의미가 되도록 만든다.
 *  - delta 칸(packets*, nack, pli, freeze 횟수·시간, dropped)은 더한다.
 *  - 순간 속도(bitrate, cpu)는 평균, 상태값(rtt, layer, state, fps)은 마지막 값.
 *  - 세션 시작·종료, 링크 상태 변화는 순서대로 모두 넘긴다.
 */
export class BatchDownsampler {
	#pending: Batch[] = [];
	#firstAt = 0;

	constructor(private readonly intervalMs: number) {}

	/** 묶음을 넣는다. 기록 주기가 찼으면 합친 묶음을 돌려준다. */
	add(batch: Batch, now = batch.time.getTime()): Batch | null {
		if (this.#pending.length > 0 && this.#pending[0]!.mode !== batch.mode) {
			this.#pending = [];
		}

		if (this.#pending.length === 0) {
			this.#firstAt = now;
		}

		this.#pending.push(batch);

		// 첫 묶음 시각부터 (주기 - 수집 한 번) 이상 지났으면 내보낸다. 예: 10초 주기, 1초 수집 → 10개째에 내보냄.
		// 타이머가 몇 ms 일찍 깨도 한 묶음씩 밀리지 않도록 0.5초 여유를 둔다.
		if (this.intervalMs <= 0 || now - this.#firstAt >= this.intervalMs - this.#step() - 500) {
			return this.flush();
		}

		return null;
	}

	/** 남은 묶음을 합쳐서 돌려준다 (종료 시). */
	flush(): Batch | null {
		const list = this.#pending;

		this.#pending = [];

		if (list.length === 0) {
			return null;
		}

		return list.length === 1 ? list[0]! : mergeBatches(list);
	}

	/** 들어오는 묶음 사이 간격 추정 (처음 두 개로). 모르면 0. */
	#step(): number {
		const p = this.#pending;

		return p.length >= 2 ? Math.max(0, p[1]!.time.getTime() - p[0]!.time.getTime()) : 0;
	}
}

export function mergeBatches(list: Batch[]): Batch {
	const last = list[list.length - 1]!;

	if (last.mode === 'edge') {
		return mergeEdge(list as EdgeBatch[]);
	}

	return mergeOrigin(list as OriginBatch[]);
}

function mergeEdge(list: EdgeBatch[]): EdgeBatch {
	const last = list[list.length - 1]!;

	return {
		mode: 'edge',
		time: last.time,
		rooms: union(list.map(b => b.rooms)),
		collector: mergeCollector(list),
		workers: mergeWorkers(list.flatMap(b => b.workers), last.time),
		roomSamples: mergeBy(
			list.flatMap(b => b.roomSamples),
			r => `${r.roomId}\u0000${r.workerIdx}`,
			(rows): EdgeRoomSampleRow => {
				const l = rows[rows.length - 1]!;

				return { ...l, time: last.time, outBitrateBps: avg(rows.map(r => r.outBitrateBps)), inBitrateBps: avg(rows.map(r => r.inBitrateBps)) };
			},
			last.time
		),
		pipeSamples: mergeBy(
			list.flatMap(b => b.pipeSamples),
			r => `${r.roomId}\u0000${r.producerId}`,
			(rows): PipeSampleRow => {
				const l = rows[rows.length - 1]!;

				return {
					...l,
					time: last.time,
					packetsExpected: sum(rows.map(r => r.packetsExpected)),
					packetsLost: sum(rows.map(r => r.packetsLost)),
					packetsRepaired: sum(rows.map(r => r.packetsRepaired)),
					nackCount: sum(rows.map(r => r.nackCount)),
					pliCount: sum(rows.map(r => r.pliCount)),
					bitrateBps: avg(rows.map(r => r.bitrateBps)),
					rttMs: lastValue(rows.map(r => r.rttMs)),
					jitterMs: lastValue(rows.map(r => r.jitterMs)),
				};
			},
			last.time
		),
		viewerSamples: mergeBy(
			list.flatMap(b => b.viewerSamples),
			r => r.viewerId,
			(rows): ViewerSampleRow => {
				const l = rows[rows.length - 1]!;

				return {
					...l,
					time: last.time,
					packetsExpected: sum(rows.map(r => r.packetsExpected)),
					packetsLost: sum(rows.map(r => r.packetsLost)),
					nackCount: sum(rows.map(r => r.nackCount)),
					packetsRetransmitted: sum(rows.map(r => r.packetsRetransmitted)),
					bitrateBps: avg(rows.map(r => r.bitrateBps)),
					rttMs: lastValue(rows.map(r => r.rttMs)),
					spatialLayer: lastValue(rows.map(r => r.spatialLayer)),
					temporalLayer: lastValue(rows.map(r => r.temporalLayer)),
					transportState: lastValue(rows.map(r => r.transportState)),
					clientReported: rows.some(r => r.clientReported),
					clientFreezeCount: sum(rows.map(r => r.clientFreezeCount)),
					clientFreezeMs: sum(rows.map(r => r.clientFreezeMs)),
					clientFramesDropped: sum(rows.map(r => r.clientFramesDropped)),
					clientFps: lastValue(rows.map(r => r.clientFps)),
					clientJitterBufferMs: lastValue(rows.map(r => r.clientJitterBufferMs)),
				};
			},
			last.time
		),
		viewerSessionStarts: list.flatMap(b => b.viewerSessionStarts),
		viewerSessionEnds: list.flatMap(b => b.viewerSessionEnds),
	};
}

function mergeOrigin(list: OriginBatch[]): OriginBatch {
	const last = list[list.length - 1]!;

	return {
		mode: 'origin',
		time: last.time,
		rooms: union(list.map(b => b.rooms)),
		collector: mergeCollector(list),
		workers: mergeWorkers(list.flatMap(b => b.workers), last.time),
		broadcasterSamples: mergeBy(
			list.flatMap(b => b.broadcasterSamples),
			r => r.broadcasterId,
			(rows): BroadcasterSampleRow => {
				const l = rows[rows.length - 1]!;

				return {
					...l,
					time: last.time,
					bitrateBps: avg(rows.map(r => r.bitrateBps)),
					fps: lastValue(rows.map(r => r.fps)),
					packetsExpected: sum(rows.map(r => r.packetsExpected)),
					packetsLost: sum(rows.map(r => r.packetsLost)),
					packetsRepaired: sum(rows.map(r => r.packetsRepaired)),
					nackCount: sum(rows.map(r => r.nackCount)),
					pliCount: sum(rows.map(r => r.pliCount)),
					rttMs: lastValue(rows.map(r => r.rttMs)),
					jitterMs: lastValue(rows.map(r => r.jitterMs)),
					layersActive: lastValue(rows.map(r => r.layersActive)),
				};
			},
			last.time
		),
		broadcasterSessionStarts: list.flatMap(b => b.broadcasterSessionStarts),
		broadcasterSessionUpdates: list.flatMap(b => b.broadcasterSessionUpdates),
		roomSamples: mergeBy(
			list.flatMap(b => b.roomSamples),
			r => r.roomId,
			(rows): OriginRoomSampleRow => {
				const l = rows[rows.length - 1]!;

				return { ...l, time: last.time, outPipeBitrateBps: avg(rows.map(r => r.outPipeBitrateBps)) };
			},
			last.time
		),
		pipeSendSamples: mergeBy(
			list.flatMap(b => b.pipeSendSamples),
			r => `${r.roomId}\u0000${r.remoteIp}\u0000${r.producerId}`,
			(rows): PipeSendSampleRow => {
				const l = rows[rows.length - 1]!;

				return {
					...l,
					time: last.time,
					edgeId: lastValue(rows.map(r => r.edgeId)),
					packetsExpected: sum(rows.map(r => r.packetsExpected)),
					packetsLost: sum(rows.map(r => r.packetsLost)),
					nackCount: sum(rows.map(r => r.nackCount)),
					pliCount: sum(rows.map(r => r.pliCount)),
					bitrateBps: avg(rows.map(r => r.bitrateBps)),
					rttMs: lastValue(rows.map(r => r.rttMs)),
				};
			},
			last.time
		),
		roomEdgeLinks: list.flatMap(b => b.roomEdgeLinks),
		viewerLive: last.viewerLive,
	};
}

function mergeCollector(list: Batch[]): Batch['collector'] {
	const last = list[list.length - 1]!.collector;

	return {
		...last,
		collectDurationMs: max(list.map(b => b.collector.collectDurationMs)),
		collectSkipped: list.some(b => b.collector.collectSkipped),
		eventLoopLagMs: max(list.map(b => b.collector.eventLoopLagMs)),
		hostCpuPct: avg(list.map(b => b.collector.hostCpuPct)),
	};
}

function mergeWorkers(rows: WorkerSampleRow[], time: Date): WorkerSampleRow[] {
	return mergeBy(
		rows,
		r => String(r.workerIdx),
		(group): WorkerSampleRow => ({ ...group[group.length - 1]!, time, cpuPct: avg(group.map(r => r.cpuPct)) }),
		time
	);
}

/** 같은 키끼리 묶어 합친다. 결과 순서는 처음 나타난 순서. 하나뿐인 행도 시각은 합친 묶음 시각으로 맞춘다. */
function mergeBy<T extends { time: Date }>(rows: T[], key: (row: T) => string, merge: (group: T[]) => T, time: Date): T[] {
	const groups = new Map<string, T[]>();

	for (const row of rows) {
		const k = key(row);
		const group = groups.get(k);

		if (group) {
			group.push(row);
		} else {
			groups.set(k, [row]);
		}
	}

	return [...groups.values()].map(group => (group.length === 1 ? { ...group[0]!, time } : merge(group)));
}

function union(lists: string[][]): string[] {
	return [...new Set(lists.flat())];
}

/** null만 있으면 null (0과 구분). */
function sum(values: Array<number | null>): number | null {
	let total: number | null = null;

	for (const v of values) {
		if (v !== null) {
			total = (total ?? 0) + v;
		}
	}

	return total;
}

function avg(values: Array<number | null>): number | null {
	const nums = values.filter((v): v is number => v !== null);

	return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

function max(values: Array<number | null>): number | null {
	const nums = values.filter((v): v is number => v !== null);

	return nums.length ? Math.max(...nums) : null;
}

function lastValue<T>(values: Array<T | null>): T | null {
	for (let i = values.length - 1; i >= 0; i--) {
		const v = values[i];

		if (v !== null && v !== undefined) {
			return v;
		}
	}

	return null;
}
