import { format } from 'node:util';

type Level = 'debug' | 'info' | 'warn' | 'error';

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = order[(process.env.MSDASH_LOG_LEVEL as Level) ?? 'info'] ?? order.info;

export type Logger = Record<Level, (fmt: string, ...args: unknown[]) => void>;

export function createLogger(scope: string): Logger {
	const write = (level: Level) => (fmt: string, ...args: unknown[]) => {
		if (order[level] < threshold) {
			return;
		}

		const line = `${new Date().toISOString()} ${level.toUpperCase()} [${scope}] ${format(fmt, ...args)}\n`;

		(level === 'warn' || level === 'error' ? process.stderr : process.stdout).write(line);
	};

	return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
}
