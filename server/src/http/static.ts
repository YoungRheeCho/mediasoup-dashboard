import { createReadStream, existsSync, statSync } from 'node:fs';
import type * as http from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

import { createLogger } from '../log.js';

const logger = createLogger('static');

const TYPES: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.ico': 'image/x-icon',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.map': 'application/json',
};

/**
 * 빌드된 화면(web/dist)을 서빙한다. /api가 아닌 GET 중 파일이 없는 경로는 index.html (SPA 라우팅).
 * 해시가 붙은 assets/는 오래 캐시하고 index.html은 캐시하지 않는다.
 */
export function staticHandler(
	dir: string,
	opts: { rootPage?: string | null } = {}
): (req: http.IncomingMessage, res: http.ServerResponse) => boolean {
	const root = resolve(dir);
	const index = join(root, 'index.html');
	// origin은 첫 화면(/)을 통합 3D 화면(central.html)으로 연다. 기존 화면은 /overview 등 그대로.
	const rootPage = opts.rootPage ? join(root, opts.rootPage) : null;

	if (!existsSync(index)) {
		logger.warn('web UI not found at %s (build web/ first); only /api is served', root);
	}

	return (req, res) => {
		if (req.method !== 'GET' && req.method !== 'HEAD') {
			return false;
		}

		const url = new URL(req.url ?? '/', 'http://localhost');

		if (url.pathname.startsWith('/api/')) {
			return false;
		}

		let file = normalize(join(root, decodeURIComponent(url.pathname)));

		if ((url.pathname === '/' || url.pathname === '/central') && rootPage && existsSync(rootPage)) {
			file = rootPage;
		}

		if (file !== root && !file.startsWith(root + sep)) {
			return false;
		}

		const isFile = existsSync(file) && statSync(file).isFile();

		if (!isFile) {
			if (extname(url.pathname)) {
				return false; // 없는 정적 파일은 404
			}

			file = index;
		}

		if (!existsSync(file)) {
			return false;
		}

		res.writeHead(200, {
			'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
			'cache-control': file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
			'x-content-type-options': 'nosniff',
		});

		if (req.method === 'HEAD') {
			res.end();
		} else {
			createReadStream(file).pipe(res);
		}

		return true;
	};
}
