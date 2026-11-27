import { sha256 } from '../auth/crypto';
import type { AiProvider } from '../db/schema';
import { ADAPTERS, AiError, type AiRequest, type AiResult } from './providers';

export const DEFAULT_CHAINS: Record<AiProvider, string[]> = {
	gemini: ['gemini-4-neon', 'gemini-4-flash', 'gemini-3.9-flash', 'gemini-3.8-flash', 'gemini-flash-latest'],
	openai: ['gpt-6.2-sol', 'gpt-6.1-sol'],
	anthropic: ['claude-sonnet-5-5', 'claude-opus-5-5']
};

export const MODEL_ID = /^[A-Za-z0-9._-]{1,80}$/;
export const keyPrint = (key: string) => sha256(key).slice(0, 16);

export function chainFor(provider: AiProvider, pinned: string | null, listed: string[] | null): string[] {
	const base = [...new Set([...(pinned ? [pinned] : []), ...DEFAULT_CHAINS[provider]])];
	if (!listed) return base;
	const seen = new Set(listed);
	const kept = base.filter((m) => seen.has(m));
	return kept.length ? kept : base;
}

export type Transport = (model: string, key: string, req: AiRequest, signal: AbortSignal) => Promise<AiResult>;
export type Lister = (key: string, signal: AbortSignal) => Promise<string[]>;

const MAX_PAGES = 20;

const send = (url: string, init: RequestInit, signal: AbortSignal) =>
	fetch(url, { ...init, redirect: 'error', signal }).catch((err: Error) => {
		throw new AiError(
			err.name === 'TimeoutError' || err.name === 'AbortError' ? 'timeout' : 'unavailable',
			'model',
			60_000
		);
	});

const body = (res: Response) => res.json().catch(() => ({})) as Promise<Record<string, unknown>>;

export const httpTransport =
	(provider: AiProvider): Transport =>
	async (model, key, req, signal) => {
		const a = ADAPTERS[provider];
		const { url, init } = a.call(model, key, req);
		const res = await send(url, init, signal);
		const b = await body(res);
		if (!res.ok) throw a.fail(res.status, b, res.headers);
		return a.read(model, b, !!req.schema);
	};

export const httpLister =
	(provider: AiProvider): Lister =>
	(key, signal) => {
		const a = ADAPTERS[provider];
		const page = async (token: string | undefined, left: number, acc: string[]): Promise<string[]> => {
			const res = await send(a.modelsUrl(token), { headers: a.headers(key) }, signal);
			const b = await body(res);
			if (!res.ok) throw a.fail(res.status, b, res.headers);
			const { ids, next } = a.readModels(b);
			const all = [...acc, ...ids];
			return next && left > 1 ? page(next, left - 1, all) : all;
		};
		return page(undefined, MAX_PAGES, []);
	};

export type Cooling = { cool: (model: string, ms: number) => Promise<void> };

export async function runChain(
	chain: string[],
	key: string,
	req: AiRequest,
	opts: { transport: Transport; cooling: Cooling; deadline: number; callTimeoutMs: number; now?: () => number }
): Promise<AiResult> {
	const clock = opts.now ?? Date.now;
	const attempt = async (i: number, badOutputs: number, last: AiError | null): Promise<AiResult> => {
		if (i >= chain.length) throw last ?? new AiError('unavailable');
		const remaining = opts.deadline - clock();
		if (remaining <= 0) throw new AiError('timeout');
		try {
			return await opts.transport(chain[i], key, req, AbortSignal.timeout(Math.min(opts.callTimeoutMs, remaining)));
		} catch (raw) {
			const err = raw instanceof AiError ? raw : new AiError('unavailable', 'model', 60_000);
			if (err.scope !== 'model') throw err;
			const cut = err.code === 'timeout' && remaining < opts.callTimeoutMs;
			const bad = err.code === 'bad_output' || err.code === 'blocked';
			if (bad && badOutputs >= 1) throw err;
			if (err.coolMs > 0 && !cut) await opts.cooling.cool(chain[i], err.coolMs);
			return attempt(i + 1, badOutputs + (bad ? 1 : 0), err);
		}
	};
	return attempt(0, 0, null);
}
