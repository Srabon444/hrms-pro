import { Writable } from 'node:stream';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configSchema } from '../config';
import { LOG_REDACT } from '../log';
import { sampleOf } from './fake';
import { chainFor, httpLister, httpTransport, runChain, type Transport } from './models';
import { ADAPTERS, AiError, type AiRequest } from './providers';

const req: AiRequest = {
	system: 'sys',
	parts: [{ text: 'hello' }, { data: 'QUJD', mime: 'application/pdf' }],
	schema: { type: 'object', properties: { a: { type: 'string' } } },
	maxOutputTokens: 100
};
const h = (v: Record<string, string> = {}) => new Headers(v);
const body = (init: RequestInit) => JSON.parse(String(init.body));

describe('gemini adapter', () => {
	const g = ADAPTERS.gemini;
	it('sends the key in a header, never the url, with inline files and a json schema', () => {
		const { url, init } = g.call('gemini-4-flash', 'SECRET', req);
		expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-4-flash:generateContent');
		expect(url).not.toContain('SECRET');
		expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('SECRET');
		const b = body(init);
		expect(b.systemInstruction.parts[0].text).toBe('sys');
		expect(b.contents[0].parts[1]).toEqual({ inlineData: { mimeType: 'application/pdf', data: 'QUJD' } });
		expect(b.generationConfig).toMatchObject({ maxOutputTokens: 100, responseMimeType: 'application/json' });
	});
	it('reads text, json and usage', () => {
		const r = g.read(
			'm',
			{
				candidates: [{ content: { parts: [{ text: '{"a":' }, { text: '"x"}' }] }, finishReason: 'STOP' }],
				usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7 }
			},
			true
		);
		expect(r).toEqual({ text: '{"a":"x"}', json: { a: 'x' }, usage: { input: 5, output: 7 }, model: 'm' });
	});
	it('counts thinking tokens as output', () => {
		const r = g.read(
			'm',
			{
				candidates: [{ content: { parts: [{ text: 'ok' }] } }],
				usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, thoughtsTokenCount: 30 }
			},
			false
		);
		expect(r.usage).toEqual({ input: 1, output: 32 });
	});
	it('treats truncated, blocked, empty and broken output as model failures', () => {
		const code = (b: Record<string, unknown>, json = false) => {
			try {
				g.read('m', b, json);
			} catch (e) {
				return [(e as AiError).code, (e as AiError).scope];
			}
		};
		expect(code({ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'MAX_TOKENS' }] })).toEqual([
			'bad_output',
			'model'
		]);
		expect(code({ candidates: [{ finishReason: 'SAFETY' }] })).toEqual(['blocked', 'model']);
		expect(code({ promptFeedback: { blockReason: 'OTHER' } })).toEqual(['bad_output', 'model']);
		expect(code({ candidates: [{ content: { parts: [{ text: ' ' }] } }] })).toEqual(['bad_output', 'model']);
		expect(code({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] }, true)).toEqual([
			'bad_output',
			'model'
		]);
	});
	it('maps errors to the fallback table', () => {
		const f = (status: number, error: Record<string, unknown> = {}, headers = h()) => {
			const e = g.fail(status, { error }, headers);
			return [e.code, e.scope, e.coolMs];
		};
		expect(f(400, { details: [{ reason: 'API_KEY_INVALID' }] })).toEqual(['key_invalid', 'key', 0]);
		expect(f(401)).toEqual(['key_invalid', 'key', 0]);
		expect(f(403, { message: 'Permission denied' })).toEqual(['key_invalid', 'key', 0]);
		expect(f(403, { message: 'No access to model' })).toEqual(['model_unsupported', 'model', 0]);
		expect(f(429, { details: [{ retryDelay: '12s' }] })).toEqual(['rate_limited', 'model', 12_000]);
		expect(f(429, {}, h({ 'retry-after': '9000' }))).toEqual(['rate_limited', 'model', 600_000]);
		expect(f(404)).toEqual(['model_unsupported', 'model', 0]);
		expect(f(400, { message: 'bad schema' })).toEqual(['model_unsupported', 'model', 0]);
		expect(f(503)).toEqual(['unavailable', 'model', 60_000]);
		expect(f(408)).toEqual(['unavailable', 'model', 60_000]);
	});
	it('reads model lists, keeping only generateContent models without the prefix', () => {
		expect(
			g.readModels({
				models: [
					{ name: 'models/gemini-4-flash', supportedGenerationMethods: ['generateContent'] },
					{ name: 'models/embed', supportedGenerationMethods: ['embedContent'] }
				],
				nextPageToken: 'p2'
			})
		).toEqual({ ids: ['gemini-4-flash'], next: 'p2' });
	});
});

describe('openai adapter', () => {
	const o = ADAPTERS.openai;
	it('sends a bearer key, files as input_file and a strict json schema', () => {
		const { url, init } = o.call('gpt-6.2-sol', 'SECRET', req);
		expect(url).toBe('https://api.openai.com/v1/responses');
		expect((init.headers as Record<string, string>).authorization).toBe('Bearer SECRET');
		const b = body(init);
		expect(b.input[0].content[1]).toMatchObject({ type: 'input_file', file_data: 'data:application/pdf;base64,QUJD' });
		expect(b.text.format).toMatchObject({ type: 'json_schema', strict: true });
	});
	it('reads output text and refusals', () => {
		const out = {
			output: [{ type: 'message', content: [{ type: 'output_text', text: '{"a":"y"}' }] }],
			usage: { input_tokens: 2, output_tokens: 3 }
		};
		expect(o.read('m', out, true)).toMatchObject({ json: { a: 'y' }, usage: { input: 2, output: 3 } });
		expect(() => o.read('m', { output: [{ type: 'message', content: [{ type: 'refusal' }] }] }, false)).toThrow(
			'blocked'
		);
		expect(() => o.read('m', { status: 'incomplete' }, false)).toThrow('bad_output');
	});
	it('stops on quota, cools on a plain 429', () => {
		expect(o.fail(429, { error: { code: 'insufficient_quota' } }, h())).toMatchObject({ code: 'quota', scope: 'key' });
		expect(o.fail(429, { error: {} }, h({ 'retry-after': '3' }))).toMatchObject({ code: 'rate_limited', coolMs: 3000 });
		expect(o.fail(401, {}, h())).toMatchObject({ code: 'key_invalid', scope: 'key' });
	});
});

describe('anthropic adapter', () => {
	const a = ADAPTERS.anthropic;
	it('forces a tool for json and sends documents', () => {
		const { url, init } = a.call('claude-sonnet-5-5', 'SECRET', req);
		expect(url).toBe('https://api.anthropic.com/v1/messages');
		expect(init.headers).toMatchObject({ 'x-api-key': 'SECRET', 'anthropic-version': '2023-06-01' });
		const b = body(init);
		expect(b.tool_choice).toEqual({ type: 'tool', name: 'output' });
		expect(b.messages[0].content[1]).toMatchObject({ type: 'document', source: { media_type: 'application/pdf' } });
	});
	it('reads the tool input as json', () => {
		const r = a.read(
			'm',
			{ content: [{ type: 'tool_use', input: { a: 'z' } }], usage: { input_tokens: 1, output_tokens: 1 } },
			true
		);
		expect(r.json).toEqual({ a: 'z' });
		expect(() => a.read('m', { content: [{ type: 'text', text: 'hi' }] }, true)).toThrow('bad_output');
		expect(() => a.read('m', { stop_reason: 'max_tokens', content: [] }, false)).toThrow('bad_output');
	});
	it('maps billing to quota and overload to cooling', () => {
		expect(a.fail(400, { error: { message: 'Your credit balance is too low' } }, h())).toMatchObject({
			code: 'quota',
			scope: 'key'
		});
		expect(a.fail(529, {}, h())).toMatchObject({ code: 'unavailable', scope: 'model', coolMs: 60_000 });
		expect(a.readModels({ data: [{ id: 'x' }], has_more: true, last_id: 'x' })).toEqual({ ids: ['x'], next: 'x' });
	});
});

describe('model chain', () => {
	it('puts a pinned model first and keeps the default chain behind it', () => {
		expect(chainFor('openai', 'gpt-6.1-sol', null)).toEqual(['gpt-6.1-sol', 'gpt-6.2-sol']);
		expect(chainFor('gemini', null, null)[0]).toBe('gemini-4-neon');
	});
	it('skips models the key cannot see, and falls back to the full chain when none are listed', () => {
		expect(chainFor('gemini', null, ['gemini-3.9-flash', 'gemini-flash-latest', 'other'])).toEqual([
			'gemini-3.9-flash',
			'gemini-flash-latest'
		]);
		expect(chainFor('anthropic', null, ['other'])).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5']);
	});
});

describe('runChain', () => {
	const ok = (model: string) => ({ text: 'OK', usage: { input: 1, output: 1 }, model });
	const run = (transport: Transport, chain = ['a', 'b', 'c'], deadline = Date.now() + 10_000) => {
		const cool = vi.fn(async () => {});
		return { cool, result: runChain(chain, 'k', req, { transport, cooling: { cool }, deadline, callTimeoutMs: 1000 }) };
	};

	it('cools a rate limited model and answers from the next one', async () => {
		const { cool, result } = run(async (m) => {
			if (m === 'a') throw new AiError('rate_limited', 'model', 5000);
			return ok(m);
		});
		expect((await result).model).toBe('b');
		expect(cool).toHaveBeenCalledWith('a', 5000);
	});
	it('moves past an unsupported model without cooling it', async () => {
		const { cool, result } = run(async (m) => {
			if (m !== 'c') throw new AiError('model_unsupported', 'model');
			return ok(m);
		});
		expect((await result).model).toBe('c');
		expect(cool).not.toHaveBeenCalled();
	});
	it('stops at once on a key-wide error', async () => {
		const transport = vi.fn(async () => {
			throw new AiError('quota', 'key');
		});
		await expect(run(transport).result).rejects.toMatchObject({ code: 'quota' });
		expect(transport).toHaveBeenCalledTimes(1);
	});
	it('retries bad output on one more model only', async () => {
		const transport = vi.fn(async () => {
			throw new AiError('bad_output', 'model');
		});
		await expect(run(transport).result).rejects.toMatchObject({ code: 'bad_output' });
		expect(transport).toHaveBeenCalledTimes(2);
	});
	it('gives up with a timeout once the deadline has passed', async () => {
		await expect(run(async (m) => ok(m), ['a'], Date.now() - 1).result).rejects.toMatchObject({ code: 'timeout' });
	});
	it('does not cool a model that only ran out of the request deadline', async () => {
		const { cool, result } = run(
			async () => {
				throw new AiError('timeout', 'model', 60_000);
			},
			['a'],
			Date.now() + 200
		);
		await expect(result).rejects.toMatchObject({ code: 'timeout' });
		expect(cool).not.toHaveBeenCalled();
	});
	it('reports the last error when every model fails', async () => {
		await expect(
			run(async () => {
				throw new AiError('unavailable', 'model', 1000);
			}).result
		).rejects.toMatchObject({ code: 'unavailable' });
	});
});

describe('http transport', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('refuses redirects and pages the model list to the end', async () => {
		const calls: [string, RequestInit][] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, init: RequestInit) => {
				calls.push([url, init]);
				const page = url.includes('pageToken')
					? { models: [{ name: 'models/b', supportedGenerationMethods: ['generateContent'] }] }
					: { models: [{ name: 'models/a', supportedGenerationMethods: ['generateContent'] }], nextPageToken: 'n' };
				return new Response(JSON.stringify(page), { status: 200 });
			})
		);
		expect(await httpLister('gemini')('k', AbortSignal.timeout(1000))).toEqual(['a', 'b']);
		expect(calls).toHaveLength(2);
		expect(calls.every(([, i]) => i.redirect === 'error')).toBe(true);
	});
	it('turns a network failure into a cooling model error and never surfaces the body', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Promise.reject(new TypeError('fetch failed')))
		);
		await expect(httpTransport('gemini')('m', 'k', req, AbortSignal.timeout(1000))).rejects.toMatchObject({
			code: 'unavailable',
			scope: 'model'
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('{"error":{"message":"secret detail"}}', { status: 500 }))
		);
		const err = await httpTransport('gemini')('m', 'k', req, AbortSignal.timeout(1000)).catch((e: Error) => e);
		expect((err as Error).message).toBe('unavailable');
	});
});

describe('ai safety rails', () => {
	it('redacts api keys and key ciphertext in logs', () => {
		const lines: string[] = [];
		const sink = new Writable({ write: (c, _e, done) => (lines.push(String(c)), done()) });
		const l = pino({ redact: LOG_REDACT }, sink);
		l.info(
			{
				apiKey: 'AIza-secret',
				form: { apiKey: 'sk-secret' },
				keyEnc: 'v1:abc',
				headers: { 'x-goog-api-key': 'g', 'x-api-key': 'a' }
			},
			'x'
		);
		expect(lines.join('')).not.toMatch(/secret|v1:abc|"g"|"a"/);
	});
	it('refuses AI_FAKE outside test mode and in production', () => {
		const base = {
			DATABASE_URL: 'postgres://a/b',
			AUTH_DATABASE_URL: 'postgres://a/b',
			REDIS_URL: 'redis://a',
			S3_ENDPOINT: 'http://a',
			S3_ACCESS_KEY: 'a',
			S3_SECRET_KEY: 'a',
			S3_BUCKET: 'abc',
			SMTP_URL: 'smtp://a',
			MAIL_FROM: 'a@b.c',
			APP_URL: 'http://a',
			APP_ENC_KEYS: 'k1:' + Buffer.alloc(32).toString('base64'),
			METRICS_TOKEN: 'metrics-token'
		};
		const ok = (extra: Record<string, string>) => configSchema.safeParse({ ...base, ...extra }).success;
		expect(ok({ AI_FAKE: '1', TEST_MODE: '1', NODE_ENV: 'test' })).toBe(true);
		expect(ok({ AI_FAKE: '1' })).toBe(false);
		expect(configSchema.parse({ ...base, AI_PLATFORM_GEMINI: 'on' }).AI_PLATFORM_GEMINI).toBe(true);
		expect(configSchema.parse({ ...base, AI_PLATFORM_GEMINI: 'off' }).AI_PLATFORM_GEMINI).toBe(false);
		expect(ok({ AI_FAKE: '1', TEST_MODE: '1', NODE_ENV: 'production' })).toBe(false);
	});
	it('fills a schema with sample values for the fake provider', () => {
		expect(
			sampleOf({
				type: 'object',
				properties: { a: { type: 'string' }, n: { type: 'number' }, e: { enum: ['x', 'y'] } }
			})
		).toEqual({ a: 'sample', n: 1, e: 'x' });
	});
});
