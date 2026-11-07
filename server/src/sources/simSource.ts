import { readFileSync } from 'node:fs';

import type {
	RawConsumer,
	RawHealth,
	RawProducer,
	RawRoom,
	RawRouter,
	RawRtpStat,
	RawSnapshot,
	RawTransport,
	RawTransportDetail,
	RawWorker,
} from '../hookProtocol.js';
import { HOOK_PROTOCOL_VERSION } from '../hookProtocol.js';
import type { Config } from '../config.js';
import type { MediasoupSource } from './types.js';

/**
 * 로컬 개발용 mediasoup 시뮬레이터. 훅과 같은 원시 형식(누적 카운터 포함)을 만든다.
 * 실제 mediasoup 없이 수집 → DB → API → 화면 경로를 돌려 보기 위한 것이며,
 * 서버 코드 수정 대기 항목을 채우는 mock(src/mock)과는 다르다. 화면에는 "SIMULATED"로 표시한다.
 *
 * edge: pipe로 들어오는 방송 + 여러 consumer router shard + viewer 접속/이탈.
 * origin: broadcaster(simulcast) + edge로 나가는 pipe + 소수의 직접 viewer.
 */
export class SimSource implements MediasoupSource {
	readonly kind = 'sim' as const;
	readonly #mode: Config['mode'];
	readonly #rand: () => number;
	readonly #workers: Array<RawWorker & { cpuShare: number; cpuMs: number }> = [];
	readonly #rooms: SimRoom[] = [];
	readonly #edgeTargets: Config['edgeTargets'];
	#lastTime = Date.now();
	#seq = 0;
	readonly #faultFile: string | null;

	constructor(config: Config, seed = 42) {
		this.#mode = config.mode;
		this.#faultFile = process.env.MSDASH_SIM_FAULT_FILE ?? null;
		this.#rand = mulberry32(seed);
		this.#edgeTargets = config.edgeTargets.length
			? config.edgeTargets
			: [1, 2, 3].map(i => ({
					edgeId: `edge-sim-${i}`,
					ip: `10.0.0.${10 + i}`,
					dashboardUrl: `http://10.0.0.${10 + i}:8080`,
				}));

		for (let i = 0; i < config.sim.workers; i++) {
			this.#workers.push({
				pid: 1000 + i,
				idx: i,
				usage: { ru_utime: 0, ru_stime: 0, ru_maxrss: 0 },
				rssBytes: 60e6,
				cpuShare: 0.1,
				cpuMs: 0,
			});
		}

		for (let r = 0; r < config.sim.rooms; r++) {
			this.#rooms.push(this.#createRoom(r, config.sim.viewersPerRoom));
		}
	}

	async health(): Promise<RawHealth> {
		const snapshotCounts = this.#build(false);

		return {
			protocol: HOOK_PROTOCOL_VERSION,
			pid: 999,
			mediasoupVersion: 'sim',
			counts: {
				workers: snapshotCounts.workers.length,
				routers: snapshotCounts.routers.length,
				transports: snapshotCounts.transports.length,
				producers: snapshotCounts.producers.length,
				consumers: snapshotCounts.consumers.length,
			},
		};
	}

	async snapshot(): Promise<RawSnapshot> {
		const fault = this.#readFault();

		// UI 상태 확인용 장애 주입 (개발 전용, MSDASH_SIM_FAULT_FILE)
		if (fault.has('collector_down')) {
			throw new Error('simulated: hook socket not responding (collector_down)');
		}

		this.#advance();

		const snap = this.#build(true);

		for (const f of fault) {
			const m = /^worker_timeout:(\d+)$/.exec(f);

			if (m) {
				const w = snap.workers.find(x => x.idx === Number(m[1]));

				if (w) {
					w.usage = null;
					snap.errors.push(`worker:${w.pid}: timeout`);
					snap.errorCount++;
				}
			}
		}

		return snap;
	}

	/** 장애 주입 파일: 줄마다 하나 (collector_down / worker_timeout:<idx>). 파일이 없으면 정상. */
	#readFault(): Set<string> {
		if (!this.#faultFile) {
			return new Set();
		}

		try {
			return new Set(readFileSync(this.#faultFile, 'utf8').split(/\s+/).filter(Boolean));
		} catch {
			return new Set();
		}
	}

	async transportDetail(transportId: string): Promise<RawTransportDetail> {
		const snap = this.#build(true);
		const transport = snap.transports.find(t => t.id === transportId);

		if (!transport) {
			return { time: Date.now(), found: false };
		}

		return {
			time: snap.time,
			found: true,
			transport,
			consumers: snap.consumers.filter(c => c.transportId === transportId),
			producers: snap.producers.filter(p => p.transportId === transportId),
			errors: [],
		};
	}

	close(): void {}

	#createRoom(index: number, viewers: number): SimRoom {
		const n = this.#workers.length;
		const room: SimRoom = {
			roomId: `room-${String.fromCharCode(97 + index)}`,
			createdAt: new Date(Date.now() - (30 + index * 20) * 60000).toISOString(),
			producerWorker: index % n,
			shardWorkers: [index % n, (index + 1) % n],
			producerRouterId: `rt-p-${index}`,
			// 방송마다 상태가 조금씩 다르게: 한 방송은 pipe loss가 높다.
			pipeLoss: index === 1 ? 0.03 : 0.002,
			targetViewers: 0,
			inputs: [],
			viewers: [],
			edgeLinks: [],
		};

		const broadcasters = this.#mode === 'origin' ? 1 + (index % 2) : 1;

		for (let b = 0; b < broadcasters; b++) {
			const peerId = this.#mode === 'origin' ? `host-${index}-${b}` : '__external__';
			const transportId = this.#mode === 'origin' ? `tr-bc-${index}-${b}` : `tr-pipe-in-${index}`;

			room.inputs.push(
				newStream(`pr-${index}-${b}-v`, transportId, peerId, 'video', this.#mode === 'origin' ? 3 : 1, 2_500_000),
				newStream(`pr-${index}-${b}-a`, transportId, peerId, 'audio', 1, 48_000)
			);
		}

		if (this.#mode === 'origin') {
			for (const edge of this.#edgeTargets) {
				room.edgeLinks.push({
					transportId: `tr-pipe-out-${index}-${edge.edgeId}`,
					remoteIp: edge.ip,
					loss: edge.edgeId.endsWith('1') ? 0.02 : 0.001,
					counters: new Map(),
				});
			}
		}

		const viewerCount = this.#mode === 'origin' ? Math.ceil(viewers / 10) : viewers;

		room.targetViewers = viewerCount;

		for (let v = 0; v < viewerCount; v++) {
			room.viewers.push(this.#newViewer(room));
		}

		return room;
	}

	#newViewer(room: SimRoom): SimViewer {
		const r = this.#rand();
		// 대부분은 양호, 일부는 loss가 높은 viewer.
		const loss = r < 0.75 ? this.#rand() * 0.01 : r < 0.93 ? 0.01 + this.#rand() * 0.04 : 0.05 + this.#rand() * 0.1;
		const shard = room.shardWorkers[Math.floor(this.#rand() * room.shardWorkers.length)] ?? 0;
		const id = `tr-v-${(this.#seq++).toString(36)}-${Math.floor(this.#rand() * 1e6).toString(36)}`;

		return {
			transportId: id,
			peerId: `peer-${id.slice(5)}`,
			shardWorker: shard,
			loss,
			baseLoss: loss,
			rttMs: 20 + this.#rand() * 120 + loss * 1000,
			spatialLayer: loss > 0.05 ? 0 : loss > 0.01 ? 1 : 2,
			dtlsState: 'connected',
			video: newCounters(),
			audio: newCounters(),
		};
	}

	#advance(): void {
		const now = Date.now();
		const dt = Math.max(0, (now - this.#lastTime) / 1000);

		this.#lastTime = now;

		for (const room of this.#rooms) {
			for (const input of room.inputs) {
				for (const s of input.streams) {
					const pps = s.bitrate / 8 / 1100;
					const packets = Math.round(pps * dt);
					const loss = this.#mode === 'edge' ? room.pipeLoss : 0.003;
					const lost = binomial(packets, loss, this.#rand);
					const repaired = Math.round(lost * 0.8);

					s.c.packetCount += packets - lost + repaired;
					s.c.byteCount += Math.round((s.bitrate / 8) * dt);
					s.c.packetsLost += lost;
					s.c.packetsRepaired += repaired;
					s.c.packetsRetransmitted += repaired;
					s.c.nackCount += lost > 0 ? Math.ceil(lost / 3) : 0;
					s.c.pliCount += this.#rand() < 0.02 * dt ? 1 : 0;
				}
			}

			for (const link of room.edgeLinks) {
				for (const input of room.inputs) {
					const c = link.counters.get(input.id) ?? newCounters();
					const bitrate = input.streams.reduce((a, s) => a + s.bitrate, 0);
					const packets = Math.round((bitrate / 8 / 1100) * dt);
					const lost = binomial(packets, link.loss, this.#rand);

					c.packetCount += packets;
					c.byteCount += Math.round((bitrate / 8) * dt);
					c.packetsLost += lost;
					c.nackCount += lost > 0 ? Math.ceil(lost / 2) : 0;
					c.packetsRetransmitted += lost;
					link.counters.set(input.id, c);
				}
			}

			// viewer 이탈/접속: 처음 인원 근처에서 오르내린다.
			room.viewers = room.viewers.filter(() => this.#rand() > 0.005 * dt);

			const missing = Math.max(0, room.targetViewers - room.viewers.length);
			const joins = binomial(missing, Math.min(1, 0.03 * dt), this.#rand);

			for (let i = 0; i < joins; i++) {
				room.viewers.push(this.#newViewer(room));
			}

			for (const viewer of room.viewers) {
				// 가끔 품질이 출렁이고, 시간이 지나면 원래 수준으로 돌아온다.
				if (this.#rand() < 0.02 * dt) {
					viewer.loss = Math.min(0.2, viewer.loss * (1 + this.#rand() * 2));
				} else {
					viewer.loss += (viewer.baseLoss - viewer.loss) * Math.min(1, 0.05 * dt);
				}

				for (const [kind, c, bitrate] of [
					['video', viewer.video, [300_000, 900_000, 2_000_000][viewer.spatialLayer] ?? 900_000],
					['audio', viewer.audio, 48_000],
				] as const) {
					const packets = Math.round((bitrate / 8 / 1100) * dt);
					const lost = binomial(packets, viewer.loss, this.#rand);

					c.packetCount += packets;
					c.byteCount += Math.round((bitrate / 8) * dt);
					c.packetsLost += lost;
					c.nackCount += kind === 'video' && lost > 0 ? Math.ceil(lost / 2) : 0;
					c.packetsRetransmitted += kind === 'video' ? Math.round(lost * 1.2) : 0;
					c.bitrate = bitrate;
				}
			}
		}

		for (const worker of this.#workers) {
			const share = this.#rooms.reduce(
				(acc, room) =>
					acc +
					room.viewers.filter(v => v.shardWorker === worker.idx).length * 0.004 +
					(room.producerWorker === worker.idx ? 0.05 : 0),
				0.02
			);

			worker.cpuShare = Math.min(0.98, share * (0.9 + this.#rand() * 0.2));
			worker.cpuMs += worker.cpuShare * dt * 1000;
			worker.rssBytes = Math.round(50e6 + share * 200e6);
			worker.usage = {
				ru_utime: Math.round(worker.cpuMs * 0.8),
				ru_stime: Math.round(worker.cpuMs * 0.2),
				ru_maxrss: Math.max(worker.usage?.ru_maxrss ?? 0, Math.round(worker.rssBytes / 1024)),
				ru_nvcsw: (worker.usage?.ru_nvcsw ?? 0) + Math.round(worker.cpuShare * 9000 * dt),
				ru_nivcsw: (worker.usage?.ru_nivcsw ?? 0) + Math.round(worker.cpuShare * 600 * dt),
			};
		}
	}

	#build(withStats: boolean): RawSnapshot {
		const time = Date.now();
		const routers: RawRouter[] = [];
		const transports: RawTransport[] = [];
		const producers: RawProducer[] = [];
		const consumers: RawConsumer[] = [];
		const rooms: RawRoom[] = [];
		const pid = (idx: number) => 1000 + idx;

		for (const room of this.#rooms) {
			const shardRouterId = (w: number) => (w === room.producerWorker ? room.producerRouterId : `rt-c-${room.roomId}-${w}`);

			routers.push({ id: room.producerRouterId, workerPid: pid(room.producerWorker) });

			for (const w of room.shardWorkers) {
				if (w !== room.producerWorker) {
					routers.push({ id: shardRouterId(w), workerPid: pid(w) });
				}
			}

			// 입력: edge는 pipe, origin은 webrtc broadcaster
			const inputTransports = new Set(room.inputs.map(i => i.transportId));

			for (const transportId of inputTransports) {
				transports.push(
					transport(transportId, room.producerRouterId, this.#mode === 'edge' ? 'pipe' : 'webrtc', 'producer', {
						remoteIp: this.#mode === 'edge' ? '10.0.0.1' : null,
					})
				);
			}

			for (const input of room.inputs) {
				producers.push({
					id: input.id,
					transportId: input.transportId,
					kind: input.kind,
					type: input.streams.length > 1 ? 'simulcast' : 'simple',
					paused: false,
					peerId: input.peerId,
					source: input.kind,
					stats: withStats
						? input.streams.map((s, i) => rtp('inbound-rtp', input.kind, s.c, s.bitrate, i, input.streams.length > 1))
						: null,
				});
			}

			// 다른 worker shard로의 로컬 pipe (pipeToRouter: 같은 producer id)
			for (const w of room.shardWorkers) {
				if (w === room.producerWorker) {
					continue;
				}

				const localOut = `tr-lp-out-${room.roomId}-${w}`;
				const localIn = `tr-lp-in-${room.roomId}-${w}`;

				transports.push(transport(localOut, room.producerRouterId, 'pipe', null, { remoteIp: '127.0.0.1', localIp: '127.0.0.1' }));
				transports.push(transport(localIn, shardRouterId(w), 'pipe', null, { remoteIp: '127.0.0.1', localIp: '127.0.0.1' }));

				for (const input of room.inputs) {
					producers.push({
						id: input.id,
						transportId: localIn,
						kind: input.kind,
						peerId: input.peerId,
						source: input.kind,
						stats: withStats ? [rtp('inbound-rtp', input.kind, input.streams[0]!.c, input.streams[0]!.bitrate, 0, false)] : null,
					});
				}
			}

			// origin → edge pipe
			for (const link of room.edgeLinks) {
				transports.push(
					transport(link.transportId, room.producerRouterId, 'pipe', null, {
						remoteIp: link.remoteIp,
						localIp: '10.0.0.1',
						sendBitrate: room.inputs.reduce((a, i) => a + i.streams.reduce((b, s) => b + s.bitrate, 0), 0),
					})
				);

				for (const input of room.inputs) {
					const c = link.counters.get(input.id) ?? newCounters();

					consumers.push({
						id: `co-${link.transportId}-${input.id}`,
						transportId: link.transportId,
						producerId: input.id,
						kind: input.kind,
						type: 'pipe',
						currentLayers: null,
						stats: withStats
							? [{ ...rtp('outbound-rtp', input.kind, c, input.streams.reduce((a, s) => a + s.bitrate, 0), 0, false), roundTripTime: 30 + link.loss * 800 }]
							: null,
					});
				}
			}

			for (const viewer of room.viewers) {
				transports.push(
					transport(viewer.transportId, shardRouterId(viewer.shardWorker), 'webrtc', 'consumer', {
						dtlsState: viewer.dtlsState,
						sendBitrate: viewer.video.bitrate + viewer.audio.bitrate,
					})
				);

				for (const input of room.inputs) {
					const c = input.kind === 'video' ? viewer.video : viewer.audio;

					consumers.push({
						id: `co-${viewer.transportId}-${input.id}`,
						transportId: viewer.transportId,
						producerId: input.id,
						kind: input.kind,
						type: input.kind === 'video' && input.streams.length > 1 ? 'simulcast' : 'simple',
						paused: false,
						producerPaused: false,
						currentLayers: input.kind === 'video' ? { spatialLayer: viewer.spatialLayer, temporalLayer: 2 } : null,
						stats: withStats
							? [{ ...rtp('outbound-rtp', input.kind, c, c.bitrate, 0, false), roundTripTime: viewer.rttMs * (0.9 + Math.random() * 0.2) }]
							: null,
					});
				}
			}

			rooms.push({
				roomId: room.roomId,
				createdAt: room.createdAt,
				producerRouterId: room.producerRouterId,
				consumerRouterId: shardRouterId(room.shardWorkers[0] ?? room.producerWorker),
				peers: [
					...room.viewers.map(v => ({
						peerId: v.peerId,
						displayName: null,
						device: { flag: 'chrome', name: 'Chrome', version: '130' },
						remoteAddress: null,
					})),
					...(this.#mode === 'origin'
						? [...new Set(room.inputs.map(i => i.peerId))].map(peerId => ({
								peerId,
								displayName: peerId.replace('host-', 'host-'),
								device: { flag: 'chrome', name: 'Chrome', version: '130' },
								remoteAddress: null,
							}))
						: []),
				],
				broadcasterPeers: [],
			});
		}

		return {
			protocol: HOOK_PROTOCOL_VERSION,
			time,
			durationMs: 5 + Math.round(consumers.length / 50),
			process: { pid: 999, rssBytes: 120e6, eventLoopLagP99Ms: 2 + this.#rand() * 6 },
			workers: this.#workers.map(({ pid: p, idx, usage, rssBytes }) => ({ pid: p, idx, usage: usage && { ...usage }, rssBytes })),
			routers,
			transports,
			producers,
			consumers,
			rooms,
			errors: [],
			errorCount: 0,
		};
	}
}

type Counters = {
	packetCount: number;
	byteCount: number;
	packetsLost: number;
	packetsRepaired: number;
	packetsRetransmitted: number;
	nackCount: number;
	pliCount: number;
	bitrate: number;
};

type SimInput = {
	id: string;
	transportId: string;
	peerId: string;
	kind: 'audio' | 'video';
	streams: Array<{ bitrate: number; c: Counters }>;
};

type SimViewer = {
	transportId: string;
	peerId: string;
	shardWorker: number;
	loss: number;
	baseLoss: number;
	rttMs: number;
	spatialLayer: number;
	dtlsState: string;
	video: Counters;
	audio: Counters;
};

type SimRoom = {
	roomId: string;
	createdAt: string;
	producerWorker: number;
	shardWorkers: number[];
	producerRouterId: string;
	pipeLoss: number;
	targetViewers: number;
	inputs: SimInput[];
	viewers: SimViewer[];
	edgeLinks: Array<{ transportId: string; remoteIp: string; loss: number; counters: Map<string, Counters> }>;
};

function newCounters(): Counters {
	return { packetCount: 0, byteCount: 0, packetsLost: 0, packetsRepaired: 0, packetsRetransmitted: 0, nackCount: 0, pliCount: 0, bitrate: 0 };
}

function newStream(id: string, transportId: string, peerId: string, kind: 'audio' | 'video', layers: number, bitrate: number): SimInput {
	const shares = layers === 3 ? [0.12, 0.28, 0.6] : [1];

	return {
		id,
		transportId,
		peerId,
		kind,
		streams: shares.map(s => ({ bitrate: Math.round(bitrate * s), c: newCounters() })),
	};
}

function transport(
	id: string,
	routerId: string,
	type: RawTransport['type'],
	direction: string | null,
	opts: { remoteIp?: string | null; localIp?: string; dtlsState?: string; sendBitrate?: number }
): RawTransport {
	return {
		id,
		routerId,
		type,
		direction,
		iceState: type === 'webrtc' ? 'completed' : null,
		dtlsState: type === 'webrtc' ? (opts.dtlsState ?? 'connected') : null,
		tuple:
			type === 'pipe' || type === 'plain'
				? { localIp: opts.localIp ?? '10.0.0.2', localPort: 40000, remoteIp: opts.remoteIp ?? null, remotePort: 40001 }
				: null,
		stats: [{ type: `${type}-transport`, timestamp: Date.now(), sendBitrate: opts.sendBitrate ?? 0 }],
	};
}

function rtp(type: string, kind: string, c: Counters, bitrate: number, layer: number, simulcast: boolean): RawRtpStat {
	return {
		type,
		kind,
		ssrc: 1000 + layer,
		rid: simulcast ? `r${layer}` : undefined,
		mimeType: kind === 'video' ? 'video/VP8' : 'audio/opus',
		timestamp: Date.now(),
		packetCount: c.packetCount,
		byteCount: c.byteCount,
		bitrate,
		packetsLost: c.packetsLost,
		fractionLost: 0,
		jitter: kind === 'video' ? 900 : 480,
		packetsRetransmitted: c.packetsRetransmitted,
		packetsRepaired: c.packetsRepaired,
		nackCount: c.nackCount,
		pliCount: c.pliCount,
		firCount: 0,
		roundTripTime: 0,
	};
}

function binomial(n: number, p: number, rand: () => number): number {
	if (n <= 0 || p <= 0) {
		return 0;
	}

	// 정규 근사 (n이 커서 충분)
	const mean = n * p;
	const sd = Math.sqrt(n * p * (1 - p));
	const z = Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());

	return Math.max(0, Math.min(n, Math.round(mean + sd * z)));
}

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;

	return () => {
		a = (a + 0x6d2b79f5) >>> 0;

		let t = a;

		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
