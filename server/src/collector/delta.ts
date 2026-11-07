/**
 * 누적값 → 증가분 변환 (AGENT_TASK 4.2-2).
 *
 * 키마다 직전 누적값을 기억한다. 누적값이 줄어들면(서버·worker 재시작, stream 교체)
 * 그 구간은 저장하지 않도록 null을 돌려준다. 처음 본 키도 기준값이 없으므로 null.
 * 이번 수집에서 보이지 않은 키는 sweep()으로 지운다 (H6).
 */
export class DeltaTracker {
	readonly #prev = new Map<string, number>();
	readonly #seen = new Set<string>();

	/** 증가분. 첫 관측·감소·값 없음이면 null. */
	delta(key: string, value: number | null | undefined): number | null {
		if (value === null || value === undefined || !Number.isFinite(value)) {
			return null;
		}

		this.#seen.add(key);

		const prev = this.#prev.get(key);

		this.#prev.set(key, value);

		if (prev === undefined || value < prev) {
			return null;
		}

		return value - prev;
	}

	/** 이번 주기에 delta()가 호출되지 않은 키를 지운다. 주기 끝에 한 번 호출한다. */
	sweep(): void {
		for (const key of this.#prev.keys()) {
			if (!this.#seen.has(key)) {
				this.#prev.delete(key);
			}
		}

		this.#seen.clear();
	}

	get size(): number {
		return this.#prev.size;
	}
}

/** null이 하나라도 있으면 null, 아니면 합. 한 구간의 일부만 유효하면 그 구간은 버린다. */
export function sumStrict(values: Array<number | null>): number | null {
	let total = 0;

	for (const v of values) {
		if (v === null) {
			return null;
		}

		total += v;
	}

	return total;
}
