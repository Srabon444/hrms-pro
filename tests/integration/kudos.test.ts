import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	addComment,
	deleteComment,
	forgetCommenters,
	hideComment,
	threadPage,
	toggleReaction
} from '../../src/lib/server/announcement-comments';
import { announcementFeed, saveAnnouncement } from '../../src/lib/server/announcements';
import { sha256 } from '../../src/lib/server/auth/crypto';
import { createSession } from '../../src/lib/server/auth/session';
import { closePools, ownerPool } from '../../src/lib/server/db';
import { memberships } from '../../src/lib/server/db/schema';
import {
	forgetKudos,
	giveKudos,
	hideKudos,
	kudosMonths,
	kudosPage,
	kudosWall,
	saveKudosValues
} from '../../src/lib/server/kudos';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess, type requireMember } from '../../src/lib/server/rbac/access';
import { closeRedis, redisReady, rkey } from '../../src/lib/server/redis';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { createTenant, createUser, TEST_LOCALE } from './helpers';

type Member = ReturnType<typeof requireMember>;
type Tenant = { id: string; slug: string };
let tenant: Tenant;
let other: Tenant;
const who: Record<string, Member> = {};
const dept: Record<string, string> = {};
const sys = (t = tenant) => systemCtx(t.id);
const sql = () => ownerPool().sql;
const code = (p: Promise<unknown>) =>
	p
		.then(() => 'ok')
		.catch((e: { code?: string; issues?: { message: string }[] }) =>
			e.issues ? `invalid: ${e.issues[0].message}` : (e.code ?? String(e))
		);
const inT = <T>(m: Member, fn: (tx: Parameters<Parameters<typeof withTenant>[1]>[0]) => Promise<T>) =>
	withTenant(sys(m.tenant as Tenant), fn);
const id = (k: string) => who[k].access.membershipId;

async function member(t: Tenant, key: string, roleKeys: string[], department: string | null) {
	const u = await createUser();
	await sql()`update users set name = ${`${key} person`} where id = ${u.id}`;
	const [e] = await sql()<{ id: string }[]>`
		insert into employees (tenant_id, code, full_name, employment_type, status, join_date, department_id)
		values (${t.id}, ${key}, ${`${key} person`}, 'full_time', 'active', '2024-01-01', ${department}) returning id`;
	const mid = await withTenant(sys(t), async (tx) => {
		const m = await addMember(tx, t.id, u.id, roleKeys);
		await tx.update(memberships).set({ employeeId: e.id }).where(eq(memberships.id, m));
		return m;
	});
	const { token } = await createSession(u.id, {});
	who[key] = {
		user: { userId: u.id, sessionId: sha256(token), totpEnabled: false },
		tenant: { id: t.id, slug: t.slug, name: t.slug },
		access: await loadAccess(t.id, { id: mid, status: 'active', employeeId: e.id })
	} as unknown as Member;
}

const notes = async (membershipId: string, category: string) => {
	const rows = await sql()<{ title: string; link: string }[]>`
		select title, link from notifications where membership_id = ${membershipId} and category = ${category}`;
	return rows;
};

const resetLimits = async () =>
	(await redisReady()).del(
		...Object.values(who).flatMap((m) => [
			rkey('rl', 'kudos', m.access.membershipId),
			rkey('rl', 'comment', m.access.membershipId),
			rkey('rl', 'reaction', m.access.membershipId)
		])
	);

beforeAll(async () => {
	tenant = await createTenant('kud');
	other = await createTenant('kudb');
	await withTenant(sys(), (tx) => seedTenant(tx, tenant.id, TEST_LOCALE));
	await withTenant(sys(other), (tx) => seedTenant(tx, other.id, TEST_LOCALE));
	for (const d of ['A', 'B']) {
		const [row] = await sql()<{ id: string }[]>`
			insert into departments (tenant_id, name) values (${tenant.id}, ${`Dept ${d}`}) returning id`;
		dept[d] = row.id;
	}
	await member(tenant, 'hr', ['hr_admin'], null);
	for (const k of ['a1', 'a2', 'a3']) await member(tenant, k, [], dept.A);
	for (const k of ['b1', 'b2']) await member(tenant, k, [], dept.B);
	await member(other, 'olga', ['owner'], null);
	await resetLimits();
});

afterAll(async () => {
	await resetLimits();
	await closeRedis();
	await closePools();
});

describe('kudos', () => {
	it('thanks colleagues, tells them, and refuses bad recipients', async () => {
		await giveKudos(who.a1, { message: 'Great launch', recipients: [id('a2'), id('b1')] });
		expect(await notes(id('a2'), 'kudos')).toEqual([{ title: 'a1 person gave you kudos', link: 'kudos' }]);
		expect(await notes(id('b1'), 'kudos')).toHaveLength(1);
		expect(await code(giveKudos(who.a1, { message: 'me', recipients: [id('a1')] }))).toBe('self');
		expect(await code(giveKudos(who.a1, { message: 'x', recipients: [id('olga')] }))).toBe('invalid_recipient');
		expect(await code(giveKudos(who.a1, { message: 'x', recipients: [] }))).toBe('invalid: Choose who to thank.');
		expect(
			await code(giveKudos(who.a1, { message: 'x', recipients: Array.from({ length: 11 }, () => crypto.randomUUID()) }))
		).toBe('invalid: Thank at most 10 people at once.');
		expect(await code(giveKudos(who.a1, { message: 'a\0b', recipients: [id('a2')] }))).toBe(
			'invalid: Remove unsupported characters.'
		);
		expect(await code(giveKudos(who.a1, { message: 'x'.repeat(501), recipients: [id('a2')] }))).toBe(
			'invalid: Keep the message under 500 characters.'
		);
		await sql()`update memberships set status = 'ex_employee' where id = ${id('b2')}`;
		try {
			expect(await code(giveKudos(who.a1, { message: 'x', recipients: [id('b2')] }))).toBe('invalid_recipient');
			expect(await code(giveKudos(who.b2, { message: 'x', recipients: [id('a1')] }))).toBe('forbidden');
		} finally {
			await sql()`update memberships set status = 'active' where id = ${id('b2')}`;
		}
	});

	it('only accepts values from the company list', async () => {
		expect(await code(saveKudosValues(who.a1, 'Care'))).toBe('forbidden');
		expect(await code(saveKudosValues(who.hr, 'Care\ncare'))).toBe('invalid: Each value must differ.');
		expect(await code(saveKudosValues(who.hr, 'x'.repeat(41)))).toBe('invalid: Keep each value under 40 characters.');
		await saveKudosValues(who.hr, 'Care\n  Ownership \n\n');
		expect(await code(giveKudos(who.a2, { message: 'x', valueTag: 'Speed', recipients: [id('a3')] }))).toBe(
			'invalid_value'
		);
		await giveKudos(who.a2, { message: 'Owned it', valueTag: 'ownership', recipients: [id('a3')] });
		const page = await inT(who.a2, (tx) => kudosPage(tx, who.a2.access));
		expect(page.values).toEqual(['Care', 'Ownership']);
		expect(page.wall[0]).toMatchObject({ from: 'a2 person', to: ['a3 person'], valueTag: 'Ownership' });
		expect(page.people.map((p) => p.id)).not.toContain(id('a2'));
		const chart = await inT(who.a2, (tx) => kudosMonths(tx));
		expect(chart.values).toEqual(['No value', 'Ownership']);
		expect(chart.months.at(-1)!.counts).toEqual([1, 1]);
	});

	it('lets moderators hide kudos from everyone else, with an audit trail', async () => {
		const [top] = await inT(who.hr, (tx) => kudosWall(tx, who.hr.access));
		expect(await code(hideKudos(who.a1, top.id, true))).toBe('forbidden');
		await hideKudos(who.hr, top.id, true);
		expect((await inT(who.a1, (tx) => kudosWall(tx, who.a1.access))).map((k) => k.id)).not.toContain(top.id);
		expect((await inT(who.hr, (tx) => kudosWall(tx, who.hr.access))).find((k) => k.id === top.id)?.hidden).toBe(true);
		const [{ n }] = await sql()<{ n: number }[]>`
			select count(*)::int as n from audit_log where table_name = 'kudos' and row_id = ${top.id} and op = 'UPDATE' and 'hidden_at' = any(changed_columns)`;
		expect(n).toBe(1);
		await hideKudos(who.hr, top.id, false);
		expect((await inT(who.a1, (tx) => kudosWall(tx, who.a1.access))).map((k) => k.id)).toContain(top.id);
		expect(await code(withTenant(sys(other), () => hideKudos(who.olga, top.id, true)))).toBe('not_found');
	});

	it('buckets the monthly chart in the tenant timezone', async () => {
		await sql()`update tenant_settings set timezone = 'Asia/Dhaka' where tenant_id = ${other.id}`;
		const [{ month }] = await sql()<{ month: string }[]>`
			insert into kudos (tenant_id, from_membership_id, message, created_at)
			values (${other.id}, ${who.olga.access.membershipId}, 'Early bird',
				(date_trunc('month', now() at time zone 'Asia/Dhaka') + interval '30 minutes') at time zone 'Asia/Dhaka')
			returning to_char(now() at time zone 'Asia/Dhaka', 'YYYY-MM') as month`;
		const chart = await withTenant(sys(other), (tx) => kudosMonths(tx));
		expect(chart.months).toEqual([{ month, counts: [1] }]);
	});

	it('limits each person to 20 a day', async () => {
		await resetLimits();
		for (let i = 0; i < 20; i++) await giveKudos(who.a3, { message: `n${i}`, recipients: [id('a1')] });
		expect(await code(giveKudos(who.a3, { message: 'one more', recipients: [id('a1')] }))).toBe('too_many');
	});
});

describe('announcement comments', () => {
	let forA: string;
	let ended: string;
	beforeAll(async () => {
		forA = await saveAnnouncement(who.hr, {
			title: 'Dept A offsite',
			body: 'Friday',
			audience: 'department',
			departmentId: dept.A,
			publishOn: '2024-01-01'
		});
		ended = await saveAnnouncement(who.hr, {
			title: 'Old news',
			body: 'Done',
			audience: 'all',
			publishOn: '2024-01-01',
			expiresOn: '2024-01-02'
		});
	});

	it('is readable and writable only inside the audience', async () => {
		expect(await code(inT(who.b1, (tx) => threadPage(tx, who.b1.access, forA)))).toBe('not_found');
		expect(await code(addComment(who.b1, forA, { body: 'hi', mentions: [] }))).toBe('not_found');
		expect(await code(toggleReaction(who.b1, forA, 'like'))).toBe('not_found');
		expect(await code(withTenant(sys(other), (tx) => threadPage(tx, who.olga.access, forA)))).toBe('not_found');
		expect(await code(addComment(who.a1, ended, { body: 'late', mentions: [] }))).toBe('not_found');
		const page = await inT(who.a1, (tx) => threadPage(tx, who.a1.access, forA));
		expect(page.canWrite).toBe(true);
		expect(page.mentionable.map((p) => p.name)).toEqual(['a2 person', 'a3 person']);
		const hrPage = await inT(who.hr, (tx) => threadPage(tx, who.hr.access, forA));
		expect([hrPage.manager, hrPage.canWrite]).toEqual([true, false]);
	});

	it('notifies mentions inside the audience and rejects others', async () => {
		await addComment(who.a1, forA, { body: 'See you there', mentions: [id('a2')] });
		expect(await notes(id('a2'), 'mentions')).toEqual([
			{ title: 'a1 person mentioned you on "Dept A offsite"', link: `announcements/${forA}/comments` }
		]);
		expect(await code(addComment(who.a1, forA, { body: 'x', mentions: [id('b1')] }))).toBe('invalid_mention');
		expect(await code(addComment(who.a1, forA, { body: 'x', mentions: [id('a1')] }))).toBe('invalid_mention');
		expect(await code(addComment(who.a1, forA, { body: '  ', mentions: [] }))).toBe('invalid: Write a comment.');
		const page = await inT(who.a3, (tx) => threadPage(tx, who.a3.access, forA));
		expect(page.comments).toEqual([
			expect.objectContaining({ author: 'a1 person', body: 'See you there', mentions: ['a2 person'], mine: false })
		]);
	});

	it('counts reactions, toggles them, and shows counts on the feed', async () => {
		await toggleReaction(who.a2, forA, 'like');
		await toggleReaction(who.a3, forA, 'like');
		await toggleReaction(who.a3, forA, 'celebrate');
		await toggleReaction(who.a3, forA, 'celebrate');
		expect(await code(toggleReaction(who.a2, forA, 'angry'))).toBe('invalid: Choose a reaction.');
		const page = await inT(who.a2, (tx) => threadPage(tx, who.a2.access, forA));
		expect(page.reactions.filter((r) => r.count)).toEqual([{ kind: 'like', count: 2, mine: true }]);
		const feed = await inT(who.a2, (tx) => announcementFeed(tx, who.a2.access));
		expect(feed.find((a) => a.id === forA)).toMatchObject({ reactions: 2, comments: 1 });
	});

	it('lets authors delete and managers hide comments', async () => {
		const [c] = (await inT(who.a1, (tx) => threadPage(tx, who.a1.access, forA))).comments;
		expect(await code(deleteComment(who.a2, forA, c.id))).toBe('not_found');
		expect(await code(hideComment(who.a2, forA, c.id, true))).toBe('forbidden');
		await hideComment(who.hr, forA, c.id, true);
		expect((await inT(who.a2, (tx) => threadPage(tx, who.a2.access, forA))).comments).toEqual([]);
		expect((await inT(who.hr, (tx) => threadPage(tx, who.hr.access, forA))).comments[0].hidden).toBe(true);
		await hideComment(who.hr, forA, c.id, false);
		await deleteComment(who.a1, forA, c.id);
		expect((await inT(who.hr, (tx) => threadPage(tx, who.hr.access, forA))).comments).toEqual([]);
		const [{ n }] = await sql()<{ n: number }[]>`
			select count(*)::int as n from audit_log where table_name = 'announcement_comments' and row_id = ${c.id}`;
		expect(n).toBeGreaterThanOrEqual(3);
	});

	it('lets authors delete their own comment even when hidden or expired', async () => {
		await resetLimits();
		const expiring = await saveAnnouncement(who.hr, {
			title: 'Short lived',
			body: 'Soon gone',
			audience: 'all',
			publishOn: '2024-01-01'
		});
		await addComment(who.a3, expiring, { body: 'Mine', mentions: [] });
		const [c] = (await inT(who.a3, (tx) => threadPage(tx, who.a3.access, expiring))).comments;
		await hideComment(who.hr, expiring, c.id, true);
		await sql()`update announcements set expires_on = '2024-01-02' where id = ${expiring}`;
		expect(await code(deleteComment(who.a1, expiring, c.id))).toBe('not_found');
		await deleteComment(who.a3, expiring, c.id);
		const [{ n }] = await sql()<{ n: number }[]>`
			select count(*)::int as n from announcement_comments where id = ${c.id}`;
		expect(n).toBe(0);
		const [{ ops }] = await sql()<{ ops: string[] }[]>`
			select array_agg(op order by op) as ops from audit_log where table_name = 'announcement_comments' and row_id = ${c.id}`;
		expect(ops).toEqual(['DELETE', 'INSERT', 'UPDATE']);
	});

	it('keeps comment and kudos text out of notifications', async () => {
		const [mention] = await sql()<{ body: string }[]>`
			select body from notifications where membership_id = ${id('a2')} and category = 'mentions' limit 1`;
		expect(mention.body).toBe('Open the announcement to read the comment.');
		const [k] = await sql()<{ body: string }[]>`
			select body from notifications where membership_id = ${id('a1')} and category = 'kudos' limit 1`;
		expect(k.body).toBe('Open the kudos wall to read the message.');
	});

	it('shows the newest 500 comments of a long thread', async () => {
		const busy = await saveAnnouncement(who.hr, {
			title: 'Busy',
			body: 'Lots',
			audience: 'all',
			publishOn: '2024-01-01'
		});
		await sql()`
			insert into announcement_comments (tenant_id, announcement_id, author_membership_id, body, created_at)
			select ${tenant.id}, ${busy}, ${id('a1')}, 'c' || g, now() - make_interval(secs => 1000 - g)
			from generate_series(1, 501) g`;
		const page = await inT(who.a1, (tx) => threadPage(tx, who.a1.access, busy));
		expect([page.comments.length, page.comments[0].body, page.comments.at(-1)?.body]).toEqual([500, 'c2', 'c501']);
	});

	it('limits reactions to 30 a minute', async () => {
		await resetLimits();
		for (let i = 0; i < 30; i++) await toggleReaction(who.a2, forA, 'funny');
		expect(await code(toggleReaction(who.a2, forA, 'funny'))).toBe('too_many');
	});

	it('limits comments to 10 a minute', async () => {
		await resetLimits();
		for (let i = 0; i < 10; i++) await addComment(who.a2, forA, { body: `c${i}`, mentions: [] });
		expect(await code(addComment(who.a2, forA, { body: 'more', mentions: [] }))).toBe('too_many');
	});
});

describe('retention', () => {
	it('anonymises a leaver in kudos and comments', async () => {
		await resetLimits();
		const forAll = await saveAnnouncement(who.hr, {
			title: 'All hands',
			body: 'Monday',
			audience: 'all',
			publishOn: '2024-01-01'
		});
		await addComment(who.b2, forAll, { body: 'Thanks', mentions: [id('b1')] });
		await addComment(who.b1, forAll, { body: 'Agreed', mentions: [id('b2'), id('a1')] });
		await toggleReaction(who.b2, forAll, 'love');
		await giveKudos(who.b2, { message: 'From b2', recipients: [id('b1')] });
		await giveKudos(who.b1, { message: 'Only to b2', recipients: [id('b2')] });
		await giveKudos(who.b1, { message: 'To b2 and a1', recipients: [id('b2'), id('a1')] });
		await withTenant(sys(), async (tx) => {
			await forgetKudos(tx, [id('b2')]);
			await forgetCommenters(tx, [id('b2')]);
		});
		const wall = await inT(who.hr, (tx) => kudosWall(tx, who.hr.access, 200));
		expect(wall.find((k) => k.message === 'From b2')).toMatchObject({ from: 'Former employee', to: ['b1 person'] });
		expect(wall.find((k) => k.message === 'Only to b2')).toBeUndefined();
		expect(wall.find((k) => k.message === 'To b2 and a1')).toMatchObject({ to: ['a1 person'] });
		const page = await inT(who.b1, (tx) => threadPage(tx, who.b1.access, forAll));
		expect(page.comments.map((c) => [c.author, c.mentions])).toEqual([
			['Former employee', ['b1 person']],
			['b1 person', ['a1 person']]
		]);
		expect(page.reactions.every((r) => r.count === 0)).toBe(true);
	});
});
