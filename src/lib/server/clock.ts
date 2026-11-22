import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from './config';

const override = new AsyncLocalStorage<Date>();

export function now(): Date {
	return override.getStore() ?? new Date();
}

export function withTestNow<T>(iso: string | null | undefined, fn: () => T): T {
	if (!iso || !config().TEST_MODE) return fn();
	const at = new Date(iso);
	if (Number.isNaN(at.getTime())) return fn();
	return override.run(at, fn);
}
