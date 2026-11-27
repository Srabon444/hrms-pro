import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { safeNext } from './cookies';
import { decrypt, encrypt, keyedMac, keyedMacMatches, parseKeyRing, sign, unsign } from './crypto';
import { hashPassword, passwordProblem, verifyPassword } from './password';
import { base32Decode, base32Encode, hotp, matchTotp } from './totp';

const k = () => randomBytes(32).toString('base64');

describe('key ring', () => {
	it('keyed MACs match only the same purpose, payload and key, and survive rotation', () => {
		const old = parseKeyRing(`a:${k()}`);
		const mac = keyedMac('kiosk-pin', 't\nm\n482915', old);
		expect(mac.startsWith('a:')).toBe(true);
		expect(keyedMacMatches('kiosk-pin', mac, 't\nm\n482915', old)).toBe(true);
		expect(keyedMacMatches('kiosk-pin', mac, 't\nm\n482916', old)).toBe(false);
		expect(keyedMacMatches('other', mac, 't\nm\n482915', old)).toBe(false);
		const rotated = parseKeyRing(`b:${k()},a:${Buffer.from(old.keys.get('a')!).toString('base64')}`);
		expect(keyedMacMatches('kiosk-pin', mac, 't\nm\n482915', rotated)).toBe(true);
		expect(keyedMacMatches('kiosk-pin', mac, 't\nm\n482915', parseKeyRing(`a:${k()}`))).toBe(false);
		expect(keyedMacMatches('kiosk-pin', mac.replace(/^a:/, 'z:'), 't\nm\n482915', old)).toBe(false);
		expect(keyedMacMatches('kiosk-pin', 'garbage', 't\nm\n482915', old)).toBe(false);
	});

	it('round-trips with the active key and decrypts with an older one after rotation', () => {
		const old = parseKeyRing(`a:${k()}`);
		const blob = encrypt('secret', old);
		expect(blob.startsWith('a:')).toBe(true);
		const rotated = parseKeyRing(`b:${k()},a:${Buffer.from(old.keys.get('a')!).toString('base64')}`);
		expect(decrypt(blob, rotated)).toBe('secret');
		expect(encrypt('x', rotated).startsWith('b:')).toBe(true);
	});

	it('rejects tampering and unknown keys', () => {
		const r = parseKeyRing(`a:${k()}`);
		const [kid, iv, tag, ct] = encrypt('secret', r).split(':');
		const flipped = Buffer.from(ct, 'base64url');
		flipped[0] ^= 1;
		expect(() => decrypt([kid, iv, tag, flipped.toString('base64url')].join(':'), r)).toThrow();
		expect(() => decrypt(encrypt('x', parseKeyRing(`z:${k()}`)), r)).toThrow();
	});

	it('binds a ciphertext to its additional data', () => {
		const r = parseKeyRing(`a:${k()}`);
		const blob = encrypt('secret', r, 'pdfpw:one');
		expect(decrypt(blob, r, 'pdfpw:one')).toBe('secret');
		expect(() => decrypt(blob, r, 'pdfpw:two')).toThrow();
		expect(() => decrypt(blob, r)).toThrow();
		expect(decrypt(encrypt('plain', r), r)).toBe('plain');
	});

	it('rejects malformed key specs', () => {
		expect(() => parseKeyRing('a:c2hvcnQ=')).toThrow();
		const key = k();
		expect(() => parseKeyRing(`a:${key},a:${key}`)).toThrow();
	});

	it('signs per purpose', () => {
		const r = parseKeyRing(`a:${k()}`);
		const token = sign('device', 'x@y.z', r);
		expect(unsign('device', token, r)).toBe('x@y.z');
		expect(unsign('other', token, r)).toBeNull();
		expect(
			unsign(
				'device',
				token.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')),
				r
			)
		).toBeNull();
		expect(unsign('device', undefined, r)).toBeNull();
	});
});

describe('totp', () => {
	const secret = Buffer.from('12345678901234567890');
	it.each([
		[59, '287082'],
		[1111111109, '081804'],
		[1111111111, '050471'],
		[1234567890, '005924'],
		[2000000000, '279037']
	])('matches RFC 6238 vector at %i', (t, code) => {
		expect(hotp(secret, Math.floor(t / 30))).toBe(code);
		expect(matchTotp(base32Encode(secret), code, new Date(t * 1000))).toBe(Math.floor(t / 30));
	});

	it('accepts one step of drift only and rejects junk', () => {
		const b32 = base32Encode(secret);
		const at = new Date(1111111109 * 1000);
		expect(matchTotp(b32, '081804', new Date(at.getTime() + 30_000))).not.toBeNull();
		expect(matchTotp(b32, '081804', new Date(at.getTime() + 90_000))).toBeNull();
		expect(matchTotp(b32, '12345', at)).toBeNull();
		expect(matchTotp(b32, 'abcdef', at)).toBeNull();
	});

	it('round-trips base32', () => {
		const buf = randomBytes(20);
		expect(base32Decode(base32Encode(buf))).toEqual(buf);
	});
});

describe('password', () => {
	it('enforces length, email and blocklist rules', () => {
		expect(passwordProblem('short', 'a@b.c')).toMatch(/at least/);
		expect(passwordProblem('x'.repeat(129), 'a@b.c')).toMatch(/at most/);
		expect(passwordProblem('Me@Example.com', 'me@example.com')).toMatch(/email/);
		expect(passwordProblem('Password123', 'a@b.c')).toMatch(/common/);
		expect(passwordProblem('correct horse battery', 'a@b.c')).toBeNull();
	});

	it('verifies argon2id hashes and fails closed on missing or foreign hashes', async () => {
		const h = await hashPassword('correct horse battery');
		expect(h.startsWith('$argon2id$')).toBe(true);
		expect(await verifyPassword(h, 'correct horse battery')).toBe(true);
		expect(await verifyPassword(h, 'wrong horse battery')).toBe(false);
		expect(await verifyPassword(null, 'anything')).toBe(false);
		expect(await verifyPassword('x', 'anything')).toBe(false);
	});
});

describe('safeNext', () => {
	it('keeps same-site paths and rejects anything a browser could turn into another origin', () => {
		expect(safeNext('/t/demo/leave?x=1')).toBe('/t/demo/leave?x=1');
		for (const bad of [
			null,
			'',
			'https://evil.test',
			'//evil.test',
			'/\\evil.test',
			'/\t/evil.test',
			'/\n/evil.test',
			'javascript:alert(1)'
		])
			expect(safeNext(bad)).toBe('/');
	});
});
