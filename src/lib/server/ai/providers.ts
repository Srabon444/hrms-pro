import type { AiProvider } from '../db/schema';

export type AiPart = { text: string } | { data: string; mime: string };
export type AiRequest = {
	system: string;
	parts: AiPart[];
	schema?: Record<string, unknown>;
	maxOutputTokens: number;
};
export type AiResult = { text: string; json?: unknown; usage: { input: number; output: number }; model: string };

export const AI_ERRORS = [
	'key_invalid',
	'quota',
	'rate_limited',
	'unavailable',
	'timeout',
	'blocked',
	'bad_output',
	'model_unsupported',
	'budget',
	'disabled',
	'no_key'
] as const;
export type AiErrorCode = (typeof AI_ERRORS)[number];

export class AiError extends Error {
	constructor(
		public code: AiErrorCode,
		public scope: 'key' | 'model' | 'request' = 'request',
		public coolMs = 0
	) {
		super(code);
	}
}

export type Call = { url: string; init: RequestInit };
type Body = Record<string, unknown> & { error?: Record<string, unknown> };

export type Adapter = {
	modelsUrl: (pageToken?: string) => string;
	headers: (key: string) => Record<string, string>;
	readModels: (body: Body) => { ids: string[]; next?: string };
	call: (model: string, key: string, req: AiRequest) => Call;
	read: (model: string, body: Body, json: boolean) => AiResult;
	fail: (status: number, body: Body, headers: Headers) => AiError;
};

const MAX_COOL_MS = 10 * 60_000;
const seconds = (v: unknown) => {
	const n = Number.parseFloat(String(v ?? ''));
	return Number.isFinite(n) && n > 0 ? Math.min(n * 1000, MAX_COOL_MS) : 60_000;
};
const cool = (headers: Headers, hint?: unknown) =>
	new AiError('rate_limited', 'model', seconds(hint ?? headers.get('retry-after')));
const common = (status: number, headers: Headers): AiError | null => {
	if (status === 408 || status >= 500) return new AiError('unavailable', 'model', seconds(headers.get('retry-after')));
	if (status === 404) return new AiError('model_unsupported', 'model');
	return null;
};
const post = (url: string, headers: Record<string, string>, body: unknown): Call => ({
	url,
	init: { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) }
});
const parseJson = (text: string, json: boolean) => {
	if (!json) return undefined;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new AiError('bad_output', 'model');
	}
};
const nonEmpty = (text: string) => {
	if (!text.trim()) throw new AiError('bad_output', 'model');
	return text;
};
const lower = (v: unknown) => String(v ?? '').toLowerCase();

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';

const gemini: Adapter = {
	modelsUrl: (page) => `${GEMINI}/models?pageSize=1000${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`,
	headers: (key) => ({ 'x-goog-api-key': key }),
	readModels: (body) => ({
		ids: ((body.models as { name: string; supportedGenerationMethods?: string[] }[]) ?? [])
			.filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
			.map((m) => m.name.replace(/^models\//, '')),
		next: (body.nextPageToken as string) || undefined
	}),
	call: (model, key, req) =>
		post(`${GEMINI}/models/${encodeURIComponent(model)}:generateContent`, gemini.headers(key), {
			systemInstruction: { parts: [{ text: req.system }] },
			contents: [
				{
					role: 'user',
					parts: req.parts.map((p) =>
						'text' in p ? { text: p.text } : { inlineData: { mimeType: p.mime, data: p.data } }
					)
				}
			],
			generationConfig: {
				maxOutputTokens: req.maxOutputTokens,
				...(req.schema ? { responseMimeType: 'application/json', responseSchema: req.schema } : {})
			}
		}),
	read: (model, body, json) => {
		const c = (body.candidates as { content?: { parts?: { text?: string }[] }; finishReason?: string }[])?.[0];
		const usage = body.usageMetadata as
			{ promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number } | undefined;
		if (!c || c.finishReason === 'SAFETY' || (body.promptFeedback as { blockReason?: string })?.blockReason)
			throw new AiError(c ? 'blocked' : 'bad_output', 'model');
		if (c.finishReason === 'MAX_TOKENS') throw new AiError('bad_output', 'model');
		const text = nonEmpty((c.content?.parts ?? []).map((p) => p.text ?? '').join(''));
		return {
			text,
			json: parseJson(text, json),
			usage: {
				input: usage?.promptTokenCount ?? 0,
				output: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0)
			},
			model
		};
	},
	fail: (status, body, headers) => {
		const err = body.error ?? {};
		const details = (err.details as { reason?: string; retryDelay?: string; '@type'?: string }[]) ?? [];
		if (details.some((d) => d.reason === 'API_KEY_INVALID') || status === 401) return new AiError('key_invalid', 'key');
		if (status === 403)
			return lower(err.message).includes('model')
				? new AiError('model_unsupported', 'model')
				: new AiError('key_invalid', 'key');
		if (status === 429)
			return cool(headers, details.find((d) => d.retryDelay)?.retryDelay?.replace(/s$/, '') ?? undefined);
		if (status === 400) return new AiError('model_unsupported', 'model');
		return common(status, headers) ?? new AiError('unavailable', 'model');
	}
};

const OPENAI = 'https://api.openai.com/v1';

const openai: Adapter = {
	modelsUrl: () => `${OPENAI}/models`,
	headers: (key) => ({ authorization: `Bearer ${key}` }),
	readModels: (body) => ({ ids: ((body.data as { id: string }[]) ?? []).map((m) => m.id) }),
	call: (model, key, req) =>
		post(`${OPENAI}/responses`, openai.headers(key), {
			model,
			instructions: req.system,
			max_output_tokens: req.maxOutputTokens,
			input: [
				{
					role: 'user',
					content: req.parts.map((p) =>
						'text' in p
							? { type: 'input_text', text: p.text }
							: p.mime === 'application/pdf'
								? { type: 'input_file', filename: 'file.pdf', file_data: `data:${p.mime};base64,${p.data}` }
								: { type: 'input_image', image_url: `data:${p.mime};base64,${p.data}` }
					)
				}
			],
			...(req.schema
				? { text: { format: { type: 'json_schema', name: 'output', schema: req.schema, strict: true } } }
				: {})
		}),
	read: (model, body, json) => {
		if (body.status === 'incomplete') throw new AiError('bad_output', 'model');
		const content = ((body.output as { type: string; content?: { type: string; text?: string }[] }[]) ?? [])
			.filter((o) => o.type === 'message')
			.flatMap((o) => o.content ?? []);
		if (content.some((c) => c.type === 'refusal')) throw new AiError('blocked', 'model');
		const text = nonEmpty(
			content
				.filter((c) => c.type === 'output_text')
				.map((c) => c.text ?? '')
				.join('')
		);
		const usage = body.usage as { input_tokens?: number; output_tokens?: number } | undefined;
		return {
			text,
			json: parseJson(text, json),
			usage: { input: usage?.input_tokens ?? 0, output: usage?.output_tokens ?? 0 },
			model
		};
	},
	fail: (status, body, headers) => {
		const err = body.error ?? {};
		if (status === 401) return new AiError('key_invalid', 'key');
		if (status === 403)
			return lower(err.message).includes('model')
				? new AiError('model_unsupported', 'model')
				: new AiError('key_invalid', 'key');
		if (status === 429)
			return err.code === 'insufficient_quota' || err.type === 'insufficient_quota'
				? new AiError('quota', 'key')
				: cool(headers);
		if (status === 400) return new AiError('model_unsupported', 'model');
		return common(status, headers) ?? new AiError('unavailable', 'model');
	}
};

const ANTHROPIC = 'https://api.anthropic.com/v1';

const anthropic: Adapter = {
	modelsUrl: (page) => `${ANTHROPIC}/models?limit=1000${page ? `&after_id=${encodeURIComponent(page)}` : ''}`,
	headers: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
	readModels: (body) => ({
		ids: ((body.data as { id: string }[]) ?? []).map((m) => m.id),
		next: body.has_more ? (body.last_id as string) : undefined
	}),
	call: (model, key, req) =>
		post(`${ANTHROPIC}/messages`, anthropic.headers(key), {
			model,
			system: req.system,
			max_tokens: req.maxOutputTokens,
			messages: [
				{
					role: 'user',
					content: req.parts.map((p) =>
						'text' in p
							? { type: 'text', text: p.text }
							: {
									type: p.mime === 'application/pdf' ? 'document' : 'image',
									source: { type: 'base64', media_type: p.mime, data: p.data }
								}
					)
				}
			],
			...(req.schema
				? {
						tools: [{ name: 'output', description: 'Return the result.', input_schema: req.schema }],
						tool_choice: { type: 'tool', name: 'output' }
					}
				: {})
		}),
	read: (model, body, json) => {
		if (body.stop_reason === 'max_tokens') throw new AiError('bad_output', 'model');
		if (body.stop_reason === 'refusal') throw new AiError('blocked', 'model');
		const content = (body.content as { type: string; text?: string; input?: unknown }[]) ?? [];
		const usage = body.usage as { input_tokens?: number; output_tokens?: number } | undefined;
		const tool = content.find((c) => c.type === 'tool_use');
		if (json && !tool) throw new AiError('bad_output', 'model');
		const text = tool
			? JSON.stringify(tool.input)
			: nonEmpty(
					content
						.filter((c) => c.type === 'text')
						.map((c) => c.text ?? '')
						.join('')
				);
		return {
			text,
			json: tool?.input,
			usage: { input: usage?.input_tokens ?? 0, output: usage?.output_tokens ?? 0 },
			model
		};
	},
	fail: (status, body, headers) => {
		const err = body.error ?? {};
		if (status === 401 || status === 403) return new AiError('key_invalid', 'key');
		if (status === 400 && lower(err.message).includes('credit balance')) return new AiError('quota', 'key');
		if (status === 429) return cool(headers);
		if (status === 529) return new AiError('unavailable', 'model', seconds(headers.get('retry-after')));
		if (status === 400) return new AiError('model_unsupported', 'model');
		return common(status, headers) ?? new AiError('unavailable', 'model');
	}
};

export const ADAPTERS: Record<AiProvider, Adapter> = { gemini, openai, anthropic };
