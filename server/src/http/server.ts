import * as http from 'node:http';

import { createLogger } from '../log.js';

const logger = createLogger('http');

export type Request = {
	method: string;
	path: string;
	query: URLSearchParams;
	params: Record<string, string>;
	body: unknown;
	remoteAddress: string | null;
};

export type Response = { status?: number; body?: unknown; headers?: Record<string, string> } | undefined;

export type Handler = (req: Request) => Promise<Response> | Response;

export class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
	}
}

// edge → origin 1초 heartbeat에 시청자 목록(시청자 1명당 약 200바이트)이 실린다. 시청자 1만 명 정도까지 받는다.
const MAX_BODY = 4 * 1024 * 1024;

/**
 * 의존성 없는 작은 JSON HTTP 라우터. 경로의 `:name` 조각은 params로 들어온다.
 */
export class HttpServer {
	readonly #routes: Array<{ method: string; pattern: RegExp; names: string[]; handler: Handler }> = [];
	readonly #server: http.Server;
	#fallback: ((req: http.IncomingMessage, res: http.ServerResponse) => boolean) | null = null;

	constructor() {
		this.#server = http.createServer((req, res) => void this.#handle(req, res));
	}

	route(method: string, path: string, handler: Handler): this {
		const names: string[] = [];
		const pattern = new RegExp(
			'^' +
				path.replace(/:([a-zA-Z]+)/g, (_, name: string) => {
					names.push(name);

					return '([^/]+)';
				}) +
				'$'
		);

		this.#routes.push({ method, pattern, names, handler });

		return this;
	}

	/** API에 맞지 않는 요청(정적 파일 등)을 처리할 함수. 처리했으면 true. */
	fallback(fn: (req: http.IncomingMessage, res: http.ServerResponse) => boolean): this {
		this.#fallback = fn;

		return this;
	}

	listen(host: string, port: number): Promise<void> {
		return new Promise((resolve, reject) => {
			this.#server.once('error', reject);
			this.#server.listen(port, host, () => {
				logger.info('listening on http://%s:%d', host, port);
				resolve();
			});
		});
	}

	/** 실제로 열린 포트 (listen에 0을 줬을 때 확인용) */
	get port(): number | null {
		const addr = this.#server.address();

		return addr && typeof addr === 'object' ? addr.port : null;
	}

	close(): Promise<void> {
		return new Promise(resolve => this.#server.close(() => resolve()));
	}

	async #handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const url = new URL(req.url ?? '/', 'http://localhost');
		const method = req.method ?? 'GET';

		for (const route of this.#routes) {
			if (route.method !== method) {
				continue;
			}

			const match = route.pattern.exec(url.pathname);

			if (!match) {
				continue;
			}

			try {
				const params = Object.fromEntries(route.names.map((n, i) => [n, decodeURIComponent(match[i + 1]!)]));
				const body = method === 'POST' || method === 'PUT' ? await readJson(req) : undefined;
				const result = await route.handler({
					method,
					path: url.pathname,
					query: url.searchParams,
					params,
					body,
					remoteAddress: req.socket.remoteAddress ?? null,
				});

				send(res, result?.status ?? 200, result?.body ?? null, result?.headers);
			} catch (error) {
				const status = error instanceof HttpError ? error.status : 500;

				if (status >= 500) {
					logger.warn('%s %s failed: %s', method, url.pathname, (error as Error).stack ?? error);
				}

				send(res, status, { error: (error as Error).message });
			}

			return;
		}

		if (this.#fallback?.(req, res)) {
			return;
		}

		send(res, 404, { error: 'not found' });
	}
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
	const payload = JSON.stringify(body);

	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		...headers,
	});
	res.end(payload);
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];

		req.on('data', (chunk: Buffer) => {
			size += chunk.length;

			if (size > MAX_BODY) {
				reject(new HttpError(413, 'body too large'));
				req.destroy();

				return;
			}

			chunks.push(chunk);
		});
		req.on('end', () => {
			if (chunks.length === 0) {
				resolve(undefined);

				return;
			}

			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
			} catch {
				reject(new HttpError(400, 'invalid JSON'));
			}
		});
		req.on('error', reject);
	});
}
