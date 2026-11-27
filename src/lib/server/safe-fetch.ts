import { lookup, type LookupAddress } from 'node:dns';
import { request } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { AppError } from './errors';

export const SAFE_FETCH_TIMEOUT_MS = 5000;
export const SAFE_FETCH_MAX_BYTES = 64 * 1024;
export const SAFE_URL_MAX = 500;

const blocked4 = new BlockList();
const blocked6 = new BlockList();
for (const [net, bits] of [
	['0.0.0.0', 8],
	['10.0.0.0', 8],
	['100.64.0.0', 10],
	['127.0.0.0', 8],
	['169.254.0.0', 16],
	['172.16.0.0', 12],
	['192.0.0.0', 24],
	['192.0.2.0', 24],
	['192.88.99.0', 24],
	['192.168.0.0', 16],
	['198.18.0.0', 15],
	['198.51.100.0', 24],
	['203.0.113.0', 24],
	['224.0.0.0', 4],
	['240.0.0.0', 4]
] as const)
	blocked4.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
	['::', 96],
	['::ffff:0:0', 96],
	['64:ff9b::', 96],
	['64:ff9b:1::', 48],
	['100::', 64],
	['2001::', 23],
	['2001:db8::', 32],
	['2002::', 16],
	['3fff::', 20],
	['fc00::', 7],
	['fe80::', 10],
	['ff00::', 8]
] as const)
	blocked6.addSubnet(net, bits, 'ipv6');

const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');

export function isPublicAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) return !blocked4.check(address, 'ipv4');
	if (family === 6) return globalV6.check(address, 'ipv6') && !blocked6.check(address, 'ipv6');
	return false;
}

const LOCAL_SUFFIX = /\.(localhost|local|internal|intranet|lan|home|corp|private|arpa|invalid|test|example)$/i;

const unsafe = (message: string) => new AppError('unsafe_url', message, 400);

export function checkUrl(raw: string): URL {
	if (raw.length > SAFE_URL_MAX) throw unsafe(`Keep the address under ${SAFE_URL_MAX} characters.`);
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw unsafe('Enter a full address that starts with https://.');
	}
	if (url.href.length > SAFE_URL_MAX) throw unsafe(`Keep the address under ${SAFE_URL_MAX} characters.`);
	if (url.protocol !== 'https:') throw unsafe('The address must start with https://.');
	if (url.port && url.port !== '443') throw unsafe('The address must use the standard HTTPS port.');
	if (url.username || url.password) throw unsafe('Remove the user name and password from the address.');
	const host = url.hostname.replace(/^\[|\]$/g, '');
	if (!host) throw unsafe('Enter a full address that starts with https://.');
	const name = host.replace(/\.$/, '');
	if (!isIP(host) && (!name.includes('.') || LOCAL_SUFFIX.test(name)))
		throw unsafe('The address must be on the public internet.');
	if (isIP(host) && !isPublicAddress(host)) throw unsafe('The address must be on the public internet.');
	return url;
}

export const publicLookup: LookupFunction = (hostname, options, callback) => {
	lookup(hostname, { family: options.family, all: true, verbatim: true }, (err, addresses: LookupAddress[]) => {
		if (err) return callback(err, '', 0);
		if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address)))
			return callback(unsafe('The address must be on the public internet.'), '', 0);
		if (options.all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses);
		callback(null, addresses[0].address, addresses[0].family);
	});
};

export type SafeResponse = { status: number; body: string };

export async function safeFetch(
	raw: string,
	init: { method: 'POST'; headers: Record<string, string>; body: string }
): Promise<SafeResponse> {
	const url = checkUrl(raw);
	const body = Buffer.from(init.body, 'utf8');
	return new Promise((resolve, reject) => {
		const req = request(
			{
				host: url.hostname.replace(/^\[|\]$/g, ''),
				servername: isIP(url.hostname.replace(/^\[|\]$/g, '')) ? undefined : url.hostname,
				port: 443,
				path: `${url.pathname}${url.search}`,
				method: init.method,
				headers: { ...init.headers, 'content-length': String(body.length) },
				lookup: publicLookup,
				agent: false,
				signal: AbortSignal.timeout(SAFE_FETCH_TIMEOUT_MS)
			},
			(res) => {
				const chunks: Buffer[] = [];
				let size = 0;
				const done = () => {
					resolve({
						status: res.statusCode ?? 0,
						body: Buffer.concat(chunks).subarray(0, SAFE_FETCH_MAX_BYTES).toString('utf8')
					});
					res.destroy();
				};
				res.on('data', (c: Buffer) => {
					chunks.push(c);
					size += c.length;
					if (size >= SAFE_FETCH_MAX_BYTES) done();
				});
				res.on('end', done);
				res.on('error', reject);
			}
		);
		req.on('error', reject);
		req.end(body);
	});
}
