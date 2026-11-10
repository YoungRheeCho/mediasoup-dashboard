'use strict';

/*
 * mediasoup 대시보드 수집 훅.
 *
 * mediasoup-demo 서버 프로세스에 NODE_OPTIONS="--require <이 파일>"로 사전 로드된다.
 * 서버 코드는 수정하지 않는다. 하는 일은 세 가지뿐이다.
 *   1. mediasoup.observer로 worker/router/transport/producer/consumer를 추적한다 (읽기 전용).
 *   2. 사이드카가 유닉스 소켓으로 요청하면 getStats()/getResourceUsage()를 호출해 원시값을 돌려준다.
 *   3. 이 프로세스의 이벤트 루프 지연과 RSS를 함께 돌려준다.
 * 정규화·delta 계산·저장은 사이드카가 한다 (docs/collection-design.md H13: 훅 메모리 최소화).
 *
 * 안전 규칙 (H1): 어떤 예외도 서버로 새어 나가면 안 된다. 모든 진입점은 try/catch로 감싼다.
 * 의존성 없음: Node 내장 모듈만 쓴다.
 */

const PROTOCOL_VERSION = 1;

try {
	main();
} catch (error) {
	safeLog('init failed, collection disabled: %s', error && error.stack);
}

function main() {
	const path = require('node:path');
	const fs = require('node:fs');

	// H2: NODE_OPTIONS는 npm, npx 같은 하위 Node 프로세스에도 상속된다. 대상 프로세스에서만 켠다.
	const match = process.env.MSDASH_HOOK_MATCH || 'mediasoup-demo-server';
	const entry = process.argv[1] ? path.basename(process.argv[1]) : '';

	if (entry !== match) {
		return;
	}

	if (process.env.MSDASH_HOOK_DISABLE === '1') {
		safeLog('disabled by MSDASH_HOOK_DISABLE');

		return;
	}

	// H3: 서버와 같은 경로에서 mediasoup을 찾아야 같은 인스턴스를 공유한다.
	let entryDir = path.dirname(process.argv[1]);

	try {
		entryDir = path.dirname(fs.realpathSync(process.argv[1]));
	} catch (error) {}

	const mediasoupPath = require.resolve('mediasoup', {
		paths: [entryDir, path.join(entryDir, '..'), process.cwd()],
	});
	const mediasoup = require(mediasoupPath);

	const registry = createRegistry(mediasoup);
	const loop = createLoopMonitor();

	startSocketServer({ registry, loop, mediasoupVersion: mediasoup.version });

	safeLog(
		'enabled [pid:%d, mediasoup:%s, path:%s]',
		process.pid,
		mediasoup.version,
		mediasoupPath
	);

	// 서버가 worker를 만들지 않으면 대부분 다른 mediasoup 인스턴스를 잡은 것이다 (H3).
	const warnTimer = setTimeout(() => {
		if (registry.workers.size === 0) {
			safeLog(
				'warning: no mediasoup worker observed after 30s; hook may be bound to a different mediasoup instance'
			);
		}
	}, 30000);

	warnTimer.unref();
}

/**
 * observer로 mediasoup 객체를 추적한다. close 때 반드시 지운다 (H6).
 */
function createRegistry(mediasoup) {
	const workers = new Map();
	const routers = new Map(); // id -> { router, workerPid }
	const transports = new Map(); // id -> { transport, routerId }
	const producers = new Map(); // id -> { producer, transportId }
	const consumers = new Map(); // id -> { consumer, transportId }

	const guard = fn =>
		function guarded(...args) {
			try {
				fn(...args);
			} catch (error) {
				safeLog('observer handler error: %s', error && error.stack);
			}
		};

	mediasoup.observer.on(
		'newworker',
		guard(worker => {
			workers.set(worker.pid, worker);
			worker.observer.on(
				'close',
				guard(() => workers.delete(worker.pid))
			);

			worker.observer.on(
				'newrouter',
				guard(router => {
					routers.set(router.id, { router, workerPid: worker.pid });
					router.observer.on(
						'close',
						guard(() => routers.delete(router.id))
					);

					router.observer.on(
						'newtransport',
						guard(transport => {
							transports.set(transport.id, { transport, routerId: router.id });
							transport.observer.on(
								'close',
								guard(() => transports.delete(transport.id))
							);

							transport.observer.on(
								'newproducer',
								guard(producer => {
									producers.set(producer.id + '@' + transport.id, {
										producer,
										transportId: transport.id,
									});
									producer.observer.on(
										'close',
										guard(() => producers.delete(producer.id + '@' + transport.id))
									);
								})
							);

							transport.observer.on(
								'newconsumer',
								guard(consumer => {
									consumers.set(consumer.id, { consumer, transportId: transport.id });
									consumer.observer.on(
										'close',
										guard(() => consumers.delete(consumer.id))
									);
								})
							);
						})
					);
				})
			);
		})
	);

	return { workers, routers, transports, producers, consumers };
}

/**
 * 이 Node 프로세스의 이벤트 루프 지연 (H4). 응답할 때마다 초기화한다.
 */
function createLoopMonitor() {
	const { monitorEventLoopDelay } = require('node:perf_hooks');
	const resolutionMs = 20;
	const histogram = monitorEventLoopDelay({ resolution: resolutionMs });

	histogram.enable();

	return {
		takeP99Ms() {
			// 기록값에는 샘플링 간격 자체가 포함된다 (유휴 상태에서도 ~resolution). 간격을 빼야 실제 지연이다.
			const value = Math.max(0, histogram.percentile(99) / 1e6 - resolutionMs);

			histogram.reset();

			return Number.isFinite(value) ? value : null;
		},
	};
}

/**
 * 사이드카 요청 처리. 줄 단위 JSON (요청 1줄 → 응답 1줄).
 *   {"id":1,"method":"snapshot"}
 *   {"id":2,"method":"transportDetail","params":{"transportId":"..."}}
 *   {"id":3,"method":"health"}
 * 소켓은 서버 디렉터리가 아닌 공유 볼륨에 만든다 (H5).
 */
function startSocketServer({ registry, loop, mediasoupVersion }) {
	const net = require('node:net');
	const fs = require('node:fs');
	const path = require('node:path');

	const socketPath = process.env.MSDASH_HOOK_SOCKET || '/var/run/msdash/hook.sock';
	const concurrency = clampInt(process.env.MSDASH_HOOK_CONCURRENCY, 1, 32, 6);
	const callTimeoutMs = clampInt(process.env.MSDASH_HOOK_CALL_TIMEOUT_MS, 100, 30000, 2000);

	const handlers = {
		health: async () => ({
			protocol: PROTOCOL_VERSION,
			pid: process.pid,
			mediasoupVersion,
			counts: {
				workers: registry.workers.size,
				routers: registry.routers.size,
				transports: registry.transports.size,
				producers: registry.producers.size,
				consumers: registry.consumers.size,
			},
		}),
		// spreadMs: 사이드카가 1초 주기로 수집할 때 getStats() 호출을 이 시간 동안 고르게 나눠 보낸다 (H4 순간 몰림 완화).
		// 옛 사이드카는 params를 보내지 않으므로 0(한꺼번에)으로 동작한다.
		snapshot: async params =>
			takeSnapshot({ registry, loop, concurrency, callTimeoutMs, spreadMs: clampInt(params.spreadMs, 0, 10000, 0) }),
		transportDetail: async params =>
			takeTransportDetail({ registry, params, concurrency, callTimeoutMs }),
	};

	try {
		fs.mkdirSync(path.dirname(socketPath), { recursive: true });
	} catch (error) {}

	try {
		fs.unlinkSync(socketPath);
	} catch (error) {}

	const server = net.createServer(socket => {
		let buffer = '';

		socket.setEncoding('utf8');
		socket.on('error', () => {});
		socket.on('data', chunk => {
			buffer += chunk;

			// 비정상적으로 긴 요청은 끊는다.
			if (buffer.length > 64 * 1024) {
				socket.destroy();

				return;
			}

			let newline;

			while ((newline = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, newline);

				buffer = buffer.slice(newline + 1);
				void handleLine(socket, line, handlers);
			}
		});
	});

	server.on('error', error => safeLog('socket server error: %s', error && error.message));
	server.listen(socketPath, () => {
		// mediasoup 서버는 root로, 사이드카는 일반 사용자로 돈다. 같은 Pod 안 공유 볼륨에서만 보이므로 열어 둔다.
		try {
			fs.chmodSync(socketPath, 0o666);
		} catch (error) {}

		safeLog('listening on %s', socketPath);
	});

	// 소켓 서버가 서버 프로세스 종료를 막지 않게 한다.
	server.unref();
}

async function handleLine(socket, line, handlers) {
	let id = null;

	try {
		const request = JSON.parse(line);

		id = request.id ?? null;

		const handler = handlers[request.method];

		if (!handler) {
			throw new Error(`unknown method: ${request.method}`);
		}

		const result = await handler(request.params || {});

		writeLine(socket, { id, ok: true, result });
	} catch (error) {
		writeLine(socket, { id, ok: false, error: String((error && error.message) || error) });
	}
}

function writeLine(socket, message) {
	try {
		if (!socket.destroyed) {
			socket.write(JSON.stringify(message) + '\n');
		}
	} catch (error) {}
}

async function takeSnapshot({ registry, loop, concurrency, callTimeoutMs, spreadMs = 0 }) {
	const startedAt = Date.now();
	const errors = [];
	const totalCalls = registry.workers.size + registry.transports.size + registry.producers.size + registry.consumers.size;
	// 호출 시작 사이 최소 간격. 예: spreadMs 600, 호출 300개 → 2ms마다 하나씩 시작한다.
	const gapMs = spreadMs > 0 && totalCalls > 1 ? spreadMs / totalCalls : 0;
	const call = createLimitedCaller({ concurrency, callTimeoutMs, errors, gapMs });

	const workers = Array.from(registry.workers.values()).map(worker => ({
		pid: worker.pid,
		idx: worker.appData && typeof worker.appData.idx === 'number' ? worker.appData.idx : null,
		usage: null,
		rssBytes: readRssBytes(worker.pid),
		_worker: worker,
	}));

	const routers = Array.from(registry.routers.values()).map(({ router, workerPid }) => ({
		id: router.id,
		workerPid,
	}));

	const transports = Array.from(registry.transports.values()).map(({ transport, routerId }) =>
		describeTransport(transport, routerId)
	);

	const producers = Array.from(registry.producers.values()).map(({ producer, transportId }) =>
		describeProducer(producer, transportId)
	);

	const consumers = Array.from(registry.consumers.values()).map(({ consumer, transportId }) =>
		describeConsumer(consumer, transportId)
	);

	const jobs = [];

	for (const w of workers) {
		jobs.push(call(`worker:${w.pid}`, () => w._worker.getResourceUsage()).then(u => {
			w.usage = u
				? {
						ru_utime: u.ru_utime,
						ru_stime: u.ru_stime,
						ru_maxrss: u.ru_maxrss,
						ru_nvcsw: u.ru_nvcsw,
						ru_nivcsw: u.ru_nivcsw,
					}
				: null;
		}));
	}

	for (const t of transports) {
		jobs.push(call(`transport:${t.id}`, () => t._obj.getStats()).then(s => {
			t.stats = s ? s.map(pickTransportStats) : null;
		}));
	}

	for (const p of producers) {
		jobs.push(call(`producer:${p.id}`, () => p._obj.getStats()).then(s => {
			p.stats = s ? s.map(pickRtpStats) : null;
		}));
	}

	for (const c of consumers) {
		jobs.push(call(`consumer:${c.id}`, () => c._obj.getStats()).then(s => {
			c.stats = s ? s.map(pickRtpStats) : null;
		}));
	}

	await Promise.all(jobs);

	for (const list of [workers, transports, producers, consumers]) {
		for (const item of list) {
			delete item._worker;
			delete item._obj;
		}
	}

	return {
		protocol: PROTOCOL_VERSION,
		time: Date.now(),
		durationMs: Date.now() - startedAt,
		process: {
			pid: process.pid,
			rssBytes: process.memoryUsage().rss,
			eventLoopLagP99Ms: loop.takeP99Ms(),
		},
		workers,
		routers,
		transports,
		producers,
		consumers,
		rooms: describeRooms(),
		errors: errors.slice(0, 50),
		errorCount: errors.length,
	};
}

/**
 * 개별 viewer 상세(2초 갱신)용. 한 transport와 그 consumer만 호출한다 (AGENT_TASK 4.3).
 */
async function takeTransportDetail({ registry, params, concurrency, callTimeoutMs }) {
	const transportId = String(params.transportId || '');
	const entry = registry.transports.get(transportId);

	if (!entry) {
		return { time: Date.now(), found: false };
	}

	const errors = [];
	const call = createLimitedCaller({ concurrency, callTimeoutMs, errors });
	const transport = describeTransport(entry.transport, entry.routerId);
	const consumers = Array.from(registry.consumers.values())
		.filter(c => c.transportId === transportId)
		.map(({ consumer }) => describeConsumer(consumer, transportId));
	const producers = Array.from(registry.producers.values())
		.filter(p => p.transportId === transportId)
		.map(({ producer }) => describeProducer(producer, transportId));

	await Promise.all([
		call(`transport:${transport.id}`, () => transport._obj.getStats()).then(s => {
			transport.stats = s ? s.map(pickTransportStats) : null;
		}),
		...consumers.map(c =>
			call(`consumer:${c.id}`, () => c._obj.getStats()).then(s => {
				c.stats = s ? s.map(pickRtpStats) : null;
			})
		),
		...producers.map(p =>
			call(`producer:${p.id}`, () => p._obj.getStats()).then(s => {
				p.stats = s ? s.map(pickRtpStats) : null;
			})
		),
	]);

	delete transport._obj;
	consumers.forEach(c => delete c._obj);
	producers.forEach(p => delete p._obj);

	return { time: Date.now(), found: true, transport, consumers, producers, errors };
}

function describeTransport(transport, routerId) {
	const out = {
		id: transport.id,
		routerId,
		type: safeGet(() => transport.type),
		direction: safeGet(() => transport.appData && transport.appData.direction) ?? null,
		//new version
		peerId: safeGet(() => transport.appData && transport.appData.peerId) ?? null,
		iceState: safeGet(() => transport.iceState) ?? null,
		dtlsState: safeGet(() => transport.dtlsState) ?? null,
		// 시청자 브라우저가 보고한 재생 품질 (서버 Peer.ts의 reportClientStats가 appData에 넣어 둔 값, M2)
		clientStats: pickClientStats(safeGet(() => transport.appData && transport.appData.clientStats)),
		tuple: null,
		stats: null,
		_obj: transport,
	};

	const tuple = safeGet(() => transport.tuple);

	if (tuple) {
		out.tuple = {
			localIp: tuple.localAddress || tuple.localIp || null,
			localPort: tuple.localPort ?? null,
			remoteIp: tuple.remoteIp ?? null,
			remotePort: tuple.remotePort ?? null,
		};
	}

	return out;
}

function describeProducer(producer, transportId) {
	const appData = safeGet(() => producer.appData) || {};

	return {
		id: producer.id,
		transportId,
		kind: producer.kind,
		type: safeGet(() => producer.type),
		paused: safeGet(() => producer.paused),
		peerId: typeof appData.peerId === 'string' ? appData.peerId : null,
		source: typeof appData.source === 'string' ? appData.source : null,
		stats: null,
		_obj: producer,
	};
}

function describeConsumer(consumer, transportId) {
	const layers = safeGet(() => consumer.currentLayers);

	return {
		id: consumer.id,
		transportId,
		producerId: consumer.producerId,
		kind: consumer.kind,
		type: safeGet(() => consumer.type),
		paused: safeGet(() => consumer.paused),
		producerPaused: safeGet(() => consumer.producerPaused),
		currentLayers: layers
			? { spatialLayer: layers.spatialLayer, temporalLayer: layers.temporalLayer ?? null }
			: null,
		stats: null,
		_obj: consumer,
	};
}

/**
 * 서버 Room 정보. TerminalServer가 전역 `rooms`(Map)를 노출한다. 공개 메서드만 쓴다.
 */
function describeRooms() {
	const rooms = [];
	const map = safeGet(() => global.rooms);

	if (!map || typeof map.values !== 'function') {
		return rooms;
	}

	for (const room of map.values()) {
		try {
			const serialized = typeof room.serialize === 'function' ? room.serialize() : {};
			const routerId = role =>
				safeGet(() => (typeof room.getRouterId === 'function' ? room.getRouterId(role) : null)) ?? null;

			rooms.push({
				roomId: String(serialized.roomId ?? room.id ?? ''),
				createdAt: serialized.createdAt ?? null,
				producerRouterId: routerId('producer'),
				consumerRouterId: routerId('consumer'),
				peers: (serialized.peers || []).map(pickPeer),
				broadcasterPeers: (serialized.broadcasterPeers || []).map(pickPeer),
			});
		} catch (error) {}
	}

	return rooms;
}

function pickPeer(peer) {
	return {
		peerId: peer.peerId,
		displayName: peer.displayName ?? null,
		device: peer.device
			? { flag: peer.device.flag ?? null, name: peer.device.name ?? null, version: peer.device.version ?? null }
			: null,
		remoteAddress: peer.remoteAddress ?? null,
	};
}

const RTP_FIELDS = [
	'type', 'kind', 'ssrc', 'rid', 'mimeType', 'timestamp',
	'packetCount', 'byteCount', 'bitrate', 'bitrateByLayer',
	'packetsLost', 'fractionLost', 'jitter', 'packetsDiscarded',
	'packetsRetransmitted', 'packetsRepaired', 'nackCount', 'nackPacketCount',
	'pliCount', 'firCount', 'roundTripTime',
];

function pickRtpStats(stat) {
	const out = {};

	for (const key of RTP_FIELDS) {
		if (stat[key] !== undefined) {
			out[key] = stat[key];
		}
	}

	return out;
}

const CLIENT_STATS_FIELDS = [
	'freezeCount', 'freezeSec', 'framesDropped', 'fps', 'jitterBufferMs', 'width', 'height', 'at',
];

/** 브라우저가 보낸 값이라 형식을 믿지 않는다. 알려진 숫자 칸만 복사한다. */
function pickClientStats(stats) {
	if (!stats || typeof stats !== 'object') {
		return null;
	}

	const out = {};

	for (const key of CLIENT_STATS_FIELDS) {
		const value = stats[key];

		out[key] = typeof value === 'number' && Number.isFinite(value) ? value : null;
	}

	return out;
}

const TRANSPORT_FIELDS = [
	'type', 'timestamp', 'bytesReceived', 'recvBitrate', 'bytesSent', 'sendBitrate',
	'rtpBytesReceived', 'rtpBytesSent', 'rtxBytesReceived', 'rtxBytesSent',
	'availableOutgoingBitrate', 'availableIncomingBitrate', 'maxIncomingBitrate',
	'iceState', 'dtlsState', 'iceSelectedTuple', 'tuple',
];

function pickTransportStats(stat) {
	const out = {};

	for (const key of TRANSPORT_FIELDS) {
		if (stat[key] !== undefined) {
			out[key] = stat[key];
		}
	}

	return out;
}

/**
 * 동시 호출 수와 호출당 시간을 제한한다 (H4). 실패는 null로 돌려주고 errors에 남긴다.
 */
function createLimitedCaller({ concurrency, callTimeoutMs, errors, gapMs = 0 }) {
	let active = 0;
	const queue = [];
	let nextStartAt = 0;
	let waiting = null;

	const next = () => {
		while (active < concurrency && queue.length > 0) {
			// gapMs > 0 이면 호출 시작을 일정 간격으로 벌린다 (한 주기 안에서 고르게).
			if (gapMs > 0) {
				const now = Date.now();

				if (now < nextStartAt) {
					if (!waiting) {
						waiting = setTimeout(() => {
							waiting = null;
							next();
						}, Math.ceil(nextStartAt - now));
					}

					return;
				}

				// 기준 시각에서 gapMs씩 더해 가므로, 타이머가 늦게 깨면 밀린 만큼 바로 이어서 시작한다 (전체가 spreadMs 안에 끝나도록).
				nextStartAt = (nextStartAt || now) + gapMs;
			}

			const job = queue.shift();

			active++;
			job().finally(() => {
				active--;
				next();
			});
		}
	};

	return (label, fn) =>
		new Promise(resolve => {
			queue.push(async () => {
				let timer;

				try {
					const result = await Promise.race([
						fn(),
						new Promise((_, reject) => {
							timer = setTimeout(() => reject(new Error('timeout')), callTimeoutMs);
						}),
					]);

					resolve(result);
				} catch (error) {
					errors.push(`${label}: ${(error && error.message) || error}`);
					resolve(null);
				} finally {
					clearTimeout(timer);
				}
			});
			next();
		});
}

/**
 * 현재 RSS. getResourceUsage().ru_maxrss는 최대치라서 /proc에서 읽는다.
 */
function readRssBytes(pid) {
	try {
		const status = require('node:fs').readFileSync(`/proc/${pid}/status`, 'utf8');
		const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);

		return match ? Number(match[1]) * 1024 : null;
	} catch (error) {
		return null;
	}
}

function safeGet(fn) {
	try {
		return fn();
	} catch (error) {
		return undefined;
	}
}

function clampInt(value, min, max, fallback) {
	const n = Number.parseInt(String(value ?? ''), 10);

	return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function safeLog(format, ...args) {
	try {
		const util = require('node:util');

		process.stderr.write(`[msdash-hook] ${util.format(format, ...args)}\n`);
	} catch (error) {}
}
