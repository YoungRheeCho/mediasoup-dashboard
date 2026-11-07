import type { RawPeer, RawSnapshot } from '../hookProtocol.js';
import type {
	EdgeBatch,
	EdgeRoomSampleRow,
	PipeSampleRow,
	ViewerSampleRow,
	ViewerSessionEnd,
	ViewerSessionStart,
} from '../db/rows.js';
import { mockClientReport, mockDisconnectReason, mockViewerIdentity } from '../mock/index.js';
import { freshClientStats, hasClientStats } from './clientStats.js';
import { DeltaTracker, sumStrict } from './delta.js';
import {
	Topology,
	avg,
	clientIpOf,
	jitterMs,
	rtpEntries,
	rttOf,
	sumOrNull,
	transportState,
	workerRows,
} from './topology.js';
import type { CycleContext } from './types.js';

/**
 * edge 정규화. 수집 주기마다 같은 인스턴스를 쓴다 (delta·세션 상태를 기억).
 */
export class EdgeNormalizer {
	readonly delta = new DeltaTracker();
	/**
	 * 접속 중인 viewer: viewerId(consumer transport id) → 마지막 상태.
	 * identityResolved: 실제 peer 정보와 IP로 세션을 채웠는지. 아니면 매 주기 다시 찾아본다
	 * (transport가 먼저 보이고 peer 정보나 ICE 연결(IP)이 늦게 보일 수 있다).
	 */
	readonly #viewers = new Map<string, { lastState: string | null; identityResolved: boolean }>();

	/** 사이드카 재시작 시 DB에 열린 채로 남은 세션을 넘겨받는다. 이번 스냅숏에 없으면 종료 처리된다. */
	adoptOpenSessions(viewerIds: string[]): void {
		for (const id of viewerIds) {
			if (!this.#viewers.has(id)) {
				// DB 쪽 갱신은 실제 값이 이미 있으면 덮어쓰지 않으므로 다시 찾아봐도 안전하다.
				this.#viewers.set(id, { lastState: null, identityResolved: false });
			}
		}
	}

	get openSessionCount(): number {
		return this.#viewers.size;
	}

	normalize(raw: RawSnapshot, ctx: CycleContext): EdgeBatch {
		const time = new Date(raw.time);
		const topology = new Topology(raw);
		const viewerSamples: ViewerSampleRow[] = [];
		const starts: ViewerSessionStart[] = [];
		const ends: ViewerSessionEnd[] = [];
		const pipeSamples: PipeSampleRow[] = [];
		const roomAgg = new Map<string, EdgeRoomSampleRow>();
		const seenViewers = new Set<string>();
		const peersByRoom = new Map(raw.rooms.map(r => [r.roomId, new Map(r.peers.map(p => [p.peerId, p]))]));

		const roomRow = (roomId: string, workerIdx: number): EdgeRoomSampleRow => {
			const key = `${roomId}|${workerIdx}`;
			let row = roomAgg.get(key);

			if (!row) {
				row = { time, roomId, workerIdx, viewerCount: 0, producerCount: null, outBitrateBps: null, inBitrateBps: null };
				roomAgg.set(key, row);
			}

			return row;
		};

		// ---- viewer: consumer 방향 WebRtcTransport 하나 = viewer 한 명 ----
		for (const t of raw.transports) {
			if (t.type !== 'webrtc' || t.direction !== 'consumer') {
				continue;
			}

			const roomId = topology.roomOfTransport(t);

			if (!roomId) {
				continue;
			}

			const workerIdx = topology.workerIdxOfRouter(t.routerId);
			const consumers = topology.consumersByTransport.get(t.id) ?? [];
			const entries = consumers.flatMap(c =>
				rtpEntries(c.stats, 'outbound-rtp').map(s => ({ c, s, key: `${c.id}:${s.ssrc ?? 0}` }))
			);
			const d = (field: 'packetCount' | 'packetsLost' | 'nackCount' | 'packetsRetransmitted') =>
				entries.length ? sumStrict(entries.map(e => this.delta.delta(`v:${e.key}:${field}`, e.s[field]))) : null;

			const packetsExpected = d('packetCount');
			const packetsLost = d('packetsLost');
			const video = consumers.find(c => c.kind === 'video');
			const state = transportState(t);
			const lossRatio = packetsExpected && packetsLost !== null ? packetsLost / packetsExpected : null;
			const client = this.#clientReport(t, raw.time) ?? (ctx.mockEnabled && !hasClientStats(t) ? mockClientReport(t.id, raw.time, lossRatio, ctx.intervalMs) : null);
			const bitrate = sumOrNull(entries.map(e => e.s.bitrate));

			viewerSamples.push({
				time,
				viewerId: t.id,
				roomId,
				workerIdx,
				packetsExpected,
				packetsLost,
				nackCount: d('nackCount'),
				packetsRetransmitted: d('packetsRetransmitted'),
				rttMs: rttOf(entries.filter(e => e.c.kind === 'video').map(e => e.s)) ?? rttOf(entries.map(e => e.s)),
				bitrateBps: bitrate,
				spatialLayer: video?.currentLayers?.spatialLayer ?? null,
				temporalLayer: video?.currentLayers?.temporalLayer ?? null,
				transportState: state,
				// 실제 브라우저 보고일 때만 true. mock으로 채운 구간은 false (화면이 이 값으로 MOCK 배지를 정한다).
				clientReported: client !== null && 'real' in client,
				clientFreezeCount: client?.clientFreezeCount ?? null,
				clientFreezeMs: client?.clientFreezeMs ?? null,
				clientFps: client?.clientFps ?? null,
				clientJitterBufferMs: client?.clientJitterBufferMs ?? null,
				clientFramesDropped: client?.clientFramesDropped ?? null,
			});

			seenViewers.add(t.id);

			const known = this.#viewers.get(t.id);
			const peer = t.peerId ? peersByRoom.get(roomId)?.get(t.peerId) : undefined;
			const ip = clientIpOf(t);

			if (!known) {
				starts.push(this.#sessionStart(t.id, roomId, workerIdx, time, peer, ip, ctx.mockEnabled));
				this.#viewers.set(t.id, { lastState: state, identityResolved: peer !== undefined && ip !== null });
			} else {
				known.lastState = state;

				// 처음엔 peer나 IP를 못 찾았는데 이제 찾았다 → 같은 viewerId로 다시 보내 신원 칸만 갱신한다 (edgeStore의 upsert).
				if (!known.identityResolved && peer) {
					starts.push(this.#sessionStart(t.id, roomId, workerIdx, time, peer, ip, ctx.mockEnabled));
					known.identityResolved = ip !== null;
				}
			}

			const row = roomRow(roomId, workerIdx ?? -1);

			row.viewerCount++;
			row.outBitrateBps = (row.outBitrateBps ?? 0) + (bitrate ?? 0);
		}

		for (const [viewerId, info] of this.#viewers) {
			if (!seenViewers.has(viewerId)) {
				ends.push({
					viewerId,
					disconnectedAt: time,
					disconnectReason: ctx.mockEnabled ? mockDisconnectReason(viewerId, info.lastState) : info.lastState === 'failed' ? 'transport_failed' : null,
				});
				this.#viewers.delete(viewerId);
			}
		}

		// ---- pipe 수신: 방송 producer router 위 PipeTransport의 producer (origin → edge) ----
		for (const [roomId, routerId] of topology.producerRouterOfRoom) {
			const workerIdx = topology.workerIdxOfRouter(routerId) ?? -1;
			const row = roomRow(roomId, workerIdx);

			row.producerCount = row.producerCount ?? 0;

			for (const t of raw.transports) {
				if (t.routerId !== routerId || t.type !== 'pipe') {
					continue;
				}

				// peerId로 거르지 않는다. Server.edge.ts의 /pipe/produce는 peerId를 EXTERNAL_PEER_ID로 넣은 뒤
				// origin이 보낸 appData로 덮어써서, 실제로는 origin broadcaster의 peerId가 들어온다.
				// 방송 producer router 위 PipeTransport의 producer는 모두 origin에서 받은 것이다.
				for (const p of topology.producersByTransport.get(t.id) ?? []) {
					const entries = rtpEntries(p.stats, 'inbound-rtp');
					const d = (field: 'packetCount' | 'packetsLost' | 'packetsRepaired' | 'nackCount' | 'pliCount') =>
						entries.length
							? sumStrict(entries.map(s => this.delta.delta(`p:${p.id}@${t.id}:${s.ssrc ?? 0}:${field}`, s[field])))
							: null;
					const received = d('packetCount');
					const lost = d('packetsLost');
					const repaired = d('packetsRepaired');
					const bitrate = sumOrNull(entries.map(s => s.bitrate));

					// 수신 stream의 packetCount는 RTX 복구분을 포함한다 → 원래 와야 했던 패킷 = 받은 것 - 복구 + 유실
					const expected = received !== null && lost !== null && repaired !== null ? received - repaired + lost : null;

					pipeSamples.push({
						time,
						roomId,
						producerId: p.id,
						kind: p.kind,
						packetsExpected: expected,
						packetsLost: lost,
						packetsRepaired: repaired,
						bitrateBps: bitrate,
						rttMs: rttOf(entries),
						jitterMs: avg(entries.map(jitterMs)),
						nackCount: d('nackCount'),
						pliCount: d('pliCount'),
					});

					row.producerCount++;
					row.inBitrateBps = (row.inBitrateBps ?? 0) + (bitrate ?? 0);
				}
			}
		}

		const batch: EdgeBatch = {
			mode: 'edge',
			time,
			rooms: raw.rooms.map(r => r.roomId),
			collector: {
				time,
				hookOk: true,
				collectDurationMs: ctx.collectDurationMs,
				collectSkipped: ctx.skipped,
				eventLoopLagMs: raw.process.eventLoopLagP99Ms,
				nodeRssBytes: raw.process.rssBytes,
				hostCpuPct: ctx.hostCpuPct,
			},
			workers: workerRows(topology, this.delta, time),
			roomSamples: [...roomAgg.values()].filter(r => r.workerIdx >= 0),
			pipeSamples,
			viewerSamples,
			viewerSessionStarts: starts,
			viewerSessionEnds: ends,
		};

		this.delta.sweep();

		return batch;
	}

	/**
	 * 브라우저 보고(M2)를 수집 구간 값으로. freeze·dropped는 누적값이라 이전 수집과의 차이를 쓴다.
	 * 한 번이라도 보고한 transport는 보고가 끊겨도 mock으로 채우지 않는다 (호출하는 쪽에서 hasClientStats로 판단).
	 */
	#clientReport(t: RawSnapshot['transports'][number], now: number) {
		const s = freshClientStats(t, now);

		if (!s) {
			return null;
		}

		const freezeMs = this.delta.delta(`c:${t.id}:freezeMs`, s.freezeSec === null ? null : s.freezeSec * 1000);

		return {
			real: true as const,
			clientFreezeCount: this.delta.delta(`c:${t.id}:freeze`, s.freezeCount),
			clientFreezeMs: freezeMs === null ? null : Math.round(freezeMs),
			clientFps: s.fps === null ? null : Math.round(s.fps * 10) / 10,
			clientJitterBufferMs: s.jitterBufferMs === null ? null : Math.round(s.jitterBufferMs),
			clientFramesDropped: this.delta.delta(`c:${t.id}:dropped`, s.framesDropped),
		};
	}

	/**
	 * viewer 세션 시작 행.
	 * peer가 있으면(서버가 transport appData에 peerId를 넣은 경우, M1) 이름·브라우저는 실제 값이다.
	 * IP는 peer와 상관없이 transport의 ICE 선택 경로에서 읽은 실제 값이다 (clientIpOf).
	 * 기기 종류·네트워크(M3·M4)는 peer 정보에 없으므로 계속 mock이다.
	 * user agent는 mock이 실제 브라우저와 어긋나 보일 수 있어 실제 신원일 때는 비운다.
	 */
	#sessionStart(
		viewerId: string,
		roomId: string,
		workerIdx: number | null,
		time: Date,
		peer: RawPeer | undefined,
		ip: string | null,
		mockEnabled: boolean
	): ViewerSessionStart {
		const mock = mockEnabled ? mockViewerIdentity(viewerId) : null;
		const base = { viewerId, roomId, workerIdx, connectedAt: time, deviceClass: mock?.deviceClass ?? null, networkType: mock?.networkType ?? null };

		if (peer) {
			return {
				...base,
				identitySource: 'peer',
				peerId: peer.peerId,
				displayName: peer.displayName,
				deviceFlag: peer.device?.flag ?? null,
				browserName: peer.device?.name ?? null,
				browserVersion: peer.device?.version ?? null,
				remoteIp: ip,
				userAgent: null,
			};
		}

		return {
			...base,
			identitySource: mock ? 'mock' : null,
			peerId: mock?.peerId ?? null,
			displayName: mock?.displayName ?? null,
			deviceFlag: mock?.deviceFlag ?? null,
			browserName: null,
			browserVersion: null,
			remoteIp: ip,
			userAgent: mock?.userAgent ?? null,
		};
	}
}
