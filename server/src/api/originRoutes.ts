import type { AlertEvaluator } from '../alerts/evaluator.js';
import { BAD_VIEWER_LOSS, percentile } from '../alerts/metrics.js';
import { EXTERNAL_PEER_ID, Topology, clientIpOf, jitterMs, rtpEntries, rttOf, round2 } from '../collector/topology.js';
import type { OriginBatch } from '../db/rows.js';
import type { BroadcasterRecord, OriginStore } from '../db/store.js';
import type { RawProducer, RawSnapshot } from '../hookProtocol.js';
import { HttpError, type HttpServer } from '../http/server.js';
import type { OriginLivenessMonitor } from '../liveness/originMonitor.js';
import { mockBroadcasterReport } from '../mock/index.js';
import type { ApiContext } from './common.js';
import { parseRange, perMinute, respond, sessionRange } from './common.js';
import { diagnoseBroadcaster } from './diagnose.js';
import { OVERVIEW_ROWS, alertSummary, byLevel, firingLevel, firingStates, valueLevel, worst, type OverviewLevel } from './overview.js';
import { egressLive, excludedWorkers, layerName, streamSpatialLayer, streamsLive, workersLive, type WorkerTracker } from './live.js';

/**
 * origin 대시보드 API (AGENT_TASK 6.2). edge의 상세 데이터는 다루지 않는다 (edge 대시보드로 링크).
 */
export function registerOriginRoutes(
	http: HttpServer,
	ctx: ApiContext & {
		store: OriginStore;
		evaluator: AlertEvaluator;
		tracker: WorkerTracker;
		monitor: OriginLivenessMonitor;
		nicCapacityBps: number;
	}
): void {
	const { store, collector, monitor, evaluator } = ctx;
	const latest = (): OriginBatch | null => (collector.latest?.mode === 'origin' ? collector.latest : null);
	const requireLive = () => {
		const batch = latest();
		const raw = collector.raw.current;

		if (!batch || !raw) {
			throw new Error('수집된 데이터가 아직 없습니다');
		}

		return { batch, raw, prev: collector.raw.previous };
	};
	const warn = (ruleId: string, fallback: number) => evaluator.rules.find(r => r.ruleId === ruleId)?.warnAbove ?? fallback;
	const crit = (ruleId: string, fallback: number) => evaluator.rules.find(r => r.ruleId === ruleId)?.critAbove ?? fallback;
	const viewerP50 = (batch: OriginBatch | null, roomId?: string) => {
		const l = (batch?.viewerLive ?? []).filter(v => (!roomId || v.roomId === roomId) && v.lossRatio !== null).map(v => v.lossRatio!);

		return { p50: l.length ? percentile(l, 0.5) : null, bad: l.filter(x => x >= BAD_VIEWER_LOSS).length, viewers: l.length, losses: l };
	};

	// ---------------- Overview (handoff/HANDOFF.md: 상태 배너 → 연결 흐름 → 카드 3개 → 방송 + 알림) ----------------
	http.route('GET', '/api/origin/overview', async () => {
		// 패널들이 같은 판정을 쓰도록 한 번만 계산한다.
		const shared = async () => {
			const { batch, raw, prev } = requireLive();
			const firing = firingStates(evaluator);
			const records = await store.getBroadcasters();
			const sampleOf = new Map(batch.broadcasterSamples.map(s => [s.broadcasterId, s]));
			const broadcasters = records.map(b => {
				const s = sampleOf.get(b.broadcasterId);
				const loss = s?.packetsExpected && s.packetsLost !== null ? s.packetsLost / s.packetsExpected : null;
				const level = b.state === 'sending' ? worst(firingLevel(firing, 'broadcaster', b.broadcasterId), valueLevel(evaluator, 'broadcaster_loss', loss)) : 'ok';

				return { ...b, loss, rttMs: s?.rttMs ?? null, inBps: b.state === 'sending' ? (s?.bitrateBps ?? null) : null, level };
			});
			const viewers = batch.viewerLive;
			const edges = monitor.statuses();
			const workers = workersLive(raw, prev, ctx.tracker);

			return { batch, raw, firing, broadcasters, viewers, edges, workers };
		};
		let cache: ReturnType<typeof shared> | null = null;
		const get = () => (cache ??= shared());

		return respond(ctx, {
			status: async () => {
				const { broadcasters, edges } = await get();
				const alerts = await alertSummary(evaluator, store);
				const sending = broadcasters.filter(b => b.state === 'sending');
				const ingestLevel = worst(...sending.map(b => b.level));

				const lostEdges = edges.filter(e => e.state === 'lost').length;

				return {
					// 수집이 실패하면 값이 멈춰 있으므로 알림이 없어도 "주의"로 보인다.
					// 신호를 한 번도 안 보낸 edge는 edge_signal_age 값이 없어 알림이 울리지 않으므로, 끊긴 edge도 "주의"로 올린다.
					level: worst(alerts.level, collector.status.ok ? 'ok' : 'warn', lostEdges > 0 ? 'warn' : 'ok'),
					collectorOk: collector.status.ok,
					alerts,
					ingest: sending.length === 0 ? 'idle' : ingestLevel,
					ingestProblems: sending.filter(b => b.level !== 'ok').length,
					edges: { total: edges.length, connected: edges.length - lostEdges, lost: lostEdges },
				};
			},
			flow: async () => {
				const { batch, raw, broadcasters, viewers, edges } = await get();
				const sending = broadcasters.filter(b => b.state === 'sending');
				const egress = egressLive(raw);
				const pipeByEdge = new Map<string, number>();
				const unmatched = { bps: 0, ips: new Set<string>() };

				for (const s of batch.pipeSendSamples) {
					if (s.edgeId) {
						pipeByEdge.set(s.edgeId, (pipeByEdge.get(s.edgeId) ?? 0) + (s.bitrateBps ?? 0));
					} else {
						unmatched.bps += s.bitrateBps ?? 0;
						unmatched.ips.add(s.remoteIp);
					}
				}

				const viewerProblems = viewers.filter(v => v.lossRatio !== null && v.lossRatio >= BAD_VIEWER_LOSS).length;
				const maxOf = (list: Array<number | null>) => list.reduce<number | null>((a, v) => (v === null ? a : Math.max(a ?? 0, v)), null);
				const edgeLevel = (state: string): OverviewLevel => (state === 'lost' ? 'crit' : state === 'warning' ? 'warn' : 'ok');

				return {
					broadcasters: {
						sending: sending.length,
						idle: broadcasters.length - sending.length,
						problems: sending.filter(b => b.level !== 'ok').length,
						level: worst(...sending.map(b => b.level)),
						// 평균이 아니라 최악값: 한 명의 문제가 묻히지 않게
						maxLossRatio: maxOf(sending.map(b => b.loss)),
						maxRttMs: maxOf(sending.map(b => b.rttMs)),
						inBps: sending.length ? sending.reduce((a, b) => a + (b.inBps ?? 0), 0) : null,
					},
					viewers: { count: viewers.length, problems: viewerProblems, level: viewerProblems > 0 ? ('warn' as const) : ('ok' as const), bps: egress.viewerBps },
					origin: { serverId: ctx.config.serverId, egressBps: egress.totalBps, capacityBps: ctx.nicCapacityBps },
					edges: [...edges]
						.sort((a, b) => a.edgeId.localeCompare(b.edgeId))
						.sort(byLevel(e => edgeLevel(e.state)))
						.map(e => ({
							edgeId: e.edgeId,
							dashboardUrl: e.dashboardUrl,
							state: e.state,
							level: edgeLevel(e.state),
							reason: e.reason,
							ageSeconds: e.ageSeconds,
							recvLossRatio: e.recvLossRatio,
							pipeBps: pipeByEdge.get(e.edgeId) ?? null,
						})),
					// heartbeat IP와 맞지 않아 edge를 모르는 pipe (보통 edge의 MSDASH_PIPE_IP가 실제 pipe 주소와 다를 때)
					unmatchedPipe: unmatched.ips.size ? { bps: unmatched.bps, ips: [...unmatched.ips] } : null,
				};
			},
			kpi: async () => {
				const { edges, workers } = await get();
				const rooms = await store.getOriginRoomSummary();
				const sendingRooms = rooms.filter(r => r.sendingBroadcasters > 0).length;
				const running = workers.filter(w => w.status === 'running').length;

				return {
					rooms: { total: rooms.length, sending: sendingRooms, idle: rooms.length - sendingRooms },
					edges: { total: edges.length, connected: edges.filter(e => e.state !== 'lost').length, lost: edges.filter(e => e.state === 'lost').length },
					workers: { total: workers.length, running, problems: workers.length - running },
				};
			},
			rooms: async () => {
				const { broadcasters } = await get();
				const rooms = await store.getOriginRoomSummary();
				const list = rooms
					.map(r => {
						const inRoom = broadcasters.filter(b => b.roomId === r.roomId && b.state === 'sending');
						const level: OverviewLevel | 'idle' =
							r.sendingBroadcasters === 0 ? 'idle' : worst(...inRoom.map(b => b.level), valueLevel(evaluator, 'broadcaster_loss', r.ingestLossRatio));

						return { roomId: r.roomId, level, broadcasters: r.broadcasters, viewerCount: r.viewerCount, bitrateBps: r.inBitrateBps };
					})
					.sort((a, b) => a.roomId.localeCompare(b.roomId))
					.sort(byLevel(r => r.level));

				return { items: list.slice(0, OVERVIEW_ROWS), more: Math.max(0, list.length - OVERVIEW_ROWS) };
			},
		});
	});

	// ---------------- Rooms & Broadcasters ----------------
	http.route('GET', '/api/origin/rooms', async () =>
		respond(ctx, {
			rooms: async () => {
				const lossWarn = warn('broadcaster_loss', 0.02);

				return (await store.getOriginRoomSummary()).map(r => ({
					...r,
					ingest: r.sendingBroadcasters === 0 ? 'idle' : r.ingestLossRatio !== null && r.ingestLossRatio >= lossWarn ? 'loss' : 'ok',
				}));
			},
		})
	);

	http.route('GET', '/api/origin/rooms/:roomId', async req => {
		const roomId = req.params.roomId!;
		const range = parseRange(req.query.get('range'));

		return respond(ctx, {
			header: async () => {
				const summary = (await store.getOriginRoomSummary()).find(r => r.roomId === roomId);
				const room = collector.raw.current?.rooms.find(r => r.roomId === roomId);

				if (!summary && !room) {
					return { ok: false as const, error: `방송 ${roomId}이(가) 없습니다`, reason: 'not_found' as const };
				}

				return { roomId, createdAt: room?.createdAt ?? null, viewerCount: summary?.viewerCount ?? 0, edgeCount: summary?.edgeCount ?? 0 };
			},
			broadcasters: async () => {
				const list = await store.getBroadcasters(roomId);
				const raw = collector.raw.current;

				return {
					ok: true as const,
					data: list.map(b => ({
						...b,
						live: raw ? broadcasterLive(raw, collector.raw.previous, b) : null,
						report: ctx.config.mockEnabled ? mockBroadcasterReport(b.broadcasterId, Date.now(), b.state === 'sending') : null,
					})),
					mock: ['broadcaster_sample.fps', 'broadcaster_report.*'],
				};
			},
			bitrateSeries: async () => (await store.getRoomBitrateSeries(roomId, range, range.bucketSeconds)).map(p => ({ t: p.bucket, inBitrateBps: p.inBitrateBps, outPipeBitrateBps: p.outPipeBitrateBps })),
			edges: async () => {
				const statuses = monitor.statuses();

				return (await store.getRoomEdgeMatrix())
					.filter(c => c.roomId === roomId)
					.map(c => {
						const s = statuses.find(x => x.edgeId === c.edgeId);

						return { ...c, dashboardUrl: s?.dashboardUrl ?? null, edgeState: s?.state ?? null, edgeReason: s?.reason ?? null };
					});
			},
			viewers: () => {
				const v = viewerP50(latest(), roomId);

				return { viewers: latest()?.roomSamples.find(r => r.roomId === roomId)?.viewerCount ?? 0, lossP50: v.p50, badRatio: v.viewers ? v.bad / v.viewers : null };
			},
		});
	});

	http.route('GET', '/api/origin/broadcasters/:broadcasterId', async req => {
		const id = req.params.broadcasterId!;
		const b = await store.getBroadcaster(id);

		if (!b) {
			throw new HttpError(404, `broadcaster ${id}을(를) 찾을 수 없습니다`);
		}

		const rangeKey = req.query.get('range') ?? '5m';
		const range = rangeKey === 'session' ? sessionRange(b.connectedAt) : parseRange(rangeKey);
		const seriesP = store.getBroadcasterSeries(id, range, range.bucketSeconds);
		const raw = collector.raw.current;
		const live = raw ? broadcasterLive(raw, collector.raw.previous, b) : null;
		const report = ctx.config.mockEnabled ? mockBroadcasterReport(id, Date.now(), b.state === 'sending') : null;

		return respond(ctx, {
			session: () => ({ ...b, live }),
			series: async () => ({
				ok: true as const,
				data: {
					bucketSeconds: range.bucketSeconds,
					points: (await seriesP).map(p => ({
						t: p.bucket,
						bitrateBps: p.bitrateBps,
						lossRatio: p.lossRatio,
						recoveredLossRatio: p.recoveredLossRatio,
						rttMs: p.rttMs,
						jitterMs: p.jitterMs,
						fps: p.fps,
						layersActive: p.layersActive,
					})),
				},
				// fps만 mock이다. 화면이 fps 차트에만 배지를 붙인다 (MOCK_FIELDS).
			}),
			timeline: async () =>
				(await seriesP).map(p => ({
					t: p.bucket,
					sending: (p.bitrateBps ?? 0) > 0,
					layersActive: p.layersActive,
					maxLayers: live?.layers.length ?? null,
				})),
			events: async () => {
				const s = await seriesP;
				const out: Array<{ t: Date; level: 'info' | 'warn'; text: string }> = [{ t: b.connectedAt, level: 'info', text: '접속 및 송출 시작' }];

				s.forEach((p, i) => {
					const before = s[i - 1];

					if (before && before.layersActive !== null && p.layersActive !== null && before.layersActive !== p.layersActive) {
						out.push({
							t: p.bucket,
							level: p.layersActive < before.layersActive ? 'warn' : 'info',
							text: p.layersActive < before.layersActive ? `활성 레이어 ${before.layersActive} → ${p.layersActive} (레이어 중단)` : `레이어 복구 (${p.layersActive})`,
						});
					}

					if ((p.pliCount ?? 0) >= 3) {
						out.push({ t: p.bucket, level: 'info', text: `keyframe 요청(PLI) ${p.pliCount}회 수신` });
					}
				});

				if (b.disconnectedAt) {
					out.push({ t: b.disconnectedAt, level: 'warn', text: '접속 종료' });
				}

				return out.sort((x, y) => y.t.getTime() - x.t.getTime()).slice(0, 30);
			},
			diagnosis: async () => {
				const s = (await seriesP).slice(-6);
				const lost = s.reduce((a, p) => a + (p.packetsLost ?? 0), 0);
				const expected = s.reduce((a, p) => a + (p.packetsExpected ?? 0), 0);
				const edgeWarn = warn('pipe_send_loss', 0.02);
				const edges = (await store.getRoomEdgeMatrix()).filter(c => c.roomId === b.roomId && c.lossRatio !== null && c.lossRatio >= edgeWarn);
				const inputLoss = expected ? lost / expected : null;

				return diagnoseBroadcaster({
					lossRatio: inputLoss,
					rttMs: s.at(-1)?.rttMs ?? null,
					fps: s.at(-1)?.fps ?? null,
					layersActive: live?.layers.filter(l => (l.bitrateBps ?? 0) > 0).length ?? null,
					maxLayers: live?.layers.length ?? null,
					qualityLimitation: report?.qualityLimitationReason ?? null,
					edgesWithLoss: inputLoss !== null && inputLoss < warn('broadcaster_loss', 0.02) ? edges.map(e => ({ edgeId: e.edgeId, lossRatio: e.lossRatio! })) : [],
					lossWarn: warn('broadcaster_loss', 0.02),
				});
			},
			serverValues: async () => {
				const s = await seriesP;
				const recent = s.slice(-6);
				const seconds = recent.length * range.bucketSeconds;
				const lost = recent.reduce((a, p) => a + (p.packetsLost ?? 0), 0);
				const expected = recent.reduce((a, p) => a + (p.packetsExpected ?? 0), 0);

				return {
					lossRatio: expected ? lost / expected : null,
					layers: live?.layers ?? [],
					jitterMs: recent.at(-1)?.jitterMs ?? null,
					nackPerMin: perMinute(recent.reduce((a, p) => a + (p.nackCount ?? 0), 0), seconds),
					pliPerMin: perMinute(recent.reduce((a, p) => a + (p.pliCount ?? 0), 0), seconds),
					transport: live?.transport ?? null,
				};
			},
			clientReport: () => (report ? { ok: true as const, data: report, mock: ['broadcaster_report.*'] } : { ok: true as const, data: null }),
			delivery: async () => {
				const cells = (await store.getRoomEdgeMatrix()).filter(c => c.roomId === b.roomId && c.linkState === 'connected');

				return {
					viewers: latest()?.roomSamples.find(r => r.roomId === b.roomId)?.viewerCount ?? null,
					edges: cells.length,
					sendBitrateBps: cells.map(c => c.bitrateBps),
				};
			},
		});
	});

	// 2초 갱신: broadcaster의 transport만 훅에 묻는다.
	http.route('GET', '/api/origin/broadcasters/:broadcasterId/live', async req => {
		const id = req.params.broadcasterId!;

		return respond(ctx, {
			live: async () => {
				const raw = collector.raw.current;
				const b = await store.getBroadcaster(id);

				if (!raw || !b) {
					return { ok: false as const, error: 'broadcaster를 찾을 수 없습니다', reason: 'not_found' as const };
				}

				const transportIds = [...new Set(producersOf(raw, b).map(p => p.transportId))];

				if (transportIds.length === 0) {
					return { ok: false as const, error: '송출 중인 producer가 없습니다', reason: 'not_found' as const };
				}

				const details = await Promise.all(transportIds.map(t => collector.transportDetail(t)));
				const producers = details.flatMap(d => (d.found ? d.producers : []));
				const video = producers.filter(p => p.kind === 'video').flatMap(p => rtpEntries(p.stats, 'inbound-rtp'));

				return {
					ok: true as const,
					data: {
						time: new Date(details[0]?.time ?? Date.now()),
						transports: details.map(d => (d.found ? { id: d.transport.id, iceState: d.transport.iceState, dtlsState: d.transport.dtlsState } : null)),
						bitrateBps: Math.round(producers.flatMap(p => rtpEntries(p.stats, 'inbound-rtp')).reduce((a, s) => a + (s.bitrate ?? 0), 0)),
						layers: video.map((s, i) => ({ layer: layerName(streamSpatialLayer(s, i, video.length)), bitrateBps: Math.round(s.bitrate ?? 0) })),
						rttMs: rttOf(video),
						jitterMs: video[0] ? jitterMs(video[0]) : null,
						fps: ctx.config.mockEnabled ? mockBroadcasterReport(id, Date.now(), b.state === 'sending').framesPerSecond : null,
					},
					mock: ['broadcaster_sample.fps'],
				};
			},
		});
	});

	// ---------------- Connected Edges ----------------
	http.route('GET', '/api/origin/edges', async () =>
		respond(ctx, {
			summary: async () => {
				const statuses = monitor.statuses();
				const cells = await store.getRoomEdgeMatrix();

				return {
					registered: statuses.length,
					connected: statuses.filter(s => s.state !== 'lost').length,
					lost: statuses.filter(s => s.state === 'lost').length,
					recvLossWarning: statuses.filter(s => s.state === 'warning').length,
					totalPipeSendBps: Math.round(cells.reduce((a, c) => a + (c.bitrateBps ?? 0), 0)),
				};
			},
			edges: async () => {
				const [statuses, cells, records] = await Promise.all([monitor.statuses(), store.getRoomEdgeMatrix(), store.getEdges()]);
				const order = { lost: 0, warning: 1, connected: 2 };

				return statuses
					.map(s => {
						const mine = cells.filter(c => c.edgeId === s.edgeId);

						return {
							...s,
							rooms: mine.filter(c => c.linkState === 'connected').length,
							sendBitrateBps: mine.length ? Math.round(mine.reduce((a, c) => a + (c.bitrateBps ?? 0), 0)) : null,
							firstSeenAt: records.find(r => r.edgeId === s.edgeId)?.firstSeenAt ?? null,
						};
					})
					.sort((a, b) => order[a.state] - order[b.state] || a.edgeId.localeCompare(b.edgeId));
			},
			matrix: async () => {
				const statuses = monitor.statuses();
				const cells = await store.getRoomEdgeMatrix();
				const rooms = [...new Set(cells.map(c => c.roomId))].sort();
				const edges = statuses.map(s => s.edgeId);

				return {
					rooms,
					edges,
					cells: cells.map(c => ({
						roomId: c.roomId,
						edgeId: c.edgeId,
						// 전달 중 / 끊김(edge 신호 끊김이거나 link가 닫힘) / 없음(행이 없음)
						state: c.linkState === 'connected' && statuses.find(s => s.edgeId === c.edgeId)?.state !== 'lost' ? 'delivering' : 'broken',
					})),
				};
			},
		})
	);
}

/** broadcaster 키(roomId/peerId)에 해당하는 producer들 */
function producersOf(raw: RawSnapshot, b: BroadcasterRecord): RawProducer[] {
	const topo = new Topology(raw);
	const routerId = topo.producerRouterOfRoom.get(b.roomId);
	const key = b.broadcasterId.replace(/@\d+$/, '');

	return raw.producers.filter(p => {
		const t = topo.transports.get(p.transportId);

		if (!t || !routerId) {
			return false;
		}

		return (
			t.routerId === routerId &&
			(t.type === 'webrtc' || t.type === 'plain') &&
			p.peerId !== EXTERNAL_PEER_ID &&
			`${b.roomId}/${p.peerId ?? t.id}` === key
		);
	});
}

function broadcasterLive(raw: RawSnapshot, prev: RawSnapshot | null, b: BroadcasterRecord) {
	const producers = producersOf(raw, b);
	const ids = new Set(producers.map(p => `${p.id}@${p.transportId}`));
	const streams = streamsLive(raw, prev, p => ids.has(`${p.id}@${p.transportId}`));
	const topo = new Topology(raw);
	const t = producers[0] ? topo.transports.get(producers[0].transportId) : undefined;
	const device = topo.peerOf(b.roomId, producers[0]?.peerId ?? null)?.device;

	return {
		kinds: [...new Set(producers.map(p => p.kind))],
		layers: streams.filter(s => s.kind === 'video'),
		audio: streams.find(s => s.kind === 'audio') ?? null,
		rttMs: rttOf(producers.flatMap(p => rtpEntries(p.stats, 'inbound-rtp'))),
		transport: t ? { type: t.type, iceState: t.iceState, dtlsState: t.dtlsState } : null,
		// 실제 값: 브라우저는 room peer 정보(device.name·version), IP는 transport의 ICE 선택 경로(Plain은 tuple).
		browser: device?.name ? `${device.name}${device.version ? ` ${device.version}` : ''}` : null,
		remoteIp: t ? clientIpOf(t) : null,
	};
}
