/**
 * 사이드카 설정. 모두 환경 변수로 받는다 (k8s 매니페스트에서 주입).
 */

export type Mode = 'edge' | 'origin';

export type Config = {
	mode: Mode;
	/** 이 서버의 이름. edge는 노드 이름(Downward API spec.nodeName)을 권장 (H11). */
	serverId: string;
	/** mediasoup 입력: 'hook' = 사전 로드 훅 소켓, 'sim' = 로컬 개발용 시뮬레이터. */
	mediasoupSource: 'hook' | 'sim';
	hookSocket: string;
	hookTimeoutMs: number;
	collectIntervalMs: number;
	/** 서버 코드 수정이 필요한 항목을 mock으로 채울지 (docs/collection-design.md M1~M8). */
	mockEnabled: boolean;
	databaseUrl: string;
	/** 시작할 때 스키마가 없으면 db/*.sql을 적용한다. */
	dbAutoInit: boolean;
	dbSchemaDir: string;
	/** 빌드된 화면 (web/dist) */
	webDir: string;
	retention: {
		viewerRawHours: number;
		rawDays: number;
		aggregateDays: number;
	};
	/** origin: 알려진 edge 목록 "edgeId=ip=dashboardUrl,..." (heartbeat로도 채워진다). */
	edgeTargets: Array<{ edgeId: string; ip: string; dashboardUrl: string }>;
	/** sim 모드에서 만들 규모. */
	sim: { rooms: number; viewersPerRoom: number; workers: number };
	http: { host: string; port: number };
	/** NIC 용량 (Overview "송신 트래픽 0.6 / 1 Gbps"). 측정할 수 없어 설정으로 받는다. 기본 1 Gbps. */
	nicCapacityBps: number;
	/** 다른 서버가 이 대시보드를 여는 주소 (origin의 "열기 ↗", edge 사이드바의 origin 링크). */
	publicUrl: string;
	liveness: {
		/** push: edge가 origin에 보낸다 (기본). pull: origin이 edge에 묻는다 (AGENT_TASK 6.4 미정). */
		mode: 'push' | 'pull';
		intervalMs: number;
		/** edge: origin 대시보드 주소 (push 대상, 사이드바 링크) */
		originUrl: string | null;
		/** edge: pipe 수신 IP. origin이 PipeTransport 원격 IP와 대조한다 (M7). */
		pipeIp: string | null;
		region: string | null;
	};
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const mode = (env.MSDASH_MODE ?? 'edge') as Mode;

	if (mode !== 'edge' && mode !== 'origin') {
		throw new Error(`invalid MSDASH_MODE: ${mode}`);
	}

	const source = (env.MSDASH_MEDIASOUP_SOURCE ?? 'hook') as Config['mediasoupSource'];

	if (source !== 'hook' && source !== 'sim') {
		throw new Error(`invalid MSDASH_MEDIASOUP_SOURCE: ${source}`);
	}

	const livenessMode = (env.MSDASH_LIVENESS_MODE ?? 'push') as Config['liveness']['mode'];

	if (livenessMode !== 'push' && livenessMode !== 'pull') {
		throw new Error(`invalid MSDASH_LIVENESS_MODE: ${livenessMode}`);
	}

	const http = { host: env.MSDASH_HTTP_HOST ?? '0.0.0.0', port: int(env.MSDASH_HTTP_PORT, 8080) };

	return {
		mode,
		serverId: env.MSDASH_SERVER_ID ?? env.NODE_NAME ?? `${mode}-local`,
		mediasoupSource: source,
		hookSocket: env.MSDASH_HOOK_SOCKET ?? '/var/run/msdash/hook.sock',
		hookTimeoutMs: int(env.MSDASH_HOOK_TIMEOUT_MS, 8000),
		collectIntervalMs: int(env.MSDASH_COLLECT_INTERVAL_MS, 10000),
		mockEnabled: (env.MSDASH_MOCK ?? '1') !== '0',
		databaseUrl: env.MSDASH_DATABASE_URL ?? 'postgres://postgres:dev@127.0.0.1:5432/msdash',
		dbAutoInit: (env.MSDASH_DB_AUTO_INIT ?? '1') !== '0',
		dbSchemaDir: env.MSDASH_DB_SCHEMA_DIR ?? new URL('../../../db/', import.meta.url).pathname, // dist/src → mediasoup-dashboard/db
		webDir: env.MSDASH_WEB_DIR ?? new URL('../../../web/dist/', import.meta.url).pathname,
		retention: {
			viewerRawHours: int(env.MSDASH_RETENTION_VIEWER_HOURS, 48),
			rawDays: int(env.MSDASH_RETENTION_RAW_DAYS, 7),
			aggregateDays: int(env.MSDASH_RETENTION_AGG_DAYS, 14),
		},
		edgeTargets: parseEdgeTargets(env.MSDASH_EDGE_TARGETS ?? ''),
		sim: {
			rooms: env.MSDASH_SIM_ROOMS === '0' ? 0 : int(env.MSDASH_SIM_ROOMS, 3), // 0 = 빈 서버 (빈 상태 확인용)
			viewersPerRoom: int(env.MSDASH_SIM_VIEWERS, 40),
			workers: int(env.MSDASH_SIM_WORKERS, 4),
		},
		http,
		nicCapacityBps: int(env.MSDASH_NIC_CAPACITY_BPS, 1_000_000_000),
		publicUrl: env.MSDASH_PUBLIC_URL ?? `http://${env.SERVER_IP ?? '127.0.0.1'}:${http.port}`,
		liveness: {
			mode: livenessMode,
			intervalMs: int(env.MSDASH_HEARTBEAT_INTERVAL_MS, 10000),
			originUrl: env.MSDASH_ORIGIN_URL ?? null,
			pipeIp: env.MSDASH_PIPE_IP ?? env.SERVER_IP ?? null,
			region: env.MSDASH_REGION ?? null,
		},
	};
}

function int(value: string | undefined, fallback: number): number {
	const n = Number.parseInt(value ?? '', 10);

	return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseEdgeTargets(value: string): Config['edgeTargets'] {
	return value
		.split(',')
		.map(s => s.trim())
		.filter(Boolean)
		.map(item => {
			const [edgeId, ip, ...rest] = item.split('=');

			if (!edgeId || !ip) {
				throw new Error(`invalid MSDASH_EDGE_TARGETS item: ${item}`);
			}

			return { edgeId, ip, dashboardUrl: rest.join('=') || `http://${ip}:8080` };
		});
}
