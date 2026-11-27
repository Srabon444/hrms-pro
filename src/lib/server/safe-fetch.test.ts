import { describe, expect, it } from 'vitest';
import { checkUrl, isPublicAddress, publicLookup, safeFetch } from './safe-fetch';

describe('isPublicAddress', () => {
	it.each([
		'0.0.0.0',
		'10.1.2.3',
		'100.64.0.1',
		'127.0.0.1',
		'169.254.169.254',
		'172.16.0.1',
		'172.31.255.255',
		'192.0.0.8',
		'192.0.2.1',
		'192.168.1.1',
		'198.18.0.1',
		'198.51.100.7',
		'203.0.113.9',
		'224.0.0.1',
		'255.255.255.255',
		'::',
		'::1',
		'::ffff:127.0.0.1',
		'::ffff:7f00:1',
		'::ffff:169.254.169.254',
		'64:ff9b::a9fe:a9fe',
		'2001:db8::1',
		'2001::1',
		'2002:7f00:1::',
		'fc00::1',
		'fd00:ec2::254',
		'fe80::1',
		'ff02::1',
		'not-an-ip'
	])('blocks %s', (ip) => expect(isPublicAddress(ip)).toBe(false));

	it.each(['1.1.1.1', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '2001:4860:4860::8888'])(
		'allows %s',
		(ip) => expect(isPublicAddress(ip)).toBe(true)
	);
});

describe('checkUrl', () => {
	it.each([
		['http://example.com/hook', 'https://'],
		['https://example.com:8443/hook', 'standard HTTPS port'],
		['https://user:pw@example.com/hook', 'user name'],
		['https://127.0.0.1/hook', 'public internet'],
		['https://[::1]/hook', 'public internet'],
		['https://[::ffff:10.0.0.1]/hook', 'public internet'],
		['https://0x7f000001/hook', 'public internet'],
		['https://2130706433/hook', 'public internet'],
		['https://169.254.169.254/latest', 'public internet'],
		['not a url', 'https://'],
		['https://localhost/hook', 'public internet'],
		['https://localhost./hook', 'public internet'],
		['https://metadata.google.internal/computeMetadata', 'public internet'],
		['https://printer.local/hook', 'public internet'],
		['https://intranet/hook', 'public internet'],
		['https://router.home.arpa/hook', 'public internet'],
		[`https://example.com/${'a'.repeat(500)}`, '500 characters']
	])('refuses %s', (url, message) => expect(() => checkUrl(url)).toThrow(message));

	it('accepts a public https address', () => {
		expect(checkUrl('https://hooks.example.com:443/a?b=1').href).toBe('https://hooks.example.com/a?b=1');
	});

	it('refuses a host name that resolves to a private address before connecting', async () => {
		const answer = (all: boolean) =>
			new Promise<unknown>((resolve) =>
				publicLookup('localhost', { all }, (err, address) => resolve(err?.message ?? address))
			);
		expect(await answer(true)).toBe('The address must be on the public internet.');
		expect(await answer(false)).toBe('The address must be on the public internet.');
		await expect(safeFetch('https://10.1.1.1/hook', { method: 'POST', headers: {}, body: '{}' })).rejects.toThrow(
			'public internet'
		);
	});
});
