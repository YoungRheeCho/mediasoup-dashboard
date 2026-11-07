import type { AlertEvaluator } from '../alerts/evaluator.js';
import { BAD_VIEWER_LOSS, percentile } from '../alerts/metrics.js';
import { Topology, clientIpOf, jitterMs, rtpEntries, rttOf, round2 } from '../collector/topology.js';
import { freshClientStats, hasClientStats, playbackStateOf, resolutionOf } from '../collector/clientStats.js';
import type { EdgeBatch } from '../db/rows.js';
import type { EdgeStore, PipeSeriesPoint, ViewerListItem } from '../db/store.js';
import type { RawClientStats, RawConsumer } from '../hookProtocol.js';
import { HttpError, type HttpServer } from '../http/server.js';
import { mockClientReport, mockViewerIdentity, mockViewerPlayback } from '../mock/index.js';
import type { ApiContext } from './common.js';
import { notImplemented, num, parseRange, perMinute, respond, sessionRange } from './common.js';
import { adviseWorkers, diagnoseViewer } from './diagnose.js';
import { OVERVIEW_ROWS, alertSummary, byLevel, firingLevel, firingStates, valueLevel, worst, type OverviewLevel } from './overview.js';
import { egressLive, excludedWorkers, layerMix, layerName, streamsLive, workersLive, type WorkerTracker } from './live.js';

/**
 * edge 대시보드 API (AGENT_TASK 6.1). 화면 하나에 엔드포인트 하나, 응답 안은 패널별 결과.
 */
export function registerEdgeRoutes(
	http: HttpServer,
	ctx: ApiContext & { store: EdgeStore; evaluator: AlertEvaluator; tracker: WorkerTracker; nicCapacityBps: number }
): void {
	const { store, collector, evaluator } = ctx;
	const latest = (): EdgeBatch | null => (collector.latest?.mode === 'edge' ? collector.latest : null);
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

	// ---------------- Overview (handoff/HANDOFF.md: 상태 배너 → 연결 흐름 → 카드 2개 → 중계 중인 방송 + 참고) ----------------
	http.route('GET', '/api/edge/overview', async req => {
		const range = parseRange(req.query.get('range'));
		// 패널들이 같은 판정을 쓰도록 한 번만 계산한다.
		const shared = async () => {
			const { batch, raw, prev } = requireLive();
			const firing = firingStates(evaluator);
			const pipe = sumPipe(batch);
			const receiving = (pipe.bitrateBps ?? 0) > 0;
			const pipeLevel = receiving ? worst(...firing.filter(s => s.ruleId === 'pipe_loss').map(s => s.status as OverviewLevel), valueLevel(evaluator, 'pipe_loss', pipe.lossRatio)) : null;
			const losses = viewerLossList(batch);
			const workers = workersLive(raw, prev, ctx.tracker);
			const alerts = await alertSummary(evaluator, store);

			return { batch, raw, firing, pipe, pipeLevel, losses, workers, alerts };
		};
		let cache: ReturnType<typeof shared> | null = null;
		const get = () => (cache ??= shared());

		return respond(ctx, {
			status: async () => {
				const { pipe, pipeLevel, alerts } = await get();

				return {
					// 수집이 실패하면 값이 멈춰 있으므로 알림이 없어도 "주의"로 보인다.
					level: worst(alerts.level, collector.status.ok ? 'ok' : 'warn'),
					collectorOk: collector.status.ok,
					alerts,
					pipe: { level: pipeLevel, bps: pipe.bitrateBps },
				};
			},
			flow: async () => {
				const { batch, raw, pipe, pipeLevel, losses, workers } = await get();
				const egress = egressLive(raw);
				const problems = losses.filter(l => l >= BAD_VIEWER_LOSS).length;

				return {
					origin: { url: ctx.config.liveness.originUrl },
					pipe: { level: pipeLevel, bps: pipe.bitrateBps, lossRatio: pipe.lossRatio, rttMs: pipe.rttMs },
					edge: {
						serverId: ctx.config.serverId,
						workers: { total: workers.length, running: workers.filter(w => w.status === 'running').length },
						rooms: batch.rooms.length,
						egressBps: egress.totalBps,
						capacityBps: ctx.nicCapacityBps,
					},
					viewers: { count: batch.viewerSamples.length, problems, level: problems > 0 ? ('warn' as const) : ('ok' as const), bps: egress.viewerBps },
				};
			},
			kpi: async () => {
				const { firing, workers } = await get();
				// 카드는 선택한 구간(5m/1h/6h) 전체의 pipe 수신 loss. 등급은 알림 규칙 판정을 따른다.
				const series = await store.getPipeSeries(range, range.bucketSeconds);
				const lossRatio = ratioSum(series.map(p => [p.packetsLost, p.packetsExpected]));
				const running = workers.filter(w => w.status === 'running').length;

				return {
					pipe: { lossRatio, level: worst(...firing.filter(s => s.ruleId === 'pipe_loss').map(s => s.status as OverviewLevel)) },
					workers: { total: workers.length, running, problems: workers.length - running },
				};
			},
			rooms: async () => {
				const { batch, firing } = await get();
				const list = (await store.getRoomSummary())
					.map(r => {
						const p = sumPipe(batch, r.roomId);
						const receiving = (p.bitrateBps ?? 0) > 0;
						const level: OverviewLevel | 'idle' = receiving
							? worst(firingLevel(firing, 'pipe', r.roomId), firingLevel(firing, 'room', r.roomId), valueLevel(evaluator, 'pipe_loss', p.lossRatio))
							: 'idle';

						return { roomId: r.roomId, level, viewerCount: r.viewerCount, bitrateBps: receiving ? p.bitrateBps : null, lossRatio: receiving ? p.lossRatio : null };
					})
					.sort((a, b) => a.roomId.localeCompare(b.roomId))
					.sort(byLevel(r => r.level));

				return { items: list.slice(0, OVERVIEW_ROWS), more: Math.max(0, list.length - OVERVIEW_ROWS) };
			},
			// 하단 "참고": 알림까지는 아니지만 알아 둘 안정성 신호
			notes: async () => {
				const { workers, alerts } = await get();
				const items = [
					...workers
						.filter(w => w.restarts > 0)
						.map(w => ({ level: 'warn' as const, kind: 'restart' as const, workerIdx: w.workerIdx, restarts: w.restarts, lastRestartAt: w.lastRestartAt })),
					...workers.filter(w => w.status === 'no_response').map(w => ({ level: 'warn' as const, kind: 'no_response' as const, workerIdx: w.workerIdx })),
				];

				return { items, alerts: alerts.total, events24h: alerts.last24h };
			},
		});
	});

	// ---------------- Workers ----------------
	http.route('GET', '/api/edge/workers', async req => {
		const range = parseRange(req.query.get('range'));

		return respond(ctx, {
			workers: async () => {
				const { raw, prev } = requireLive();
				const live = workersLive(raw, prev, ctx.tracker);
				const series = await store.getWorkerSeries(range, range.bucketSeconds);

				return {
					ok: true as const,
					data: live.map(w => ({
						...w,
						routers: undefined,
						series: series.filter(s => s.workerIdx === w.workerIdx).map(s => ({ t: s.bucket, cpuPct: s.cpuPct })),
					})),
					excluded: excludedWorkers(raw).map(i => `w${i}`),
				};
			},
			placement: () => {
				const { raw, prev } = requireLive();

				return workersLive(raw, prev, ctx.tracker).map(w => ({
					workerIdx: w.workerIdx,
					cpuPct: w.cpuPct,
					routers: w.routers.filter(r => r.roomId),
				}));
			},
			advice: () => {
				const { raw, prev } = requireLive();

				return adviseWorkers(workersLive(raw, prev, ctx.tracker));
			},
			resources: () => {
				const { raw, prev } = requireLive();

				return workersLive(raw, prev, ctx.tracker).map(w => ({
					workerIdx: w.workerIdx,
					cpuUserPct: w.cpuUserPct,
					cpuSysPct: w.cpuSysPct,
					maxRssBytes: w.maxRssBytes,
					contextSwitchesPerSec: w.contextSwitchesPerSec,
					restarts: w.restarts,
					lastRestartAt: w.lastRestartAt,
				}));
			},
		});
	});

	// ---------------- Broadcasts ----------------
	http.route('GET', '/api/edge/broadcasts', async () =>
		respond(ctx, {
			rooms: async () => roomsTable(await store.getRoomSummary(), latest()),
		})
	);

	http.route('GET', '/api/edge/broadcasts/:roomId', async req => {
		const roomId = req.params.roomId!;
		const range = parseRange(req.query.get('range'), '1h');

		return respond(ctx, {
			header: async () => {
				const summary = (await store.getRoomSummary()).find(r => r.roomId === roomId);
				const raw = collector.raw.current;
				const room = raw?.rooms.find(r => r.roomId === roomId);

				if (!summary && !room) {
					return { ok: false as const, error: `방송 ${roomId}이(가) 이 서버에 없습니다`, reason: 'not_found' as const };
				}

				return {
					roomId,
					workers: summary?.workers ?? [],
					createdAt: room?.createdAt ?? null,
					viewerCount: summary?.viewerCount ?? 0,
					viewerLossP50: summary?.viewerLossP50 ?? null,
				};
			},
			flow: () => {
				const { batch, raw, prev } = requireLive();
				const workers = workersLive(raw, prev, ctx.tracker);
				const pipe = sumPipe(batch, roomId);
				const viewers = batch.viewerSamples.filter(v => v.roomId === roomId);
				const routers = workers.flatMap(w => w.routers.filter(r => r.roomId === roomId).map(r => ({ ...r, workerIdx: w.workerIdx, cpuPct: w.cpuPct })));
				const perWorker = new Map<number, number>();

				for (const v of viewers) {
					perWorker.set(v.workerIdx ?? -1, (perWorker.get(v.workerIdx ?? -1) ?? 0) + 1);
				}

				const losses = viewers.filter(v => v.packetsExpected).map(v => v.packetsLost! / v.packetsExpected!);

				return {
					pipe: { bitrateBps: pipe.bitrateBps, lossRatio: pipe.lossRatio, rttMs: pipe.rttMs, producerCount: batch.pipeSamples.filter(p => p.roomId === roomId).length },
					routers: routers.map(r => ({ routerId: r.routerId, workerIdx: r.workerIdx, cpuPct: r.cpuPct, inBitrateBps: pipe.bitrateBps, consumerCount: r.consumerCount, viewerCount: r.viewerCount })),
					viewers: {
						total: viewers.length,
						perWorker: [...perWorker].map(([workerIdx, count]) => ({ workerIdx, count })),
						consumers: routers.reduce((a, r) => a + r.consumerCount, 0),
						badCount: losses.filter(l => l >= BAD_VIEWER_LOSS).length,
					},
					finding:
						pipe.lossRatio !== null && pipe.lossRatio >= warn('pipe_loss', 0.02)
							? { level: 'warn', title: 'pipe 구간에서 이미 손실', detail: '① 구간(pipe 수신)에서 손실이 발생해 ③ viewer 품질 저하의 원인일 가능성이 높습니다.' }
							: null,
				};
			},
			producers: () => {
				const { raw, prev } = requireLive();
				const room = raw.rooms.find(r => r.roomId === roomId);

				return streamsLive(
					raw,
					prev,
					(p, topo) => {
						const t = topo.transports.get(p.transportId);

						return !!room && t?.routerId === room.producerRouterId && t.type === 'pipe';
					},
					true
				);
			},
			viewerSeries: async () => (await store.getRoomViewerSeries(roomId, range, range.bucketSeconds)).map(p => ({ t: p.bucket, viewers: p.viewerCount })),
			layers: async () => {
				const batch = requireLive().batch;

				return {
					mix: layerMix(batch.viewerSamples.filter(v => v.roomId === roomId)),
					switchesPerMinute: await store.getLayerSwitchesPerMinute(roomId, 60),
					switchesPerMinuteBaseline: await store.getLayerSwitchesPerMinute(roomId, 3600),
				};
			},
		});
	});

	// ---------------- Pipe 수신 ----------------
	http.route('GET', '/api/edge/pipe', async req => {
		const range = parseRange(req.query.get('range'));

		return respond(ctx, {
			status: () => {
				const { raw } = requireLive();
				const topo = new Topology(raw);
				// origin에서 들어오는 pipe = 방송 producer router 위에서 producer를 받는 PipeTransport.
				// 같은 router의 shard용 로컬 pipe(pipeToRouter)는 consumer만 가지므로 빠진다.
				const producerRouters = new Set(topo.producerRouterOfRoom.values());
				const pipes = raw.transports.filter(
					t => t.type === 'pipe' && producerRouters.has(t.routerId) && (topo.producersByTransport.get(t.id)?.length ?? 0) > 0
				);

				return {
					state: pipes.length ? 'connected' : 'none',
					originUrl: ctx.config.liveness.originUrl,
					pipes: pipes.map(t => ({
						transportId: t.id,
						roomId: topo.roomByRouter.get(t.routerId) ?? null,
						local: t.tuple ? `${t.tuple.localIp}:${t.tuple.localPort}` : null,
						remote: t.tuple?.remoteIp ? `${t.tuple.remoteIp}:${t.tuple.remotePort}` : null,
					})),
					total: pipes.length,
				};
			},
			series: async () => {
				const points = aggregatePipe(await store.getPipeSeries(range, range.bucketSeconds));

				return {
					threshold: warn('pipe_loss', 0.02),
					points: points.map(p => ({
						t: p.bucket,
						lossRatio: p.lossRatio,
						recoveredLossRatio: p.recoveredLossRatio,
						rttMs: p.rttMs,
						jitterMs: p.jitterMs,
						bitrateBps: p.bitrateBps,
					})),
					lossDefinition: '최근 구간 sum(유실)/sum(와야 했던 패킷). 복구 후 = (유실 − RTX 복구)/와야 했던 패킷. broadcaster → origin 구간 유실 포함.',
				};
			},
			streams: () => {
				const { raw, prev } = requireLive();
				const topo = new Topology(raw);
				const producerRouters = new Set(topo.producerRouterOfRoom.values());

				return streamsLive(raw, prev, (p, t) => {
					const tr = t.transports.get(p.transportId);

					return !!tr && tr.type === 'pipe' && producerRouters.has(tr.routerId);
				}).map(s => ({ ...s, roomId: topo.roomByRouter.get(topo.transports.get(raw.producers.find(p => p.id === s.producerId)!.transportId)!.routerId) ?? null }));
			},
			originComparison: () =>
				notImplemented('edge는 자기 데이터만 갖습니다. origin 송신 값과의 비교는 미정(design/README.md, collection-design.md M10)이라 구현하지 않았습니다.'),
		});
	});

	// ---------------- Viewers ----------------
	http.route('GET', '/api/edge/viewers', async req => {
		const q = (req.query.get('q') ?? '').trim().toLowerCase();
		// 모바일 필터는 뺐다: 모바일/PC 구분(M4)은 user agent가 있어야 하는데 서버가 저장하지 않는다.
		const filter = req.query.get('filter') ?? 'all'; // all | loss5 | lowlayer | room
		const roomId = req.query.get('room') ?? undefined;
		const sort = req.query.get('sort') ?? 'loss';
		const limit = Math.min(num(req.query.get('limit')) ?? 100, 1000);

		return respond(ctx, {
			viewers: async () => {
				const all = await store.getViewerList({ sort, limit: 5000 });
				const counts = {
					all: all.length,
					loss5: all.filter(v => (v.lossRatio ?? 0) >= BAD_VIEWER_LOSS).length,
					lowLayer: all.filter(v => v.spatialLayer === 0).length,
					rooms: countBy(all, v => v.roomId),
				};
				const filtered = all.filter(
					v =>
						(!q || v.viewerId.toLowerCase().includes(q) || (v.displayName ?? '').toLowerCase().includes(q) || (v.peerId ?? '').toLowerCase().includes(q) || (v.remoteIp ?? '').includes(q)) &&
						(!roomId || v.roomId === roomId) &&
						(filter === 'all' ||
							(filter === 'loss5' && (v.lossRatio ?? 0) >= BAD_VIEWER_LOSS) ||
							(filter === 'lowlayer' && v.spatialLayer === 0) ||
							filter === 'room')
				);

				const items = filtered.slice(0, limit);

				return {
					ok: true as const,
					data: { counts, total: filtered.length, items: items.map(viewerRow) },
					mock: [
						...(viewerIdentityMock(items) ? ['viewer_session.display_name'] : []),
						...(clientMock(items) ? ['viewer_sample.client_freeze_count'] : []),
					],
				};
			},
		});
	});

	http.route('GET', '/api/edge/viewers/:viewerId', async req => {
		const viewerId = req.params.viewerId!;
		const session = await store.getViewerSession(viewerId);

		if (!session) {
			throw new HttpError(404, `viewer ${viewerId}을(를) 찾을 수 없습니다`);
		}

		const rangeKey = req.query.get('range') ?? '5m';
		const range = rangeKey === 'session' ? sessionRange(session.connectedAt) : parseRange(rangeKey);
		const seriesP = store.getViewerSeries(viewerId, range, range.bucketSeconds);

		return respond(ctx, {
			session: () => ({
				...viewerRow(session),
				disconnectedAt: session.disconnectedAt,
				disconnectReason: session.disconnectReason,
				environment: {
					...(ctx.config.mockEnabled ? playback(viewerId, session.freezeCount, null, session.spatialLayer) : {}),
					transportId: viewerId,
					// 실제 신원이면 브라우저는 peer 정보(device.name·version)에서. user agent는 서버가 저장하지 않아(M4) 비운다.
					...(session.identitySource === 'peer'
						? { browser: browserOf(session), userAgent: null }
						: ctx.config.mockEnabled
							? { userAgent: mockViewerIdentity(viewerId).userAgent }
							: {}),
				},
			}),
			series: async () => {
				const s = await seriesP;

				return {
					ok: true as const,
					data: {
						bucketSeconds: range.bucketSeconds,
						points: s.map(p => ({
							t: p.bucket,
							lossRatio: p.lossRatio,
							rttMs: p.rttMs,
							bitrateBps: p.bitrateBps,
							spatialLayer: p.spatialLayer,
							transportState: p.transportState,
							nackCount: p.nackCount,
							clientFps: p.clientFps,
							clientJitterBufferMs: p.clientJitterBufferMs,
							clientFreezeCount: p.clientFreezeCount,
						})),
						// client_*에 mock 구간이 섞였는지. loss·RTT·bitrate는 항상 실제 값이라 화면이 client 차트에만 배지를 붙인다.
						clientMock: s.some(p => !p.clientReported && p.clientFps !== null),
					},
				};
			},
			timeline: async () => {
				const s = await seriesP;

				return {
					ok: true as const,
					data: s.map(p => ({
						t: p.bucket,
						playback: p.clientReported || p.clientFps !== null ? playbackStateOf(p.clientFreezeCount, p.clientFps) : null,
						layer: layerName(p.spatialLayer),
						connection: p.transportState,
					})),
					mock: s.some(p => !p.clientReported && p.clientFps !== null) ? ['viewer_report.playback_state'] : [],
				};
			},
			events: async () => {
				const s = await seriesP;
				const out: Array<{ t: Date; level: 'info' | 'warn' | 'crit'; text: string; mock?: boolean }> = [];

				s.forEach((p, i) => {
					const before = s[i - 1];

					if (before && before.spatialLayer !== null && p.spatialLayer !== null && before.spatialLayer !== p.spatialLayer) {
						out.push({ t: p.bucket, level: 'info', text: `레이어 ${layerName(before.spatialLayer)} → ${layerName(p.spatialLayer)}` });
					}

					if (before && before.transportState !== p.transportState && p.transportState) {
						out.push({ t: p.bucket, level: p.transportState === 'connected' ? 'info' : 'warn', text: `연결 ${p.transportState}` });
					}

					if ((p.clientFreezeCount ?? 0) > 0) {
						out.push({ t: p.bucket, level: 'crit', text: `Freeze ${((p.clientFreezeMs ?? 0) / 1000).toFixed(1)}s`, mock: !p.clientReported });
					}
				});

				return out.reverse().slice(0, 30);
			},
			diagnosis: async () => {
				const s = await seriesP;
				const batch = latest();
				const recent = s.slice(-6);
				const lossRatio = ratioSum(recent.map(p => [p.packetsLost, p.packetsExpected]));
				const firstLayer = s.find(p => p.spatialLayer !== null)?.spatialLayer ?? null;
				const lastLayer = [...s].reverse().find(p => p.spatialLayer !== null)?.spatialLayer ?? null;
				const freeze = recent.reduce((a, p) => a + (p.clientFreezeCount ?? 0), 0);
				const freezeReal = recent.some(p => p.clientReported);

				return diagnoseViewer({
					lossRatio,
					rttMs: recent.at(-1)?.rttMs ?? null,
					spatialLayer: lastLayer,
					layerDropped: firstLayer !== null && lastLayer !== null && lastLayer < firstLayer,
					roomPipeLossRatio: batch ? sumPipe(batch, session.roomId).lossRatio : null,
					roomViewerLossP50: null,
					freezePerMin: freezeReal || ctx.config.mockEnabled ? perMinute(freeze, recent.length * range.bucketSeconds) : null,
					freezeMock: !freezeReal,
					lossWarn: warn('pipe_loss', 0.02),
				});
			},
		});
	});

	// 2초 갱신: 열린 상세 화면이 있을 때만 그 viewer의 transport 하나를 훅에 묻는다 (AGENT_TASK 4.3).
	const liveCache = new Map<string, { at: number; stats: Map<string, { packetCount: number; packetsLost: number; nackCount: number; pliCount: number }> }>();
	// 브라우저 보고(M2)는 5초마다 온다. 2초 갱신 사이에는 같은 보고가 반복되므로, 서로 다른 최근 보고 두 개의 차이로 구간 값을 만든다.
	const clientCache = new Map<string, { prev: RawClientStats | null; cur: RawClientStats }>();

	http.route('GET', '/api/edge/viewers/:viewerId/live', async req => {
		const viewerId = req.params.viewerId!;

		return respond(ctx, {
			live: async () => {
				const detail = await collector.transportDetail(viewerId);

				if (!detail.found) {
					return { ok: false as const, error: '접속이 끊겼거나 이 서버에 없는 viewer입니다', reason: 'not_found' as const };
				}

				const now = detail.time;
				const prev = liveCache.get(viewerId);
				const dt = prev ? (now - prev.at) / 1000 : 0;
				const next = new Map<string, { packetCount: number; packetsLost: number; nackCount: number; pliCount: number }>();
				const kinds = (['video', 'audio'] as const).map(kind => {
					const cons = detail.consumers.filter((c: RawConsumer) => c.kind === kind);
					const entries = cons.flatMap(c => rtpEntries(c.stats, 'outbound-rtp').map(s => ({ key: `${c.id}:${s.ssrc}`, s })));
					let dPackets = 0;
					let dLost = 0;
					let dNack = 0;
					let dPli = 0;
					let valid = dt > 0;

					for (const e of entries) {
						const cur = { packetCount: e.s.packetCount ?? 0, packetsLost: e.s.packetsLost ?? 0, nackCount: e.s.nackCount ?? 0, pliCount: e.s.pliCount ?? 0 };
						const before = prev?.stats.get(e.key);

						next.set(e.key, cur);

						if (!before || cur.packetCount < before.packetCount) {
							valid = false;
							continue;
						}

						dPackets += cur.packetCount - before.packetCount;
						dLost += cur.packetsLost - before.packetsLost;
						dNack += cur.nackCount - before.nackCount;
						dPli += cur.pliCount - before.pliCount;
					}

					return {
						kind,
						bitrateBps: entries.length ? Math.round(entries.reduce((a, e) => a + (e.s.bitrate ?? 0), 0)) : null,
						rttMs: rttOf(entries.map(e => e.s)),
						jitterMs: entries[0] ? jitterMs(entries[0].s) : null,
						lossRatio: valid && dPackets > 0 ? dLost / dPackets : null,
						nackPerMin: valid ? round2((dNack / dt) * 60) : null,
						pliPerMin: valid ? round2((dPli / dt) * 60) : null,
						layer: cons[0]?.currentLayers ?? null,
						paused: cons.some(c => c.paused || c.producerPaused),
					};
				});

				liveCache.set(viewerId, { at: now, stats: next });

				for (const [id, entry] of liveCache) {
					if (Date.now() - entry.at > 30_000) {
						liveCache.delete(id);
					}
				}

				const video = kinds[0]!;
				const reported = freshClientStats(detail.transport, now);
				const mockClient =
					!reported && !hasClientStats(detail.transport) && ctx.config.mockEnabled ? mockClientReport(viewerId, now, video.lossRatio, 2000) : null;
				const client = reported ? liveClient(clientCache, viewerId, reported) : mockClient && { ...mockClient, ...playback(viewerId, mockClient.clientFreezeCount, mockClient.clientFps, video.layer?.spatialLayer ?? null), windowSeconds: 2, source: 'mock' as const };

				for (const [id, entry] of clientCache) {
					if (entry.cur.at !== null && now - entry.cur.at > 30_000) {
						clientCache.delete(id);
					}
				}

				return {
					ok: true as const,
					data: {
						time: new Date(now),
						transport: { iceState: detail.transport.iceState, dtlsState: detail.transport.dtlsState },
						// 세션에 IP가 아직 저장되기 전(ICE 연결 직후)에도 보이도록 지금 값을 함께 준다.
						remoteIp: clientIpOf(detail.transport),
						video,
						audio: kinds[1],
						client,
					},
					mock: client?.source === 'mock' ? ['viewer_sample.client_fps', 'viewer_sample.client_freeze_count', 'viewer_report.playback_state'] : [],
				};
			},
		});
	});
}

// ---------------- helpers ----------------

function sumPipe(batch: EdgeBatch, roomId?: string) {
	const rows = batch.pipeSamples.filter(p => !roomId || p.roomId === roomId);
	let lost = 0;
	let expected = 0;
	let bitrate = 0;
	const jitter: number[] = [];
	const rtt: number[] = [];

	for (const p of rows) {
		if (p.packetsExpected !== null && p.packetsLost !== null) {
			lost += p.packetsLost;
			expected += p.packetsExpected;
		}

		bitrate += p.bitrateBps ?? 0;

		if (p.jitterMs !== null && p.kind === 'video') {
			jitter.push(p.jitterMs);
		}

		if (p.rttMs !== null) {
			rtt.push(p.rttMs);
		}
	}

	return {
		lossRatio: expected > 0 ? lost / expected : null,
		bitrateBps: rows.length ? bitrate : null,
		jitterMs: jitter.length ? round2(Math.max(...jitter)) : null,
		rttMs: rtt.length ? round2(Math.max(...rtt)) : null,
	};
}

/** 방송별 pipe 시계열을 bucket마다 합친다 (Overview·Pipe 화면은 이 서버 전체). */
function aggregatePipe(points: PipeSeriesPoint[]) {
	const byBucket = new Map<number, PipeSeriesPoint[]>();

	for (const p of points) {
		const k = p.bucket.getTime();

		byBucket.set(k, [...(byBucket.get(k) ?? []), p]);
	}

	return [...byBucket]
		.sort((a, b) => a[0] - b[0])
		.map(([k, list]) => {
			const sum = (f: keyof PipeSeriesPoint) => list.reduce<number | null>((a, p) => (p[f] === null ? a : (a ?? 0) + (p[f] as number)), null);
			const max = (f: keyof PipeSeriesPoint) => list.reduce<number | null>((a, p) => (p[f] === null ? a : Math.max(a ?? 0, p[f] as number)), null);
			const expected = sum('packetsExpected');
			const lost = sum('packetsLost');
			const repaired = sum('packetsRepaired');

			return {
				bucket: new Date(k),
				lossRatio: expected ? (lost ?? 0) / expected : null,
				recoveredLossRatio: expected && lost !== null ? Math.max(0, lost - (repaired ?? 0)) / expected : null,
				rttMs: max('rttMs'),
				jitterMs: max('jitterMs'),
				bitrateBps: sum('bitrateBps'),
			};
		});
}

function viewerLossList(batch: EdgeBatch): number[] {
	return batch.viewerSamples.filter(v => v.packetsExpected && v.packetsLost !== null).map(v => v.packetsLost! / v.packetsExpected!);
}

function roomsTable(summary: Awaited<ReturnType<EdgeStore['getRoomSummary']>>, batch: EdgeBatch | null) {
	return summary.map(r => {
		const rtts = batch?.viewerSamples.filter(v => v.roomId === r.roomId && v.rttMs !== null).map(v => v.rttMs!) ?? [];

		return { ...r, rttP50Ms: rtts.length ? round2(percentile(rtts, 0.5)) : null };
	});
}

function viewerRow(v: ViewerListItem) {
	const seconds = Math.round(((v.disconnectedAt ?? new Date()).getTime() - v.connectedAt.getTime()) / 1000);

	return {
		viewerId: v.viewerId,
		displayName: v.displayName,
		roomId: v.roomId,
		workerIdx: v.workerIdx,
		lossRatio: v.lossRatio,
		freezeCount: v.freezeCount,
		// freeze 등 브라우저 값의 출처: 실제 보고 / mock / 없음 (M2)
		clientSource: v.clientReported ? 'browser' : v.freezeCount !== null ? 'mock' : null,
		rttMs: v.rttMs,
		bitrateBps: v.bitrateBps,
		layer: layerName(v.spatialLayer),
		spatialLayer: v.spatialLayer,
		temporalLayer: v.temporalLayer,
		transportState: v.transportState,
		// networkType(M3)·deviceClass(M4)는 화면에서 뺐다. DB에는 남아 있어 구현되면 여기만 되살리면 된다.
		deviceFlag: v.deviceFlag,
		peerId: v.peerId,
		identitySource: v.identitySource,
		browser: browserOf(v),
		remoteIp: v.remoteIp,
		connectedAt: v.connectedAt,
		connectedSeconds: seconds,
		lastSampleAt: v.lastSampleAt,
	};
}

/** M2 재생 mock에서 downlink 추정(M3, 네트워크 종류에서 만든 값)을 뺀 것. */
function playback(...args: Parameters<typeof mockViewerPlayback>) {
	const { downlinkMbps: _, ...rest } = mockViewerPlayback(...args);

	return rest;
}

/** 실제 신원(peer 정보)일 때만 값이 있다. 예: "Chrome 130.0" */
function browserOf(v: ViewerListItem): string | null {
	return v.identitySource === 'peer' && v.browserName ? `${v.browserName}${v.browserVersion ? ` ${v.browserVersion}` : ''}` : null;
}

/** 목록에 브라우저 값이 mock인 viewer가 하나라도 있으면 true → Freeze 칸에 MOCK 배지. */
function clientMock(items: ViewerListItem[]): boolean {
	return items.some(v => !v.clientReported && v.freezeCount !== null);
}

/**
 * 실제 브라우저 보고로 만든 실시간 값. 누적 칸(freeze·dropped)은 최근 보고 두 개의 차이, 나머지는 최근 값.
 * 화면이 "(최근 N초)"로 보여 주도록 구간 길이를 함께 준다.
 */
function liveClient(cache: Map<string, { prev: RawClientStats | null; cur: RawClientStats }>, viewerId: string, s: RawClientStats) {
	const entry = cache.get(viewerId);

	if (!entry) {
		cache.set(viewerId, { prev: null, cur: s });
	} else if (entry.cur.at !== s.at) {
		entry.prev = entry.cur;
		entry.cur = s;
	}

	const { prev, cur } = cache.get(viewerId)!;
	const d = (f: 'freezeCount' | 'freezeSec' | 'framesDropped') => {
		const a = cur[f];
		const b = prev?.[f];

		return typeof a === 'number' && typeof b === 'number' && a >= b ? a - b : null;
	};
	const freezeCount = d('freezeCount');
	const freezeSec = d('freezeSec');
	const fps = cur.fps === null ? null : Math.round(cur.fps * 10) / 10;

	return {
		source: 'browser' as const,
		windowSeconds: prev?.at && cur.at ? Math.max(1, Math.round((cur.at - prev.at) / 1000)) : null,
		clientFreezeCount: freezeCount,
		clientFreezeMs: freezeSec === null ? null : Math.round(freezeSec * 1000),
		clientFps: fps,
		clientJitterBufferMs: cur.jitterBufferMs === null ? null : Math.round(cur.jitterBufferMs),
		clientFramesDropped: d('framesDropped'),
		playbackState: playbackStateOf(freezeCount, fps),
		resolution: resolutionOf(cur),
	};
}

/** 목록에 실제 신원이 아닌(mock) viewer가 하나라도 있으면 true → 이름 칸에 MOCK 배지. */
function viewerIdentityMock(items: ViewerListItem[]): boolean {
	return items.some(v => v.identitySource !== 'peer');
}

function ratioSum(pairs: Array<[number | null, number | null]>): number | null {
	let lost = 0;
	let expected = 0;

	for (const [l, e] of pairs) {
		if (l !== null && e !== null) {
			lost += l;
			expected += e;
		}
	}

	return expected > 0 ? lost / expected : null;
}

function countBy<T>(list: T[], key: (item: T) => string): Record<string, number> {
	const out: Record<string, number> = {};

	for (const item of list) {
		out[key(item)] = (out[key(item)] ?? 0) + 1;
	}

	return out;
}
