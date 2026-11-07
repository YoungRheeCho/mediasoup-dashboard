import type { RawProducer, RawSnapshot } from '../hookProtocol.js';
import type {
	BroadcasterSampleRow,
	BroadcasterSessionStart,
	BroadcasterSessionUpdate,
	OriginBatch,
	OriginRoomSampleRow,
	PipeSendSampleRow,
	RoomEdgeLinkRow,
} from '../db/rows.js';
import { mockBroadcasterFps } from '../mock/index.js';
import { DeltaTracker, sumStrict } from './delta.js';
import { EXTERNAL_PEER_ID, Topology, avg, jitterMs, rtpEntries, rttOf, sumOrNull, workerRows } from './topology.js';
import type { CycleContext } from './types.js';

type BroadcasterState = { broadcasterId: string; roomId: string; state: 'sending' | 'idle' };

/**
 * origin 정규화.
 *
 * broadcaster = 방송 producer router 위에서 WebRTC/Plain transport로 들어온 producer를 peerId로 묶은 것.
 * producer appData에 peerId가 있어 이름은 room.serialize()에서 실제로 찾는다.
 * edge로 나가는 pipe = 다른 서버로 연결된 PipeTransport. 원격 IP로 edge를 추정한다 (M7).
 */
export class OriginNormalizer {
	readonly delta = new DeltaTracker();
	readonly #broadcasters = new Map<string, BroadcasterState>(); // `${roomId}/${peerId}`
	readonly #links = new Map<string, RoomEdgeLinkRow>(); // `${roomId}|${edgeId}`

	adoptOpenSessions(sessions: Array<{ broadcasterId: string; roomId: string; key: string; state: 'sending' | 'idle' }>): void {
		for (const s of sessions) {
			this.#broadcasters.set(s.key, { broadcasterId: s.broadcasterId, roomId: s.roomId, state: s.state });
		}
	}

	adoptLinks(links: RoomEdgeLinkRow[]): void {
		for (const l of links) {
			if (l.state === 'connected') {
				this.#links.set(`${l.roomId}|${l.edgeId}`, l);
			}
		}
	}

	normalize(raw: RawSnapshot, ctx: CycleContext): OriginBatch {
		const time = new Date(raw.time);
		const topology = new Topology(raw);
		const samples: BroadcasterSampleRow[] = [];
		const starts: BroadcasterSessionStart[] = [];
		const updates: BroadcasterSessionUpdate[] = [];
		const pipeSends: PipeSendSampleRow[] = [];
		const roomSamples: OriginRoomSampleRow[] = [];
		const seenBroadcasters = new Set<string>();
		const currentLinks = new Set<string>();
		const linkChanges: RoomEdgeLinkRow[] = [];
		const viewerLive: OriginBatch['viewerLive'] = [];

		for (const [roomId, routerId] of topology.producerRouterOfRoom) {
			// ---- broadcaster ----
			const groups = new Map<string, { producers: RawProducer[]; peerId: string | null }>();

			for (const t of raw.transports) {
				if (t.routerId !== routerId || (t.type !== 'webrtc' && t.type !== 'plain') || t.direction === 'consumer') {
					continue;
				}

				for (const p of topology.producersByTransport.get(t.id) ?? []) {
					if (p.peerId === EXTERNAL_PEER_ID) {
						continue;
					}

					const key = `${roomId}/${p.peerId ?? t.id}`;
					const group = groups.get(key) ?? { producers: [], peerId: p.peerId };

					group.producers.push(p);
					groups.set(key, group);
				}
			}

			for (const [key, group] of groups) {
				const video = group.producers.filter(p => p.kind === 'video');
				const videoEntries = video.flatMap(p => rtpEntries(p.stats, 'inbound-rtp').map(s => ({ p, s })));
				const allEntries = group.producers.flatMap(p => rtpEntries(p.stats, 'inbound-rtp'));
				const d = (field: 'packetCount' | 'packetsLost' | 'packetsRepaired' | 'nackCount' | 'pliCount') =>
					videoEntries.length
						? sumStrict(videoEntries.map(e => this.delta.delta(`b:${e.p.id}:${e.s.ssrc ?? 0}:${field}`, e.s[field])))
						: null;
				const received = d('packetCount');
				const lost = d('packetsLost');
				const repaired = d('packetsRepaired');
				const bitrate = sumOrNull(allEntries.map(s => s.bitrate));
				const sending = (bitrate ?? 0) > 0;
				const state: 'sending' | 'idle' = sending ? 'sending' : 'idle';
				let known = this.#broadcasters.get(key);

				if (!known) {
					const peer = topology.peerOf(roomId, group.peerId);

					known = {
						broadcasterId: `${key}@${Math.floor(raw.time / 1000)}`,
						roomId,
						state,
					};
					this.#broadcasters.set(key, known);
					starts.push({
						broadcasterId: known.broadcasterId,
						roomId,
						displayName: peer?.displayName ?? group.peerId,
						workerIdx: topology.workerIdxOfRouter(routerId),
						connectedAt: time,
					});
					updates.push({ broadcasterId: known.broadcasterId, state, disconnectedAt: null });
				} else if (known.state !== state) {
					known.state = state;
					updates.push({ broadcasterId: known.broadcasterId, state, disconnectedAt: null });
				}

				seenBroadcasters.add(key);

				samples.push({
					time,
					broadcasterId: known.broadcasterId,
					roomId,
					bitrateBps: bitrate,
					fps: ctx.mockEnabled ? mockBroadcasterFps(known.broadcasterId, raw.time, sending) : null,
					packetsExpected: received !== null && lost !== null && repaired !== null ? received - repaired + lost : null,
					packetsLost: lost,
					packetsRepaired: repaired,
					rttMs: rttOf(videoEntries.map(e => e.s)),
					jitterMs: avg(videoEntries.map(e => jitterMs(e.s))),
					nackCount: d('nackCount'),
					pliCount: d('pliCount'),
					layersActive: videoEntries.length ? videoEntries.filter(e => (e.s.bitrate ?? 0) > 0).length : null,
				});
			}

			// ---- edge로 나가는 pipe ----
			let outPipeBitrate: number | null = null;

			for (const t of raw.transports) {
				if (t.routerId !== routerId || !topology.isRemotePipe(t)) {
					continue;
				}

				const remoteIp = t.tuple!.remoteIp!;
				const edgeId = ctx.edgeIdByIp?.get(remoteIp) ?? null;

				for (const c of topology.consumersByTransport.get(t.id) ?? []) {
					const entries = rtpEntries(c.stats, 'outbound-rtp');
					const d = (field: 'packetCount' | 'packetsLost' | 'nackCount' | 'pliCount') =>
						entries.length ? sumStrict(entries.map(s => this.delta.delta(`ps:${c.id}:${s.ssrc ?? 0}:${field}`, s[field]))) : null;
					const bitrate = sumOrNull(entries.map(s => s.bitrate));

					pipeSends.push({
						time,
						roomId,
						edgeId,
						remoteIp,
						producerId: c.producerId,
						kind: c.kind,
						packetsExpected: d('packetCount'),
						packetsLost: d('packetsLost'),
						bitrateBps: bitrate,
						rttMs: rttOf(entries),
						nackCount: d('nackCount'),
						pliCount: d('pliCount'),
					});

					outPipeBitrate = (outPipeBitrate ?? 0) + (bitrate ?? 0);
				}

				if (edgeId) {
					const linkKey = `${roomId}|${edgeId}`;

					currentLinks.add(linkKey);

					if (!this.#links.has(linkKey)) {
						const link: RoomEdgeLinkRow = { roomId, edgeId, state: 'connected', since: time };

						this.#links.set(linkKey, link);
						linkChanges.push(link);
					}
				}
			}

			// ---- origin에 직접 붙은 viewer ----
			let viewerCount = 0;

			for (const t of raw.transports) {
				if (t.type === 'webrtc' && t.direction === 'consumer' && topology.roomOfTransport(t) === roomId) {
					viewerCount++;

					const entries = (topology.consumersByTransport.get(t.id) ?? []).flatMap(c =>
						rtpEntries(c.stats, 'outbound-rtp').map(s => ({ key: `ov:${c.id}:${s.ssrc ?? 0}`, s }))
					);
					const expected = entries.length ? sumStrict(entries.map(e => this.delta.delta(`${e.key}:pc`, e.s.packetCount))) : null;
					const lost = entries.length ? sumStrict(entries.map(e => this.delta.delta(`${e.key}:pl`, e.s.packetsLost))) : null;

					viewerLive.push({ viewerId: t.id, roomId, lossRatio: expected && lost !== null ? lost / expected : null });
				}
			}

			roomSamples.push({ time, roomId, viewerCount, outPipeBitrateBps: outPipeBitrate });
		}

		for (const [key, b] of this.#broadcasters) {
			if (!seenBroadcasters.has(key)) {
				updates.push({ broadcasterId: b.broadcasterId, state: 'disconnected', disconnectedAt: time });
				this.#broadcasters.delete(key);
			}
		}

		for (const [key, link] of this.#links) {
			if (!currentLinks.has(key)) {
				linkChanges.push({ ...link, state: 'closed', since: time });
				this.#links.delete(key);
			}
		}

		const batch: OriginBatch = {
			mode: 'origin',
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
			broadcasterSamples: samples,
			broadcasterSessionStarts: starts,
			broadcasterSessionUpdates: updates,
			roomSamples,
			pipeSendSamples: pipeSends,
			roomEdgeLinks: linkChanges,
			viewerLive,
		};

		this.delta.sweep();

		return batch;
	}
}
