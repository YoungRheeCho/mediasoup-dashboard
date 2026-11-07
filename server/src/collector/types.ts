/** 한 수집 주기에 정규화기로 넘기는 값. */
export type CycleContext = {
	/** 사이드카가 잰 이번 수집 전체 시간 (훅 왕복 포함) */
	collectDurationMs: number | null;
	/** 직전 주기가 길어져 건너뛴 주기가 있었는지 */
	skipped: boolean;
	hostCpuPct: number | null;
	mockEnabled: boolean;
	intervalMs: number;
	/** origin: PipeTransport 원격 IP → edge id (heartbeat와 설정으로 채움) */
	edgeIdByIp?: ReadonlyMap<string, string>;
};
