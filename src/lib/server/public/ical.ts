import { eq } from 'drizzle-orm';
import { sha256 } from '../auth/crypto';
import { feedIcs } from '../calendar';
import { calendarFeeds } from '../db/schema';
import { log } from '../log';
import { hitOrLocal, overLimit } from '../ratelimit';
import { systemCtx, withTenant } from '../tenancy';
import { activeHolder, lookupToken } from './tokens';

const HOUR = 3_600_000;
export const ICAL_PER_TOKEN_HOUR = 30;
export const ICAL_FAILURES_PER_IP_HOUR = 20;
const FILE = /^([A-Za-z0-9_-]{43})\.ics$/;

const PRIVATE = {
	'cache-control': 'private, max-age=900',
	'referrer-policy': 'no-referrer',
	'x-robots-tag': 'noindex'
};

const notFound = () => new Response('Not found', { status: 404, headers: PRIVATE });
const limited = (retryAfter: number) =>
	new Response('Too many requests', { status: 429, headers: { ...PRIVATE, 'retry-after': String(retryAfter) } });

export async function icalFeed(file: string, ip: string): Promise<Response> {
	if (await overLimit('ical-fail', ip, ICAL_FAILURES_PER_IP_HOUR)) return limited(HOUR / 1000);
	const failed = async () => {
		await hitOrLocal('ical-fail', ip, ICAL_FAILURES_PER_IP_HOUR, HOUR);
		return notFound();
	};
	const token = FILE.exec(file)?.[1];
	if (!token) return failed();
	const hash = sha256(token);
	const perToken = await hitOrLocal('ical-token', hash, ICAL_PER_TOKEN_HOUR, HOUR);
	if (!perToken.ok) return limited(perToken.retryAfter);
	const found = await lookupToken('calendar_feed', hash);
	if (!found) return failed();
	const [feed] = await withTenant(systemCtx(found.tenantId), (tx) =>
		tx.select({ membershipId: calendarFeeds.membershipId }).from(calendarFeeds).where(eq(calendarFeeds.id, found.id))
	);
	const holder = feed ? await activeHolder(found, feed.membershipId) : null;
	if (!holder) return failed();
	const body = await feedIcs(holder);
	if (body === null) return failed();
	log.info({ tenantId: holder.tenantId, feed: token.slice(0, 6) }, 'calendar feed served');
	return new Response(body, { headers: { ...PRIVATE, 'content-type': 'text/calendar; charset=utf-8' } });
}
