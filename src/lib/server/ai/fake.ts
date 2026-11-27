import { setTimeout as wait } from 'node:timers/promises';
import type { AiProvider } from '../db/schema';
import { DEFAULT_CHAINS, type Lister, type Transport } from './models';
import { AiError } from './providers';

type Schema = { type?: string; properties?: Record<string, Schema>; items?: Schema; enum?: unknown[] };

export function sampleOf(s: Schema | undefined): unknown {
	if (!s) return null;
	if (s.enum?.length) return s.enum[0];
	if (s.type === 'object')
		return Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, v]) => [k, sampleOf(v)]));
	if (s.type === 'array') return [];
	if (s.type === 'number' || s.type === 'integer') return 1;
	if (s.type === 'boolean') return false;
	return 'sample';
}

const CANNED: Record<string, unknown> = {
	receipt: { merchant: 'City Cafe', spentOn: '2026-01-15', amount: 450.5, currency: 'BDT', categoryGuess: 'Meals' },
	cv: {
		fullName: 'Rina Akter',
		email: 'rina.akter@example.com',
		phone: '+880 1711 000000',
		currentTitle: 'QA Engineer',
		yearsExperience: 4,
		skills: ['Playwright', 'SQL']
	},
	document: { title: 'AWS Certified Developer', expiresOn: '2029-03-31' },
	announcement: 'The office will close early on Thursday for the team outing. Please plan your work around it.',
	job: 'We are hiring a teammate to own day-to-day delivery. You will work with a small, friendly team.',
	reply: 'Thanks for raising this. We have looked into it and will update you by tomorrow.'
};

const refuse = (key: string) => {
	if (key.includes('bad')) throw new AiError('key_invalid', 'key');
	if (key.includes('quota')) throw new AiError('quota', 'key');
};

export const fakeLister =
	(provider: AiProvider): Lister =>
	async (key) => {
		refuse(key);
		return [...DEFAULT_CHAINS[provider], `${provider}-fake-extra`];
	};

export const fakeTransport: Transport = async (model, key, req, signal) => {
	refuse(key);
	if (key.includes('delay')) await wait(150, undefined, { signal }).catch(() => undefined);
	if (key.includes('slow')) await wait(600_000, undefined, { signal }).catch(() => undefined);
	if (signal.aborted) throw new AiError('timeout', 'model', 60_000);
	if (key.includes('busy') && model.includes('neon')) throw new AiError('rate_limited', 'model', 60_000);
	const canned = req.task ? CANNED[req.task] : undefined;
	const json = req.schema ? (canned ?? sampleOf(req.schema as Schema)) : undefined;
	const text = json !== undefined ? JSON.stringify(json) : typeof canned === 'string' ? canned : 'OK';
	const input = Math.ceil(
		(req.system.length + req.parts.reduce((n, p) => n + ('text' in p ? p.text.length : 0), 0)) / 4
	);
	return { text, json, usage: { input, output: Math.ceil(text.length / 4) }, model };
};
