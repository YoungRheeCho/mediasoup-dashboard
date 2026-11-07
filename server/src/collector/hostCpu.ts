import { readFileSync } from 'node:fs';

/**
 * 노드 전체 CPU 사용률. /proc/stat은 컨테이너 안에서도 호스트 전체 값을 보여 준다.
 * 직전 호출과의 차이로 계산하므로 첫 호출은 null.
 */
export class HostCpuSampler {
	#prev: { idle: number; total: number } | null = null;

	sample(): number | null {
		let line: string | undefined;

		try {
			line = readFileSync('/proc/stat', 'utf8').split('\n', 1)[0];
		} catch {
			return null;
		}

		if (!line?.startsWith('cpu ')) {
			return null;
		}

		const parts = line.trim().split(/\s+/).slice(1).map(Number);
		const idle = (parts[3] ?? 0) + (parts[4] ?? 0); // idle + iowait
		const total = parts.reduce((a, b) => a + b, 0);
		const prev = this.#prev;

		this.#prev = { idle, total };

		if (!prev || total <= prev.total) {
			return null;
		}

		return Math.round((1 - (idle - prev.idle) / (total - prev.total)) * 10000) / 100;
	}
}
