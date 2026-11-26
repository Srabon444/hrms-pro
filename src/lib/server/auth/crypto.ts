import {
	createCipheriv,
	createDecipheriv,
	createHash,
	createHmac,
	hkdfSync,
	randomBytes,
	timingSafeEqual
} from 'node:crypto';
import { config } from '../config';

export type KeyRing = { active: string; keys: Map<string, Buffer> };

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export function safeEqual(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

export function parseKeyRing(spec: string): KeyRing {
	const keys = new Map<string, Buffer>();
	let active = '';
	for (const part of spec.split(',').map((p) => p.trim())) {
		const [kid, b64] = part.split(':');
		const key = Buffer.from(b64 ?? '', 'base64');
		if (!kid || key.length !== 32) throw new Error(`APP_ENC_KEYS entry "${kid ?? ''}" must be kid:base64(32 bytes)`);
		if (keys.has(kid)) throw new Error(`APP_ENC_KEYS has duplicate kid "${kid}"`);
		keys.set(kid, key);
		active ||= kid;
	}
	return { active, keys };
}

let ring: KeyRing | undefined;
const keyRing = (): KeyRing => (ring ??= parseKeyRing(config().APP_ENC_KEYS));

export function encrypt(plain: string, r: KeyRing = keyRing(), aad?: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', r.keys.get(r.active)!, iv);
	if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
	const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
	return [r.active, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join(
		':'
	);
}

export function decrypt(blob: string, r: KeyRing = keyRing(), aad?: string): string {
	const [kid, iv, tag, ct] = blob.split(':');
	const key = r.keys.get(kid ?? '');
	if (!key || !iv || !tag || ct === undefined) throw new Error('ciphertext key or format unknown');
	const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
	decipher.setAuthTag(Buffer.from(tag, 'base64url'));
	if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
	return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

const purposeKey = (key: Buffer, purpose: string) => Buffer.from(hkdfSync('sha256', key, '', purpose, 32));

export function sign(purpose: string, payload: string, r: KeyRing = keyRing()): string {
	const mac = createHmac('sha256', purposeKey(r.keys.get(r.active)!, purpose))
		.update(payload)
		.digest('base64url');
	return `${Buffer.from(payload).toString('base64url')}.${r.active}.${mac}`;
}

export function unsign(purpose: string, token: string | undefined, r: KeyRing = keyRing()): string | null {
	const [body, kid, mac] = (token ?? '').split('.');
	const key = r.keys.get(kid ?? '');
	if (!body || !key || !mac) return null;
	const payload = Buffer.from(body, 'base64url').toString('utf8');
	const expected = createHmac('sha256', purposeKey(key, purpose)).update(payload).digest('base64url');
	return safeEqual(mac, expected) ? payload : null;
}
