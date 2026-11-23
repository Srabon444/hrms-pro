import { createHmac, randomBytes } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;

export function base32Encode(buf: Buffer): string {
	let bits = 0;
	let value = 0;
	let out = '';
	for (const byte of buf) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += ALPHABET[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
	return out;
}

export function base32Decode(input: string): Buffer {
	const clean = input.replace(/[\s=]/g, '').toUpperCase();
	let bits = 0;
	let value = 0;
	const out: number[] = [];
	for (const ch of clean) {
		const idx = ALPHABET.indexOf(ch);
		if (idx < 0) throw new Error('invalid base32 secret');
		value = (value << 5) | idx;
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 255);
			bits -= 8;
		}
	}
	return Buffer.from(out);
}

export const newTotpSecret = (): string => base32Encode(randomBytes(20));

export const timeStep = (at: Date): number => Math.floor(at.getTime() / 1000 / STEP_SECONDS);

export function hotp(secret: Buffer, counter: number, digits = 6): string {
	const msg = Buffer.alloc(8);
	msg.writeBigUInt64BE(BigInt(counter));
	const mac = createHmac('sha1', secret).update(msg).digest();
	const offset = mac[mac.length - 1] & 15;
	const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
	return code.toString().padStart(digits, '0');
}

export function matchTotp(secretB32: string, code: string, at: Date, window = 1): number | null {
	if (!/^\d{6}$/.test(code)) return null;
	const secret = base32Decode(secretB32);
	const step = timeStep(at);
	for (let d = -window; d <= window; d++) if (hotp(secret, step + d) === code) return step + d;
	return null;
}

export const otpauthUri = (secretB32: string, account: string, issuer: string): string =>
	`otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
