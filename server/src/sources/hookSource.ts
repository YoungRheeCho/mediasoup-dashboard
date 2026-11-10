import * as net from 'node:net';

import { HOOK_PROTOCOL_VERSION } from '../hookProtocol.js';
import type { RawHealth, RawSnapshot, RawTransportDetail } from '../hookProtocol.js';
import { createLogger } from '../log.js';
import type { MediasoupSource } from './types.js';

const logger = createLogger('hook-source');

/**
 * 훅 유닉스 소켓 클라이언트. 요청마다 연결을 새로 연다 (유닉스 소켓이라 1초 주기에도 비용이 작고, 훅이 재시작돼도 신경 쓸 게 없다).
 */
export class HookSource implements MediasoupSource {
	readonly kind = 'hook' as const;
	#nextId = 1;
	#warnedProtocol = false;

	constructor(
		private readonly socketPath: string,
		private readonly timeoutMs: number
	) {}

	async health(): Promise<RawHealth> {
		const health = await this.#request<RawHealth>('health');

		if (health.protocol !== HOOK_PROTOCOL_VERSION && !this.#warnedProtocol) {
			this.#warnedProtocol = true;
			logger.warn('hook protocol %d != expected %d', health.protocol, HOOK_PROTOCOL_VERSION);
		}

		return health;
	}

	snapshot(opts: { spreadMs?: number } = {}): Promise<RawSnapshot> {
		return this.#request<RawSnapshot>('snapshot', { spreadMs: opts.spreadMs ?? 0 });
	}

	transportDetail(transportId: string): Promise<RawTransportDetail> {
		return this.#request<RawTransportDetail>('transportDetail', { transportId });
	}

	close(): void {}

	#request<T>(method: string, params?: unknown): Promise<T> {
		const id = this.#nextId++;

		return new Promise<T>((resolve, reject) => {
			const socket = net.createConnection(this.socketPath);
			let buffer = '';
			let settled = false;

			const finish = (error: Error | null, value?: T) => {
				if (settled) {
					return;
				}

				settled = true;
				clearTimeout(timer);
				socket.destroy();

				if (error) {
					reject(error);
				} else {
					resolve(value as T);
				}
			};

			const timer = setTimeout(
				() => finish(new Error(`hook ${method} timed out after ${this.timeoutMs}ms`)),
				this.timeoutMs
			);

			socket.setEncoding('utf8');
			socket.on('connect', () => socket.write(JSON.stringify({ id, method, params }) + '\n'));
			socket.on('error', error => finish(error));
			socket.on('close', () => finish(new Error(`hook connection closed before ${method} reply`)));
			socket.on('data', chunk => {
				buffer += chunk;

				const newline = buffer.indexOf('\n');

				if (newline < 0) {
					return;
				}

				try {
					const reply = JSON.parse(buffer.slice(0, newline)) as
						| { id: number; ok: true; result: T }
						| { id: number; ok: false; error: string };

					if (reply.ok) {
						finish(null, reply.result);
					} else {
						finish(new Error(`hook ${method} failed: ${reply.error}`));
					}
				} catch (error) {
					finish(error as Error);
				}
			});
		});
	}
}
