import type { Batch, CollectorSampleRow } from './rows.js';
import type { CommonStore } from './store.js';
import { createLogger } from '../log.js';

const logger = createLogger('db-writer');

type Item = { kind: 'batch'; batch: Batch } | { kind: 'failure'; row: CollectorSampleRow };

/**
 * DB 기록 큐. 기록은 한 번에 하나씩, 수집 순서대로 한다.
 * DB가 잠시 내려가도 수집은 멈추지 않는다. 최근 maxPending개만 들고 있다가 복구되면 이어서 쓰고,
 * 넘치면 가장 오래된 것부터 버린다 (그 구간은 이력에 빈칸으로 남는다).
 */
export class BatchWriter {
	readonly #queue: Item[] = [];
	#writing = false;
	#dropped = 0;
	#lastError: string | null = null;
	#retryTimer: NodeJS.Timeout | null = null;

	constructor(
		private readonly store: CommonStore,
		private readonly maxPending = 30
	) {}

	enqueue(batch: Batch): void {
		this.#push({ kind: 'batch', batch });
	}

	enqueueFailure(row: CollectorSampleRow): void {
		this.#push({ kind: 'failure', row });
	}

	get pending(): number {
		return this.#queue.length;
	}

	get lastError(): string | null {
		return this.#lastError;
	}

	/** 남은 항목을 쓰고 끝낸다 (종료 시). */
	async flush(): Promise<void> {
		if (this.#retryTimer) {
			clearTimeout(this.#retryTimer);
			this.#retryTimer = null;
		}

		await this.#drain();
	}

	#push(item: Item): void {
		this.#queue.push(item);

		while (this.#queue.length > this.maxPending) {
			this.#queue.shift();
			this.#dropped++;
			logger.warn('db write queue full; dropped oldest batch (%d dropped total)', this.#dropped);
		}

		void this.#drain();
	}

	async #drain(): Promise<void> {
		if (this.#writing || this.#retryTimer) {
			return;
		}

		this.#writing = true;

		try {
			while (this.#queue.length > 0) {
				const item = this.#queue[0]!;

				if (item.kind === 'batch') {
					await this.store.saveBatch(item.batch);
				} else {
					await this.store.saveCollectorFailure(item.row);
				}

				this.#queue.shift();

				if (this.#lastError) {
					logger.info('db writes recovered');
					this.#lastError = null;
				}
			}
		} catch (error) {
			const message = (error as Error).message;

			if (message !== this.#lastError) {
				logger.warn('db write failed (%d pending): %s', this.#queue.length, message);
			}

			this.#lastError = message;
			this.#retryTimer = setTimeout(() => {
				this.#retryTimer = null;
				void this.#drain();
			}, 5000);
		} finally {
			this.#writing = false;
		}
	}
}
