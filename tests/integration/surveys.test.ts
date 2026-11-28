import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from '../../src/lib/server/auth/crypto';
import { createSession } from '../../src/lib/server/auth/session';
import { closePools, ownerPool } from '../../src/lib/server/db';
import { memberships, notifications, surveyAnswers, surveyParticipation } from '../../src/lib/server/db/schema';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess, type requireMember } from '../../src/lib/server/rbac/access';
import { closeRedis, redisReady, rkey } from '../../src/lib/server/redis';
import {
	closeSurvey,
	createSurvey,
	deleteSurvey,
	forgetLeavers,
	openSurvey,
	remindSurvey,
	submitSuggestion,
	submitSurvey,
	suggestionsPage,
	surveyPage,
	surveyResults,
	surveysPage
} from '../../src/lib/server/surveys';
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

async function member(t: Tenant, key: string, roleKeys: string[], department: string | null) {
	const u = await createUser();
	await sql()`update users set name = ${`${key} person`} where id = ${u.id}`;
	const [e] = await sql()<{ id: string }[]>`
		insert into employees (tenant_id, code, full_name, employment_type, status, join_date, department_id)
		values (${t.id}, ${key}, ${`${key} person`}, 'full_time', 'active', '2024-01-01', ${department}) returning id`;
	const id = await withTenant(sys(t), async (tx) => {
		const mid = await addMember(tx, t.id, u.id, roleKeys);
		await tx.update(memberships).set({ employeeId: e.id }).where(eq(memberships.id, mid));
		return mid;
	});
	const { token } = await createSession(u.id, {});
	who[key] = {
		user: { userId: u.id, sessionId: sha256(token), totpEnabled: false },
		tenant: { id: t.id, slug: t.slug, name: t.slug },
		access: await loadAccess(t.id, { id, status: 'active', employeeId: e.id })
	} as unknown as Member;
}

const QUESTIONS = JSON.stringify([
	{ kind: 'enps', prompt: 'Recommend us?', required: true },
	{ kind: 'scale', prompt: 'I feel heard.', required: true },
	{ kind: 'choice', prompt: 'Best perk?', options: ['Lunch', 'Remote'], required: false },
	{ kind: 'text', prompt: 'Anything else?', required: false }
]);

const draft = (extra: Record<string, string> = {}) =>
	createSurvey(who.hr, {
		title: `Pulse ${randomUUID().slice(0, 4)}`,
		intro: '',
		anonymous: 'on',
		audience: 'all',
		closesOn: '2099-12-31',
		minGroupSize: '5',
		questions: QUESTIONS,
		...extra
	});

async function answersOf(id: string) {
	const page = await inT(who.hr, (tx) => surveyPage(tx, who.hr.access, id));
	const [enps, scale, choice, text] = page.questions;
	return (n: number, extra: Record<string, string> = {}) => ({
		[`q_${enps.id}`]: String(n),
		[`q_${scale.id}`]: String(1 + (n % 5)),
		[`q_${choice.id}`]: String(n % 2),
		[`q_${text.id}`]: `note ${n}`,
		...extra
	});
}

const ANON = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'b1', 'b2', 'b3', 'b4', 'b5', 'c1', 'c2'];

beforeAll(async () => {
	tenant = await createTenant('srv');
	other = await createTenant('srvb');
	await withTenant(sys(), (tx) => seedTenant(tx, tenant.id, TEST_LOCALE));
	await withTenant(sys(other), (tx) => seedTenant(tx, other.id, TEST_LOCALE));
	for (const d of ['A', 'B', 'C']) {
		const [row] = await sql()<{ id: string }[]>`
			insert into departments (tenant_id, name) values (${tenant.id}, ${`Dept ${d}`}) returning id`;
		dept[d] = row.id;
	}
	await member(tenant, 'hr', ['hr_admin'], null);
	for (const k of ANON) await member(tenant, k, [], dept[k[0].toUpperCase()]);
	await member(other, 'olga', ['owner'], null);
	const day = new Date().toISOString().slice(0, 10);
	await (
		await redisReady()
	).del(...Object.values(who).map((m) => rkey('rl', 'suggestion', `${m.access.membershipId}:${day}`)));
});

afterAll(async () => {
	await closeRedis();
	await closePools();
});

describe('creating and opening', () => {
	it('validates the survey and keeps it to managers', async () => {
		expect(await code(draft({ questions: '[]' }))).toBe('invalid: Add at least one question.');
		expect(await code(draft({ questions: 'nope' }))).toBe('invalid: Add at least one question.');
		expect(await code(draft({ questions: JSON.stringify([{ kind: 'choice', prompt: 'x', options: ['only'] }]) }))).toBe(
			'invalid: Give each choice question two or more choices.'
		);
		expect(await code(draft({ minGroupSize: '3' }))).toBe('invalid: The smallest group must be at least 5.');
		expect(await code(draft({ closesOn: '2020-01-01' }))).toBe('past_close');
		expect(await code(draft({ audience: 'department', departmentId: randomUUID() }))).toBe('invalid_department');
		expect(await code(createSurvey(who.a1, { title: 'x' }))).toBe('forbidden');
	});

	it('refuses to open an anonymous survey for a group smaller than the limit', async () => {
		const small = await draft({ audience: 'department', departmentId: dept.C });
		expect(await code(openSurvey(who.hr, small))).toBe('audience_too_small');
		const named = await draft({ audience: 'department', departmentId: dept.C, anonymous: '' });
		expect(await code(openSurvey(who.hr, named))).toBe('ok');
		expect(await code(openSurvey(who.olga, small))).toBe('not_found');
	});

	it('tells the audience when it opens and only shows it to them', async () => {
		const id = await draft({ audience: 'department', departmentId: dept.A, minGroupSize: '5' });
		await openSurvey(who.hr, id);
		const told = await inT(who.hr, (tx) =>
			tx
				.select({ m: notifications.membershipId })
				.from(notifications)
				.where(and(eq(notifications.category, 'surveys'), eq(notifications.link, `surveys/${id}`)))
		);
		expect(told.map((r) => r.m).sort()).toEqual(
			['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map((k) => who[k].access.membershipId).sort()
		);
		expect((await inT(who.a1, (tx) => surveysPage(tx, who.a1.access))).mine.map((s) => s.id)).toContain(id);
		expect((await inT(who.b1, (tx) => surveysPage(tx, who.b1.access))).mine.map((s) => s.id)).not.toContain(id);
		expect(await code(inT(who.b1, (tx) => surveyPage(tx, who.b1.access, id)))).toBe('not_found');
		expect(await code(submitSurvey(who.b1, id, {}))).toBe('not_open');
		expect(await code(withTenant(sys(other), (tx) => surveyPage(tx, who.olga.access, id)))).toBe('not_found');
	});
});

describe('anonymous answers', () => {
	let id: string;
	beforeAll(async () => {
		id = await draft();
		await openSurvey(who.hr, id);
	});

	it('stores answers with no person and refuses a second response', async () => {
		const a = await answersOf(id);
		expect(await code(submitSurvey(who.a1, id, { ...a(10), [Object.keys(a(10))[0]]: '' }))).toBe('invalid');
		const [{ n: none }] = await sql()<{ n: number }[]>`
			select count(*)::int as n from survey_participation where survey_id = ${id}`;
		expect(none).toBe(0);
		await submitSurvey(who.a1, id, a(10));
		expect(await code(submitSurvey(who.a1, id, a(9)))).toBe('answered');
		const rows = await sql()<{ membership_id: string | null; n: number }[]>`
			select membership_id, count(*)::int as n from survey_answers where survey_id = ${id} group by 1`;
		expect(rows).toEqual([{ membership_id: null, n: 4 }]);
		const cols = await sql()<{ column_name: string }[]>`
			select column_name from information_schema.columns where table_name = 'survey_answers'`;
		expect(cols.map((c) => c.column_name)).not.toContain('created_at');
		expect(cols.map((c) => c.column_name)).not.toContain('participation_id');
		const page = await inT(who.a1, (tx) => surveyPage(tx, who.a1.access, id));
		expect([page.canAnswer, page.answered]).toEqual([false, true]);
	});

	it('hides results until it closes and enough people answered', async () => {
		expect((await inT(who.hr, (tx) => surveyResults(tx, who.hr.access, id, null))).ready).toBe(false);
		const a = await answersOf(id);
		await Promise.all(['a2', 'a3'].map((k, i) => submitSurvey(who[k], id, a(i))));
		await closeSurvey(who.hr, id);
		const few = await inT(who.hr, (tx) => surveyResults(tx, who.hr.access, id, null));
		expect(few).toMatchObject({ ready: false, reason: 'too_few', responses: 3 });
		expect(await code(submitSurvey(who.a4, id, a(1)))).toBe('not_open');
		expect(await code(inT(who.a1, (tx) => surveyResults(tx, who.a1.access, id, null)))).toBe('forbidden');
	});

	it('keeps no trace that pairs a person with their answers', async () => {
		const xmins = await sql()<{ t: string; x: string; d: string | null }[]>`
			select 'p' as t, xmin::text as x, null as d from survey_participation where survey_id = ${id}
			union all select 'a', xmin::text, slice_department_id::text from survey_answers
			where survey_id = ${id} and value_text is not null`;
		const p = new Set(xmins.filter((r) => r.t === 'p').map((r) => r.x));
		expect(p.size).toBe(1);
		expect(xmins.filter((r) => r.t === 'a').every((r) => r.d === null)).toBe(true);
		const cols = await sql()<{ column_name: string }[]>`
			select column_name from information_schema.columns where table_name = 'survey_participation'`;
		expect(cols.map((c) => c.column_name).sort()).toEqual(['id', 'membership_id', 'survey_id', 'tenant_id']);
	});

	it('writes nothing to the audit log', async () => {
		const [{ n }] = await sql()<{ n: number }[]>`
			select count(*)::int as n from audit_log
			where tenant_id = ${tenant.id} and table_name in ('survey_answers', 'survey_participation')`;
		expect(n).toBe(0);
	});
});

describe('results', () => {
	let id: string;
	beforeAll(async () => {
		id = await draft();
		await openSurvey(who.hr, id);
		const a = await answersOf(id);
		const scores: Record<string, number> = {
			a1: 10,
			a2: 10,
			a3: 9,
			a4: 8,
			a5: 6,
			a6: 3,
			b1: 10,
			b2: 9,
			b3: 7,
			b4: 7,
			b5: 0,
			c1: 10,
			c2: 0
		};
		await Promise.all(Object.entries(scores).map(([k, n]) => submitSurvey(who[k], id, a(n))));
		await closeSurvey(who.hr, id);
	});

	it('scores eNPS and hides small and complementary slices', async () => {
		const r = await inT(who.hr, (tx) => surveyResults(tx, who.hr.access, id, 'department'));
		if (!r.ready) throw new Error('not ready');
		expect(r.responses).toBe(13);
		const [enps, scale, choice, text] = r.questions;
		expect(enps.enps).toEqual({ total: 13, promoters: 46, passives: 23, detractors: 31, score: 15 });
		expect(scale.total).toBe(13);
		expect(choice.dist.reduce((x, y) => x + y, 0)).toBe(13);
		expect(text.texts).toHaveLength(13);
		expect(text.texts.every((t) => t.name === null)).toBe(true);
		expect(text.slices).toEqual([]);
		const slices = Object.fromEntries(enps.slices.map((s) => [s.label, s.hidden ? 'hidden' : s.total]));
		expect(slices).toEqual({ 'Dept A': 6, 'Dept B': 'hidden', 'Other or not set': 'hidden' });
		const byBranch = await inT(who.hr, (tx) => surveyResults(tx, who.hr.access, id, 'branch'));
		if (!byBranch.ready) throw new Error('not ready');
		expect(byBranch.questions[0].slices).toEqual([
			expect.objectContaining({ label: 'Other or not set', total: 13, hidden: false })
		]);
	});
});

describe('named surveys', () => {
	it('show results while open with names on written answers', async () => {
		const id = await draft({ anonymous: '', audience: 'department', departmentId: dept.C });
		await openSurvey(who.hr, id);
		const a = await answersOf(id);
		await submitSurvey(who.c1, id, a(7));
		const r = await inT(who.hr, (tx) => surveyResults(tx, who.hr.access, id, 'department'));
		if (!r.ready) throw new Error('not ready');
		expect(r.questions[3].texts).toEqual([{ text: 'note 7', name: 'c1 person' }]);
		expect(r.questions[0].slices).toEqual([expect.objectContaining({ label: 'Dept C', total: 1, hidden: false })]);
		const [row] = await sql()<{ membership_id: string }[]>`
			select membership_id from survey_answers where survey_id = ${id} limit 1`;
		expect(row.membership_id).toBe(who.c1.access.membershipId);
	});
});

describe('who may answer', () => {
	it('refuses people who are no longer active and bad input', async () => {
		const id = await draft();
		await openSurvey(who.hr, id);
		await sql()`update memberships set status = 'ex_employee' where id = ${who.c2.access.membershipId}`;
		try {
			expect(await code(submitSurvey(who.c2, id, (await answersOf(id))(3)))).toBe('not_open');
			expect(await code(inT(who.c2, (tx) => surveyPage(tx, who.c2.access, id)))).toBe('not_found');
			expect((await inT(who.c2, (tx) => surveysPage(tx, who.c2.access))).mine).toEqual([]);
		} finally {
			await sql()`update memberships set status = 'active' where id = ${who.c2.access.membershipId}`;
		}
		const a = await answersOf(id);
		expect(await code(submitSurvey(who.c2, id, a(3, { [Object.keys(a(3))[3]]: 'x\0y' })))).toBe('invalid');
		expect(await code(draft({ title: 'bad\0title' }))).toBe('invalid: Remove unsupported characters.');
		expect(await code(submitSuggestion(who.c2, 'bad\0'))).toBe('invalid: Remove unsupported characters.');
		const named = await draft({ anonymous: 'true' });
		const [row] = await sql()<{ anonymous: boolean }[]>`select anonymous from surveys where id = ${named}`;
		expect(row.anonymous).toBe(true);
	});
});

describe('reminders', () => {
	it('go only to people who have not answered, at most twice', async () => {
		const id = await draft({ audience: 'department', departmentId: dept.A });
		await openSurvey(who.hr, id);
		await submitSurvey(who.a1, id, (await answersOf(id))(5));
		expect(await remindSurvey(who.hr, id)).toBe(5);
		const told = await inT(who.hr, (tx) =>
			tx
				.select({ m: notifications.membershipId })
				.from(notifications)
				.where(eq(notifications.link, `surveys/${id}`))
		);
		expect(told.filter((t) => t.m === who.a1.access.membershipId)).toHaveLength(1);
		await remindSurvey(who.hr, id);
		expect(await code(remindSurvey(who.hr, id))).toBe('reminders_used');
		const full = await draft({ audience: 'department', departmentId: dept.A, anonymous: '' });
		await openSurvey(who.hr, full);
		const fa = await answersOf(full);
		await Promise.all(['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map((k, i) => submitSurvey(who[k], full, fa(i))));
		expect(await remindSurvey(who.hr, full)).toBe(0);
		const [{ sent }] = await sql()<{ sent: number }[]>`select reminders_sent as sent from surveys where id = ${full}`;
		expect(sent).toBe(0);
		await deleteSurvey(who.hr, id);
		const [{ n }] = await sql()<{ n: number }[]>`select count(*)::int as n from survey_answers where survey_id = ${id}`;
		expect(n).toBe(0);
	});
});

describe('suggestion box', () => {
	it('releases suggestions only in batches of the group size', async () => {
		const send = (k: string, i: number) => submitSuggestion(who[k], `idea ${k} ${i}`);
		await Promise.all(['a1', 'a2', 'a3', 'a4'].map((k) => send(k, 1)));
		const page = () => inT(who.hr, (tx) => suggestionsPage(tx, who.hr.access, tenant.id));
		expect((await page()).entries).toEqual([]);
		await send('a5', 1);
		const first = await page();
		expect(first.entries).toHaveLength(5);
		expect(first.batches).toBe(1);
		await send('a6', 1);
		expect((await page()).entries).toHaveLength(5);
		const rows = await sql()<{ membership_id: string | null }[]>`
			select a.membership_id from survey_answers a join surveys s on s.id = a.survey_id
			where s.tenant_id = ${tenant.id} and s.kind = 'suggestion'`;
		expect(rows.every((r) => r.membership_id === null)).toBe(true);
		expect(await code(inT(who.a1, (tx) => suggestionsPage(tx, who.a1.access, tenant.id)))).toBe('forbidden');
		const trail = await sql()<{ actor: string | null }[]>`
			select actor_user_id::text as actor from audit_log
			where tenant_id = ${tenant.id} and table_name in ('surveys', 'survey_questions')
			and row_id in (select id from surveys where kind = 'suggestion' and tenant_id = ${tenant.id}
				union select q.id from survey_questions q join surveys s on s.id = q.survey_id
				where s.kind = 'suggestion' and s.tenant_id = ${tenant.id})`;
		const suggesters = new Set(['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map((k) => who[k].user.userId));
		expect(trail.length).toBeGreaterThan(0);
		expect(trail.some((t) => t.actor && suggesters.has(t.actor))).toBe(false);
		expect(await code(submitSuggestion(who.b1, '  '))).toMatch(/^invalid/);
	});

	it('limits each person to five a day', async () => {
		await Promise.all([1, 2, 3, 4].map((i) => submitSuggestion(who.b2, `more ${i}`)));
		expect(await code(submitSuggestion(who.b2, 'fifth'))).toBe('ok');
		expect(await code(submitSuggestion(who.b2, 'sixth'))).toBe('too_many');
	});
});

describe('retention', () => {
	it('forgets who answered and named answers once a leaver is gone, keeping anonymous answers', async () => {
		const anon = await draft();
		await openSurvey(who.hr, anon);
		await submitSurvey(who.b3, anon, (await answersOf(anon))(4));
		const named = await draft({ anonymous: '' });
		await openSurvey(who.hr, named);
		await submitSurvey(who.b3, named, (await answersOf(named))(4));
		await withTenant(sys(), (tx) => forgetLeavers(tx, [who.b3.access.membershipId]));
		const left = await inT(who.hr, (tx) =>
			tx
				.select({ id: surveyParticipation.id })
				.from(surveyParticipation)
				.where(eq(surveyParticipation.membershipId, who.b3.access.membershipId))
		);
		expect(left).toEqual([]);
		const kept = await inT(who.hr, (tx) =>
			tx
				.select({ survey: surveyAnswers.surveyId })
				.from(surveyAnswers)
				.where(inArray(surveyAnswers.surveyId, [anon, named]))
		);
		expect(kept.filter((k) => k.survey === anon)).toHaveLength(4);
		expect(kept.filter((k) => k.survey === named)).toHaveLength(0);
	});

	it('keeps closed anonymous results visible after a leaver is forgotten', async () => {
		const id = await draft();
		await openSurvey(who.hr, id);
		const a = await answersOf(id);
		const five = ['a1', 'a2', 'a3', 'a4', 'a5'];
		await Promise.all(five.map((k, i) => submitSurvey(who[k], id, a(i))));
		await closeSurvey(who.hr, id);
		await withTenant(sys(), (tx) => forgetLeavers(tx, [who.a5.access.membershipId]));
		const r = await inT(who.hr, (tx) => surveyResults(tx, who.hr.access, id, null));
		expect(r).toMatchObject({ ready: true, responses: 5 });
	});
});
