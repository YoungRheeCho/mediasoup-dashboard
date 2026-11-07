// UI 상태 시험용 프록시: 18085 → 18081. /tmp/uiproxy-mode 파일로 동작을 바꾼다.
//   normal | slow (/api 8초 지연) | down (/api 연결 끊기)
import http from 'node:http';
import { readFileSync } from 'node:fs';

const target = { host: '127.0.0.1', port: Number(process.argv[2] ?? 18081) };
const mode = () => {
	try {
		return readFileSync('/tmp/uiproxy-mode', 'utf8').trim();
	} catch {
		return 'normal';
	}
};

http
	.createServer((req, res) => {
		const m = mode();
		const isApi = req.url.startsWith('/api/');

		if (isApi) {
			console.log(`${Date.now()} ${m} ${req.url}`);
		}

		if (isApi && m === 'down') {
			req.socket.destroy();

			return;
		}

		const forward = () => {
			const p = http.request({ ...target, path: req.url, method: req.method, headers: req.headers }, r => {
				res.writeHead(r.statusCode, r.headers);
				r.pipe(res);
			});

			p.on('error', () => res.destroy());
			req.pipe(p);
		};

		if (isApi && m === 'slow') {
			setTimeout(forward, 8000);
		} else {
			forward();
		}
	})
	.listen(18085, () => console.log('uiproxy on 18085 →', target.port));
