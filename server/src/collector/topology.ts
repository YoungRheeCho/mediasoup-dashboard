import type { RawConsumer, RawProducer, RawRoom, RawRtpStat, RawSnapshot, RawTransport } from '../hookProtocol.js';
import type { WorkerSampleRow } from '../db/rows.js';
import type { DeltaTracker } from './delta.js';

/**
 * remote pipe producer의 appData.peerId 기본값 (mediasoup-demo Server.edge.ts의 EXTERNAL_PEER_ID).
 * edge는 이 값에 기대지 않는다: /pipe/produce가 origin이 보낸 appData로 덮어써서 broadcaster peerId가 들어온다.
 */
export const EXTERNAL_PEER_ID = '__external__';

/**
 * 원시 스냅숏의 객체 관계를 찾기 쉽게 색인한다.
 *
 * router → room 연결은 서버가 appData를 주지 않아 추정한다 (collection-design.md M6).
 *  1. room.getRouterId('producer' | 'consumer')로 알려진 router
 *  2. 나머지 consumer router shard: pipeToRouter는 같은 producer id로 복제하므로,
 *     방송 producer router의 producer id를 가진 router를 그 방송의 shard로 본다.
 */
export class Topology {
	readonly workerIdxByPid = new Map<number, number>();
	readonly routerWorkerPid = new Map<string, number>();
	readonly transports = new Map<string, RawTransport>();
	readonly producersByTransport = new Map<string, RawProducer[]>();
	readonly consumersByTransport = new Map<string, RawConsumer[]>();
	readonly roomByRouter = new Map<string, string>();
	readonly rooms = new Map<string, RawRoom>();
	readonly producerRouterOfRoom = new Map<string, string>();

	constructor(readonly raw: RawSnapshot) {
		for (const w of raw.workers) {
			this.workerIdxByPid.set(w.pid, w.idx ?? w.pid);
		}

		for (const r of raw.routers) {
			this.routerWorkerPid.set(r.id, r.workerPid);
		}

		for (const t of raw.transports) {
			this.transports.set(t.id, t);
		}

		for (const p of raw.producers) {
			push(this.producersByTransport, p.transportId, p);
		}

		for (const c of raw.consumers) {
			push(this.consumersByTransport, c.transportId, c);
		}

		for (const room of raw.rooms) {
			this.rooms.set(room.roomId, room);

			if (room.producerRouterId) {
				this.roomByRouter.set(room.producerRouterId, room.roomId);
				this.producerRouterOfRoom.set(room.roomId, room.producerRouterId);
			}

			if (room.consumerRouterId) {
				this.roomByRouter.set(room.consumerRouterId, room.roomId);
			}
		}

		// shard 추정
		const roomOfProducerId = new Map<string, string>();

		for (const [roomId, routerId] of this.producerRouterOfRoom) {
			for (const p of this.producersOnRouter(routerId)) {
				roomOfProducerId.set(p.id, roomId);
			}
		}

		for (const p of raw.producers) {
			const routerId = this.transports.get(p.transportId)?.routerId;
			const roomId = roomOfProducerId.get(p.id);

			if (routerId && roomId && !this.roomByRouter.has(routerId)) {
				this.roomByRouter.set(routerId, roomId);
			}
		}
	}

	workerIdxOfRouter(routerId: string): number | null {
		const pid = this.routerWorkerPid.get(routerId);

		return pid === undefined ? null : (this.workerIdxByPid.get(pid) ?? null);
	}

	roomOfTransport(transport: RawTransport): string | null {
		return this.roomByRouter.get(transport.routerId) ?? null;
	}

	producersOnRouter(routerId: string): RawProducer[] {
		const out: RawProducer[] = [];

		for (const t of this.raw.transports) {
			if (t.routerId === routerId) {
				out.push(...(this.producersByTransport.get(t.id) ?? []));
			}
		}

		return out;
	}

	peerOf(roomId: string, peerId: string | null) {
		if (!peerId) {
			return undefined;
		}

		const room = this.rooms.get(roomId);

		return room?.peers.find(p => p.peerId === peerId) ?? room?.broadcasterPeers.find(p => p.peerId === peerId);
	}

	/** 같은 서버 안의 로컬 pipe(pipeToRouter)가 아닌, 다른 서버로 연결된 pipe인지. */
	isRemotePipe(transport: RawTransport): boolean {
		const tuple = transport.tuple;

		if (transport.type !== 'pipe' || !tuple?.remoteIp) {
			return false;
		}

		return tuple.remoteIp !== tuple.localIp && !tuple.remoteIp.startsWith('127.') && tuple.remoteIp !== '::1';
	}
}

/** worker 행. CPU는 getResourceUsage 누적 utime+stime(ms)의 증가분 / 경과 시간. */
export function workerRows(topology: Topology, delta: DeltaTracker, time: Date): WorkerSampleRow[] {
	const raw = topology.raw;
	const counts = new Map<number, { routers: number; transports: number; producers: number; consumers: number }>();

	for (const w of raw.workers) {
		counts.set(w.pid, { routers: 0, transports: 0, producers: 0, consumers: 0 });
	}

	for (const r of raw.routers) {
		const c = counts.get(r.workerPid);

		if (c) {
			c.routers++;
		}
	}

	for (const t of raw.transports) {
		const c = counts.get(topology.routerWorkerPid.get(t.routerId) ?? -1);

		if (c) {
			c.transports++;
			c.producers += topology.producersByTransport.get(t.id)?.length ?? 0;
			c.consumers += topology.consumersByTransport.get(t.id)?.length ?? 0;
		}
	}

	return raw.workers.map(w => {
		const cpuMs = w.usage ? w.usage.ru_utime + w.usage.ru_stime : null;
		const dCpu = delta.delta(`worker:${w.pid}:cpu`, cpuMs);
		const dWall = delta.delta(`worker:${w.pid}:wall`, cpuMs === null ? null : raw.time);
		const c = counts.get(w.pid)!;

		return {
			time,
			workerIdx: w.idx ?? w.pid,
			cpuPct: dCpu !== null && dWall ? round2(Math.min(100, (dCpu / dWall) * 100)) : null,
			memRssBytes: w.rssBytes,
			routerCount: c.routers,
			transportCount: c.transports,
			producerCount: c.producers,
			consumerCount: c.consumers,
		};
	});
}

/** stats 배열에서 한 방향(type)의 RTP 항목만. */
export function rtpEntries(stats: RawRtpStat[] | null, type: 'inbound-rtp' | 'outbound-rtp'): RawRtpStat[] {
	return (stats ?? []).filter(s => s.type === type);
}

/** mediasoup의 jitter는 RTP timestamp 단위다. clock rate로 ms로 바꾼다. */
export function jitterMs(stat: RawRtpStat): number | null {
	if (stat.jitter === undefined || stat.jitter === null) {
		return null;
	}

	const mime = (stat.mimeType ?? '').toLowerCase();
	const clockRate = mime.startsWith('audio/') ? (mime.includes('opus') ? 48000 : 8000) : 90000;

	return round2((stat.jitter / clockRate) * 1000);
}

/** roundTripTime 0은 "측정 안 됨"(RR/DLRR 없음)이라 null로 본다. */
export function rttOf(stats: RawRtpStat[]): number | null {
	let best: number | null = null;

	for (const s of stats) {
		if (typeof s.roundTripTime === 'number' && s.roundTripTime > 0) {
			best = best === null ? s.roundTripTime : Math.max(best, s.roundTripTime);
		}
	}

	return best === null ? null : round2(best);
}

export function avg(values: Array<number | null>): number | null {
	const v = values.filter((x): x is number => x !== null);

	return v.length ? round2(v.reduce((a, b) => a + b, 0) / v.length) : null;
}

export function sumOrNull(values: Array<number | undefined>): number | null {
	const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));

	return v.length ? Math.round(v.reduce((a, b) => a + b, 0)) : null;
}

export function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

/**
 * 상대(viewer·broadcaster)의 실제 IP.
 * WebRtcTransport는 getStats의 iceSelectedTuple(ICE 연결 후에만 있음), Plain/Pipe는 transport.tuple에서 읽는다.
 * mediasoup 서버가 hostNetwork로 돌아서 이 값이 클라이언트 공인 IP다 (WS remoteAddress는 pod IP라 쓰지 않는다).
 */
export function clientIpOf(t: RawTransport): string | null {
	for (const s of t.stats ?? []) {
		if (s.iceSelectedTuple?.remoteIp) {
			return s.iceSelectedTuple.remoteIp;
		}
	}

	return t.type !== 'webrtc' ? (t.tuple?.remoteIp ?? null) : null;
}

export function transportState(t: RawTransport): string | null {
	if (t.dtlsState === 'connected' && (t.iceState === 'connected' || t.iceState === 'completed')) {
		return 'connected';
	}

	if (t.dtlsState === 'failed' || t.iceState === 'disconnected' || t.dtlsState === 'closed') {
		return t.dtlsState === 'failed' || t.dtlsState === 'closed' ? 'failed' : 'disconnected';
	}

	return t.dtlsState ?? t.iceState ?? null;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
	const list = map.get(key);

	if (list) {
		list.push(value);
	} else {
		map.set(key, [value]);
	}
}
