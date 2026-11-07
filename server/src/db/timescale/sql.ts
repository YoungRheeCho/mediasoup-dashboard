import type { PoolClient } from 'pg';

/**
 * 배치 insert. 컬럼마다 배열 하나를 넘겨 unnest로 펼친다.
 * 행 수와 상관없이 파라미터가 컬럼 수만큼이라 큰 배치(viewer 수백 명)에도 한 문장으로 끝난다.
 */
export async function insertRows<T>(
	client: PoolClient,
	table: string,
	columns: Array<{ name: string; type: string; get: (row: T) => unknown }>,
	rows: T[]
): Promise<void> {
	if (rows.length === 0) {
		return;
	}

	const names = columns.map(c => c.name).join(', ');
	const unnest = columns.map((c, i) => `$${i + 1}::${c.type}[]`).join(', ');
	const values = columns.map(c => rows.map(r => c.get(r) ?? null));

	await client.query(`INSERT INTO ${table} (${names}) SELECT * FROM unnest(${unnest})`, values);
}

/** 비율: 분모가 0이거나 없으면 null. */
export function ratio(num: unknown, den: unknown): number | null {
	const n = toNum(num);
	const d = toNum(den);

	return n === null || d === null || d <= 0 ? null : n / d;
}

/** pg는 bigint/numeric을 문자열로 돌려준다. */
export function toNum(value: unknown): number | null {
	if (value === null || value === undefined) {
		return null;
	}

	const n = typeof value === 'number' ? value : Number(value);

	return Number.isFinite(n) ? n : null;
}

/** 원본 테이블과 1분 집계 중 어느 쪽을 읽을지. 구간이 길거나 bucket이 1분 이상이면 집계를 쓴다. */
export function useAggregate(rangeMs: number, bucketSeconds: number): boolean {
	return bucketSeconds >= 60 && rangeMs > 2 * 3600_000;
}
