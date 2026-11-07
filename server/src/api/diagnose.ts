/**
 * 화면의 "진단 요약"·"권장" 문구. 숫자를 규칙으로 해석한 짧은 문장이다.
 * 판단 근거가 mock 값이면 mock=true로 표시해 화면이 배지를 붙인다.
 * 원인을 단정하지 않고 "가능성"으로 쓴다.
 */

export type Finding = { level: 'ok' | 'info' | 'warn' | 'crit'; title: string; detail: string; mock?: boolean };

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

/** 개별 viewer 상세 */
export function diagnoseViewer(input: {
	lossRatio: number | null;
	rttMs: number | null;
	spatialLayer: number | null;
	layerDropped: boolean;
	roomPipeLossRatio: number | null;
	roomViewerLossP50: number | null;
	freezePerMin: number | null;
	/** freeze 값이 mock인지 (실제 브라우저 보고가 없는 구간) */
	freezeMock: boolean;
	lossWarn: number;
}): Finding[] {
	const out: Finding[] = [];
	const { lossRatio, rttMs, roomPipeLossRatio, lossWarn } = input;

	if (lossRatio !== null && lossRatio >= lossWarn) {
		out.push({
			level: lossRatio >= 0.05 ? 'warn' : 'info',
			title: '수신 경로 문제 (가능성)',
			detail: `loss ${pct(lossRatio)}${rttMs !== null ? `, RTT ${Math.round(rttMs)}ms` : ''}${
				input.layerDropped ? '. 레이어를 낮췄는데도 개선되지 않았습니다' : ''
			}.`,
		});
	} else if (lossRatio !== null) {
		out.push({ level: 'ok', title: '수신 상태 양호', detail: `loss ${pct(lossRatio)}${rttMs !== null ? `, RTT ${Math.round(rttMs)}ms` : ''}.` });
	}

	if (roomPipeLossRatio !== null && roomPipeLossRatio >= lossWarn) {
		out.push({
			level: 'warn',
			title: 'Pipe 수신 loss의 영향',
			detail: `이 방송의 pipe 수신 loss가 ${pct(roomPipeLossRatio)}입니다. 이 viewer 문제의 일부는 상류(pipe)에서 온 것으로 보입니다.`,
		});
	}

	if (input.freezePerMin !== null && input.freezePerMin >= 2) {
		out.push({ level: 'warn', title: '재생 끊김', detail: `freeze ${input.freezePerMin}회/분 (브라우저 보고).`, mock: input.freezeMock });
	}

	return out;
}

/** broadcaster 상세 */
export function diagnoseBroadcaster(input: {
	lossRatio: number | null;
	rttMs: number | null;
	fps: number | null;
	layersActive: number | null;
	maxLayers: number | null;
	qualityLimitation: string | null;
	edgesWithLoss: Array<{ edgeId: string; lossRatio: number }>;
	lossWarn: number;
}): Finding[] {
	const out: Finding[] = [];

	if (input.lossRatio !== null && input.lossRatio >= input.lossWarn) {
		out.push({ level: 'warn', title: '입력 loss가 높습니다', detail: `전송 loss ${pct(input.lossRatio)}. broadcaster 쪽 네트워크를 확인하세요.` });
	} else if (input.lossRatio !== null) {
		out.push({
			level: 'ok',
			title: '입력은 정상입니다',
			detail: `전송 loss ${pct(input.lossRatio)}${input.rttMs !== null ? `, RTT ${Math.round(input.rttMs)}ms` : ''}.`,
		});
	}

	if (input.layersActive !== null && input.maxLayers !== null && input.layersActive < input.maxLayers) {
		out.push({ level: 'warn', title: 'simulcast 레이어 일부 중단', detail: `활성 레이어 ${input.layersActive}/${input.maxLayers}.` });
	}

	if (input.qualityLimitation && input.qualityLimitation !== 'none') {
		out.push({ level: 'info', title: '송출 품질 제한', detail: `브라우저가 ${input.qualityLimitation} 때문에 품질을 낮췄습니다.`, mock: true });
	}

	for (const e of input.edgesWithLoss) {
		out.push({
			level: 'warn',
			title: `${e.edgeId}의 수신 손실은 입력 때문이 아닙니다`,
			detail: `입력 loss는 낮은데 ${e.edgeId} 수신 측 보고 loss가 ${pct(e.lossRatio)}입니다. 해당 구간 네트워크를 의심해 볼 수 있습니다.`,
		});
	}

	return out;
}

/** Workers: router 배치 권장 */
export function adviseWorkers(workers: Array<{ workerIdx: number; cpuPct: number | null; restarts: number }>, targetCpuPct = 80): Finding[] {
	const known = workers.filter(w => w.cpuPct !== null) as Array<{ workerIdx: number; cpuPct: number; restarts: number }>;

	if (known.length === 0) {
		return [];
	}

	const out: Finding[] = [];
	const sorted = [...known].sort((a, b) => a.cpuPct - b.cpuPct);
	const busiest = sorted.at(-1)!;
	const idlest = sorted[0]!;
	const hot = known.filter(w => w.cpuPct >= targetCpuPct - 15);

	if (hot.length > 0) {
		out.push({
			level: busiest.cpuPct >= targetCpuPct ? 'warn' : 'info',
			title: `${hot.map(w => `w${w.workerIdx}`).join(' · ')} CPU가 높습니다`,
			detail: `가장 바쁜 w${busiest.workerIdx}는 ${Math.round(busiest.cpuPct)}%, 목표 ${targetCpuPct}%까지 여유 ${Math.max(0, Math.round(targetCpuPct - busiest.cpuPct))}%p.`,
		});
	}

	if (known.length > 1) {
		out.push({
			level: 'ok',
			title: `새 router·viewer는 w${idlest.workerIdx}에 먼저 배치하는 편이 좋습니다`,
			detail: `w${idlest.workerIdx} CPU ${Math.round(idlest.cpuPct)}% (여유 ${Math.max(0, Math.round(targetCpuPct - idlest.cpuPct))}%p).`,
		});
	}

	for (const w of known.filter(x => x.restarts > 0)) {
		out.push({ level: 'info', title: `w${w.workerIdx} 재시작 이력`, detail: `관측 이후 ${w.restarts}회 재시작했습니다. 안정성 확인 후 부하를 늘리세요.` });
	}

	return out;
}
