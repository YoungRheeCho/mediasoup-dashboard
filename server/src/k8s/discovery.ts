import { readFileSync } from 'node:fs';
import * as https from 'node:https';

import { createLogger } from '../log.js';

const logger = createLogger('k8s');

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

export type K8sNode = {
	name: string;
	ready: boolean;
	internalIp: string | null;
	cpuCores: number | null;
};

export type K8sPod = {
	name: string;
	role: 'edge' | 'origin';
	nodeName: string | null;
	phase: string | null;
	hostIp: string | null;
	podIp: string | null;
	ready: boolean;
};

export type ClusterView = {
	ok: boolean;
	error: string | null;
	updatedAt: Date | null;
	nodes: K8sNode[];
	pods: K8sPod[];
};

/**
 * k8s API로 노드와 origin/edge Pod 목록을 읽는다 (읽기 전용). origin 대시보드에서만 켠다.
 *
 * - Pod 안의 ServiceAccount 토큰으로 API 서버(https://kubernetes.default.svc)에 묻는다.
 * - 필요한 권한: nodes list(클러스터 범위), pods list(네임스페이스). deploy/k8s/origin/rbac.yaml.
 * - 권한이 없거나 클러스터 밖이면 ok=false로 두고, 화면은 edge가 heartbeat로 알려 준 노드 이름(NODE_NAME)만 쓴다.
 */
export class K8sDiscovery {
	#view: ClusterView = { ok: false, error: '아직 조회하지 않음', updatedAt: null, nodes: [], pods: [] };
	#timer: NodeJS.Timeout | null = null;

	constructor(
		private readonly opts: { namespace: string | null; edgeSelector: string; originSelector: string; intervalMs: number }
	) {}

	get view(): ClusterView {
		return this.#view;
	}

	start(): void {
		if (this.#timer) {
			return;
		}

		void this.refresh();
		this.#timer = setInterval(() => void this.refresh(), this.opts.intervalMs);
	}

	stop(): void {
		if (this.#timer) {
			clearInterval(this.#timer);
			this.#timer = null;
		}
	}

	async refresh(): Promise<void> {
		try {
			const sa = readServiceAccount(this.opts.namespace);
			const nodes = (await getJson(sa, '/api/v1/nodes')) as { items?: unknown[] };
			const pods: K8sPod[] = [];

			for (const [role, selector] of [
				['edge', this.opts.edgeSelector],
				['origin', this.opts.originSelector],
			] as const) {
				const list = (await getJson(sa, `/api/v1/namespaces/${encodeURIComponent(sa.namespace)}/pods?labelSelector=${encodeURIComponent(selector)}`)) as {
					items?: unknown[];
				};

				for (const item of list.items ?? []) {
					pods.push(toPod(item, role));
				}
			}

			if (!this.#view.ok) {
				logger.info('k8s discovery ok (%d nodes, %d pods)', nodes.items?.length ?? 0, pods.length);
			}

			this.#view = { ok: true, error: null, updatedAt: new Date(), nodes: (nodes.items ?? []).map(toNode), pods };
		} catch (error) {
			const message = (error as Error).message;

			if (this.#view.error !== message) {
				logger.warn('k8s discovery failed: %s', message);
			}

			// 마지막으로 성공한 목록은 남겨 둔다 (잠깐 실패해도 화면이 비지 않게)
			this.#view = { ...this.#view, ok: false, error: message };
		}
	}
}

type ServiceAccount = { token: string; ca: Buffer; namespace: string; host: string; port: number };

function readServiceAccount(namespace: string | null): ServiceAccount {
	let token: string;

	try {
		token = readFileSync(`${SA_DIR}/token`, 'utf8').trim();
	} catch {
		throw new Error('ServiceAccount 토큰이 없습니다 (클러스터 밖이거나 automountServiceAccountToken=false)');
	}

	return {
		token,
		ca: readFileSync(`${SA_DIR}/ca.crt`),
		namespace: namespace ?? readFileSync(`${SA_DIR}/namespace`, 'utf8').trim(),
		host: process.env.KUBERNETES_SERVICE_HOST ?? 'kubernetes.default.svc',
		port: Number(process.env.KUBERNETES_SERVICE_PORT ?? 443),
	};
}

function getJson(sa: ServiceAccount, path: string): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const req = https.request(
			{ host: sa.host, port: sa.port, path, method: 'GET', ca: sa.ca, headers: { authorization: `Bearer ${sa.token}`, accept: 'application/json' }, timeout: 5000 },
			res => {
				const chunks: Buffer[] = [];

				res.on('data', (c: Buffer) => chunks.push(c));
				res.on('end', () => {
					const text = Buffer.concat(chunks).toString('utf8');

					if ((res.statusCode ?? 0) >= 400) {
						reject(new Error(`k8s API ${path.split('?')[0]} → ${res.statusCode}${res.statusCode === 403 ? ' (권한 없음: deploy/k8s/origin/rbac.yaml 적용 필요)' : ''}`));

						return;
					}

					try {
						resolve(JSON.parse(text));
					} catch {
						reject(new Error(`k8s API ${path} returned invalid JSON`));
					}
				});
			}
		);

		req.on('timeout', () => req.destroy(new Error('k8s API timeout')));
		req.on('error', reject);
		req.end();
	});
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function toNode(item: unknown): K8sNode {
	const meta = obj(obj(item).metadata);
	const status = obj(obj(item).status);
	const conditions = Array.isArray(status.conditions) ? status.conditions.map(obj) : [];
	const addresses = Array.isArray(status.addresses) ? status.addresses.map(obj) : [];
	const cpu = str(obj(status.capacity).cpu);

	return {
		name: str(meta.name) ?? '?',
		ready: conditions.some(c => c.type === 'Ready' && c.status === 'True'),
		internalIp: str(addresses.find(a => a.type === 'InternalIP')?.address),
		cpuCores: cpu ? parseCpu(cpu) : null,
	};
}

function toPod(item: unknown, role: 'edge' | 'origin'): K8sPod {
	const meta = obj(obj(item).metadata);
	const spec = obj(obj(item).spec);
	const status = obj(obj(item).status);
	const conditions = Array.isArray(status.conditions) ? status.conditions.map(obj) : [];

	return {
		name: str(meta.name) ?? '?',
		role,
		nodeName: str(spec.nodeName),
		phase: str(status.phase),
		hostIp: str(status.hostIP),
		podIp: str(status.podIP),
		ready: conditions.some(c => c.type === 'Ready' && c.status === 'True'),
	};
}

/** "4" → 4, "3500m" → 3.5 */
function parseCpu(v: string): number | null {
	const n = v.endsWith('m') ? Number(v.slice(0, -1)) / 1000 : Number(v);

	return Number.isFinite(n) ? n : null;
}
