import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePools, ownerPool } from '../../src/lib/server/db';
import { memberships, offers, referralRewards } from '../../src/lib/server/db/schema';
import {
	APPLICATIONS_PER_DAY,
	applyInternal,
	jobBoard,
	referCandidate,
	REFERRALS_PER_DAY,
	rewardList,
	settleReward,
	settleTenantRewards
} from '../../src/lib/server/job-board';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess, userCtx, type requireMember } from '../../src/lib/server/rbac/access';
import {
	decideOffer,
	hireCandidate,
	makeOffer,
	moveCandidate,
	openingView,
	purgeTenantCandidates,
	saveOpening
} from '../../src/lib/server/recruitment';
import { withTestNow } from '../../src/lib/server/clock';
import { closeRedis, redisReady, rkey } from '../../src/lib/server/redis';
import { addSkill, removeSkill, setMySkill, skillsOf, skillsPage, validateSkill } from '../../src/lib/server/skills';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { createTenant, createUser, TEST_LOCALE } from './helpers';

type Member = ReturnType<typeof requireMember>;
type Tenant = { id: string; slug: string };
let tenant: Tenant;
let other: Tenant;
const who: Record<string, Member> = {};
const emp: Record<string, string> = {};
const sql = () => ownerPool().sql;
const code = (p: Promise<unknown>) =>
	p
		.then(() => 'ok')
		.catch((e: { code?: string; issues?: { message: string }[] }) =>
			e.issues ? `invalid: ${e.issues[0].message}` : (e.code ?? String(e))
		);
const mail = (key: string) => `${key}-${tenant.slug}@example.com`;
const board = (k: string) => withTenant(userCtx(who[k]), (tx) => jobBoard(tx, who[k].access));
const skillView = (k: string) => withTenant(userCtx(who[k]), (tx) => skillsPage(tx, who[k].access));

async function member(t: Tenant, key: string, roleKeys: string[], manager: string | null) {
	const u = await createUser();
	const [e] = await sql()<{ id: string }[]>`
		insert into employees (tenant_id, code, full_name, work_email, employment_type, status, join_date, manager_id)
		values (${t.id}, ${key}, ${`${key} person`}, ${`${key}-${t.slug}@example.com`}, 'full_time', 'active',
			'2024-01-01', ${manager}) returning id`;
	emp[key] = e.id;
	const m = await withTenant(systemCtx(t.id), async (tx) => {
		const id = await addMember(tx, t.id, u.id, roleKeys);
		await tx.update(memberships).set({ employeeId: e.id }).where(eq(memberships.id, id));
		return id;
	});
	who[key] = {
		user: { userId: u.id, email: u.email },
		tenant: { id: t.id, slug: t.slug, name: t.slug },
		access: await loadAccess(t.id, { id: m, status: 'active', employeeId: e.id })
	} as unknown as Member;
}

const BUCKETS = ['internal_apply', 'referral'];
const resetLimits = async () =>
	(await redisReady()).del(
		...Object.values(who).flatMap((m) => BUCKETS.map((b) => rkey('rl', b, m.access.membershipId)))
	);

const opening = { title: 'Platform engineer', headcount: '3', status: 'open', visibility: 'internal' };
let ts: string;
let go: string;
let jobId: string;
let hiddenId: string;

beforeAll(async () => {
	tenant = await createTenant('tal');
	other = await createTenant('talb');
	await withTenant(systemCtx(tenant.id), (tx) => seedTenant(tx, tenant.id, TEST_LOCALE));
	await withTenant(systemCtx(other.id), (tx) => seedTenant(tx, other.id, TEST_LOCALE));
	await member(tenant, 'hr', ['hr_admin'], null);
	await member(tenant, 'mgr', ['line_manager'], null);
	await member(tenant, 'emp', [], emp.mgr);
	await member(tenant, 'peer', [], emp.mgr);
	await member(tenant, 'boss', ['line_manager'], null);
	await member(tenant, 'own', ['owner'], null);
	await member(other, 'olga', ['owner'], null);
	await resetLimits();
});

afterAll(async () => {
	await resetLimits();
	await closeRedis();
	await closePools();
});

const skillId = async (name: string) =>
	(await withTenant(userCtx(who.hr), (tx) => skillsPage(tx, who.hr.access))).catalogue.find((c) => c.name === name)!.id;

describe('skills', () => {
	it('keeps a case-insensitive catalogue that only skill managers edit', async () => {
		await addSkill(who.hr, { name: ' TypeScript ' });
		await addSkill(who.hr, { name: 'Go' });
		expect(await code(addSkill(who.hr, { name: 'typescript' }))).toBe('duplicate');
		expect(await code(addSkill(who.hr, { name: 'a\0b' }))).toBe('invalid: Remove unsupported characters.');
		expect(await code(addSkill(who.hr, { name: 'x'.repeat(61) }))).toBe(
			'invalid: Keep the skill name under 60 characters.'
		);
		expect(await code(addSkill(who.emp, { name: 'Rust' }))).toBe('forbidden');
		expect(await code(removeSkill(who.mgr, crypto.randomUUID()))).toBe('forbidden');
		ts = await skillId('TypeScript');
		go = await skillId('Go');
	});

	it('lets employees list skills that a manager in scope validates', async () => {
		await setMySkill(who.emp, { skillId: ts, level: '3' });
		expect(await code(setMySkill(who.emp, { skillId: ts, level: '6' }))).toBe('invalid: Choose a level from 1 to 5.');
		expect(await code(setMySkill(who.emp, { skillId: crypto.randomUUID(), level: '2' }))).toBe('invalid_skill');
		expect(await code(setMySkill(who.olga, { skillId: ts, level: '2' }))).toBe('invalid_skill');

		const pending = (await skillView('mgr')).pending;
		expect(pending.map((p) => [p.employee, p.name, p.level])).toEqual([['emp person', 'TypeScript', 3]]);
		expect((await skillView('boss')).pending).toEqual([]);
		expect((await skillView('peer')).pending).toEqual([]);
		const id = pending[0].id;
		const seen = { id, level: '3' };
		expect(await code(validateSkill(who.boss, seen))).toBe('not_found');
		expect(await code(validateSkill(who.peer, seen))).toBe('not_found');
		expect(await code(validateSkill(who.olga, seen))).toBe('not_found');
		expect(await code(validateSkill(who.mgr, { id, level: '5' }))).toBe('changed');

		await setMySkill(who.hr, { skillId: go, level: '4' });
		const own = (await withTenant(userCtx(who.hr), (tx) => skillsOf(tx, emp.hr)))[0].id;
		expect(await code(validateSkill(who.hr, { id: own, level: '4' }))).toBe('self');

		await validateSkill(who.mgr, seen);
		expect(await code(validateSkill(who.mgr, seen))).toBe('validated');
		expect((await withTenant(userCtx(who.hr), (tx) => skillsOf(tx, emp.emp)))[0].validated).not.toBeNull();
		await setMySkill(who.emp, { skillId: ts, level: '3' });
		expect((await withTenant(userCtx(who.hr), (tx) => skillsOf(tx, emp.emp)))[0].validated).not.toBeNull();

		await setMySkill(who.emp, { skillId: ts, level: '4' });
		const [again] = await withTenant(userCtx(who.hr), (tx) => skillsOf(tx, emp.emp));
		expect([again.level, again.validated]).toEqual([4, null]);

		await sql()`update employees set status = 'exited' where id = ${emp.boss}`;
		expect(await code(setMySkill(who.boss, { skillId: ts, level: '2' }))).toBe('forbidden');
		await sql()`update employees set status = 'active' where id = ${emp.boss}`;
	});
});

describe('internal job board', () => {
	it('saves board fields on the opening and checks them', async () => {
		const ctx = userCtx(who.hr);
		jobId = await saveOpening(ctx, { ...opening, referralBonus: '5000', skillIds: `${ts},${go}` });
		hiddenId = await saveOpening(ctx, { ...opening, title: 'Secret role', visibility: 'none', skillIds: '' });
		expect(await code(saveOpening(ctx, { ...opening, visibility: 'everyone' }))).toBe(
			'invalid: Choose who can see the opening.'
		);
		expect(await code(saveOpening(ctx, { ...opening, referralBonus: '1234567' }))).toBe(
			'invalid: Enter the referral bonus, up to 999999.99.'
		);
		expect(await code(saveOpening(ctx, { ...opening, referralBonus: '-1' }))).toBe(
			'invalid: Enter the referral bonus, up to 999999.99.'
		);
		expect(await code(saveOpening(ctx, { ...opening, skillIds: crypto.randomUUID() }))).toBe('invalid_skill');
		expect(await code(saveOpening(ctx, { ...opening, skillIds: 'nope' }))).toBe(
			'invalid: Choose skills from the catalogue.'
		);
		const olgaSkill = await withTenant(userCtx(who.olga), async (tx) => {
			await addSkill(who.olga, { name: 'Elsewhere' });
			return (await skillsPage(tx, who.olga.access)).catalogue[0].id;
		});
		expect(await code(saveOpening(ctx, { ...opening, skillIds: olgaSkill }))).toBe('invalid_skill');

		const view = await withTenant(ctx, (tx) => openingView(tx, jobId));
		expect([view.opening.visibility, view.opening.referralBonus, view.skillIds.sort()]).toEqual([
			'internal',
			500_000,
			[ts, go].sort()
		]);
		await saveOpening(ctx, { ...opening, openingId: jobId, referralBonus: '5000' });
		expect((await withTenant(ctx, (tx) => openingView(tx, jobId))).skillIds).toHaveLength(2);
	});

	it('lists internal openings with the skill match', async () => {
		const jobs = (await board('emp')).openings;
		expect(jobs.map((j) => [j.title, j.match, j.referralBonus, j.applied])).toEqual([
			['Platform engineer', 50, 500_000, false]
		]);
		expect(jobs[0].skills).toEqual([
			{ name: 'Go', have: false },
			{ name: 'TypeScript', have: true }
		]);
		expect((await board('olga')).openings).toEqual([]);
	});

	it('takes internal applications and tells the manager only on opt-in', async () => {
		await applyInternal(who.emp, { openingId: jobId, tellManager: 'on' });
		for (let i = 0; i < APPLICATIONS_PER_DAY; i++)
			expect(await code(applyInternal(who.emp, { openingId: jobId }))).toBe('duplicate');
		expect(await code(applyInternal(who.emp, { openingId: hiddenId }))).toBe('not_found');
		expect(await code(applyInternal(who.olga, { openingId: jobId }))).toBe('not_found');
		await applyInternal(who.peer, { openingId: jobId });

		const mgrNotes = await sql()<{ title: string }[]>`
			select title from notifications where membership_id = ${who.mgr.access.membershipId} and category = 'jobs'`;
		expect(mgrNotes.map((n) => n.title)).toEqual(['emp person applied for Platform engineer']);

		const mine = await board('emp');
		expect(mine.openings[0].applied).toBe(true);
		expect(mine.applications.map((a) => [a.title, a.stage])).toEqual([['Platform engineer', 'Applied']]);
		const [c] = await sql()<{ source: string; internal: string; email: string; name: string }[]>`
			select source, internal_employee_id as internal, email, full_name as name from candidates
			where internal_employee_id = ${emp.emp}`;
		expect(c).toEqual({ source: 'internal', internal: emp.emp, email: mail('emp'), name: 'emp person' });
	});

	it('takes referrals and blocks self, staff and duplicate referrals', async () => {
		const refer = (k: string, email: string, extra: Record<string, string> = {}) =>
			referCandidate(who[k], { openingId: jobId, fullName: 'Rafi', email, ...extra });
		await refer('peer', `rafi-${tenant.slug}@example.com`, { note: 'Great engineer' });
		expect(await code(refer('mgr', `RAFI-${tenant.slug}@example.com`))).toBe('duplicate');
		expect(await code(refer('peer', mail('peer')))).toBe('self');
		expect(await code(refer('peer', mail('emp').toUpperCase()))).toBe('employee');
		expect(await code(refer('peer', 'not-an-email'))).toBe('invalid: Enter a valid email.');
		expect(await code(refer('peer', `x-${tenant.slug}@example.com`, { openingId: hiddenId }))).toBe('not_found');
		expect(await code(refer('peer', `y-${tenant.slug}@example.com`, { note: 'a\0' }))).toBe(
			'invalid: Remove unsupported characters.'
		);
		const referrals = (await board('peer')).referrals;
		expect(referrals.map((r) => [r.name, r.title, r.stage, r.reward])).toEqual([
			['Rafi', 'Platform engineer', 'Applied', null]
		]);
		expect((await board('emp')).referrals).toEqual([]);
	});

	it('caps referrals per day', async () => {
		await resetLimits();
		for (let i = 0; i < REFERRALS_PER_DAY; i++)
			await referCandidate(who.boss, {
				openingId: jobId,
				fullName: `R${i}`,
				email: `r${i}-${tenant.slug}@example.com`
			});
		expect(
			await code(
				referCandidate(who.boss, { openingId: jobId, fullName: 'Over', email: `over-${tenant.slug}@example.com` })
			)
		).toBe('too_many');
	});
});

describe('hiring from the board', () => {
	const candidate = async (where: string) =>
		(await sql()<{ id: string }[]>`select id from candidates where ${sql().unsafe(where)} limit 1`)[0].id;
	const offerFor = async (candidateId: string) => {
		const ctx = userCtx(who.hr);
		await makeOffer(ctx, { candidateId, monthlyGross: '50000', joinDate: '2030-01-01', expiresOn: '' });
		const [o] = await withTenant(ctx, (tx) => tx.select().from(offers).where(eq(offers.candidateId, candidateId)));
		await decideOffer(ctx, { offerId: o.id, decision: 'accepted' });
	};

	it('moves an internal applicant to Hired without a new employee record', async () => {
		const c = await candidate(`internal_employee_id = '${emp.emp}'`);
		await offerFor(c);
		const before = await sql()<
			{ n: number }[]
		>`select count(*)::int as n from employees where tenant_id = ${tenant.id}`;
		const r = await hireCandidate(who.hr, { candidateId: c, invite: 'on' });
		expect(r).toEqual({
			employeeId: emp.emp,
			invite: 'Hired. Update their department, designation and manager on their profile.'
		});
		const after = await sql()<{ n: number }[]>`select count(*)::int as n from employees where tenant_id = ${tenant.id}`;
		expect(after[0].n).toBe(before[0].n);
		expect((await board('emp')).applications[0].stage).toBe('Hired');
		const stages = (await withTenant(userCtx(who.hr), (tx) => openingView(tx, jobId))).stages;
		expect(
			await code(
				moveCandidate(userCtx(who.hr), { candidateId: c, stageId: stages.find((s) => s.kind === 'active')!.id })
			)
		).toBe('hired');
	});

	it('creates a pending referral reward on hire that only the referrer and payroll see', async () => {
		const c = await candidate(`email = 'rafi-${tenant.slug}@example.com'`);
		await offerFor(c);
		const { employeeId } = await hireCandidate(who.hr, { candidateId: c });
		const [reward] = await sql()<{ status: string; amount: number; due: string; referrer: string; hire: string }[]>`
			select status, amount, to_char(due_on, 'YYYY-MM-DD') as due, employee_id as referrer,
				hired_employee_id as hire from referral_rewards where candidate_id = ${c}`;
		expect(reward).toEqual({
			status: 'pending',
			amount: 500_000,
			due: '2030-04-01',
			referrer: emp.peer,
			hire: employeeId
		});

		expect((await board('peer')).referrals.map((r) => [r.stage, r.reward, r.amount])).toEqual([
			['Hired', 'pending', 500_000]
		]);
		const seen = (k: string) => withTenant(userCtx(who[k]), (tx) => tx.select().from(referralRewards));
		expect(await seen('emp')).toEqual([]);
		expect(await seen('hr')).toEqual([]);
		expect(await withTenant(userCtx(who.hr, { salaryAll: true }), rewardList)).toHaveLength(1);
	});

	it('fills headcount with internal and external hires', async () => {
		const c = await candidate(`internal_employee_id = '${emp.peer}'`);
		await offerFor(c);
		await hireCandidate(who.hr, { candidateId: c });
		const extra = await candidate(`email = 'r0-${tenant.slug}@example.com'`);
		await offerFor(extra);
		expect(await code(hireCandidate(who.hr, { candidateId: extra }))).toBe('headcount_full');
	});

	it('moves rewards to due while the hire stays and voids them when the hire leaves', async () => {
		const [r] = await sql()<{ id: string; hire: string }[]>`
			select id, hired_employee_id as hire from referral_rewards where tenant_id = ${tenant.id}`;
		expect(await settleTenantRewards(tenant.id)).toBe(0);
		await sql()`update referral_rewards set due_on = '2020-01-01' where id = ${r.id}`;
		expect(await settleTenantRewards(tenant.id)).toBe(0);
		await sql()`update employees set status = 'active' where id = ${r.hire}`;
		expect(await settleTenantRewards(tenant.id)).toBe(1);

		expect(await code(settleReward(who.hr, { rewardId: r.id, to: 'paid' }))).toBe('forbidden');
		expect(await code(settleReward(who.olga, { rewardId: r.id, to: 'paid' }))).toBe('not_allowed');
		await settleReward(who.own, { rewardId: r.id, to: 'paid' });
		expect(await code(settleReward(who.own, { rewardId: r.id, to: 'paid' }))).toBe('not_allowed');
		expect(await code(settleReward(who.own, { rewardId: r.id, to: 'void' }))).toBe('not_allowed');
		const [paid] = await sql()<{ status: string; by: string }[]>`
			select status, paid_by_user_id as by from referral_rewards where id = ${r.id}`;
		expect(paid).toEqual({ status: 'paid', by: who.own.user.userId });

		await sql()`update referral_rewards set status = 'pending' where id = ${r.id}`;
		await sql()`update employees set status = 'exited' where id = ${r.hire}`;
		expect(await settleTenantRewards(tenant.id)).toBe(1);
		const [voided] = await sql()<{ status: string }[]>`select status from referral_rewards where id = ${r.id}`;
		expect(voided.status).toBe('void');

		await sql()`update referral_rewards set status = 'pending' where id = ${r.id}`;
		await sql()`update employees set status = 'active' where id = ${r.hire}`;
		await sql()`update employees set status = 'exited' where id = ${emp.peer}`;
		expect(await settleTenantRewards(tenant.id)).toBe(1);
		const [gone] = await sql()<{ status: string }[]>`select status from referral_rewards where id = ${r.id}`;
		expect(gone.status).toBe('void');
		await sql()`update employees set status = 'active' where id = ${emp.peer}`;
	});

	it('never purges internal hires', async () => {
		await sql()`update job_openings set status = 'closed' where id = ${jobId}`;
		const later = new Date(Date.now() + 800 * 86_400_000).toISOString();
		expect(await withTestNow(later, () => purgeTenantCandidates(tenant.id))).toBeGreaterThan(0);
		const left = await sql()<{ n: number }[]>`
			select count(*)::int as n from candidates where opening_id = ${jobId} and internal_employee_id is not null`;
		expect(left[0].n).toBe(2);
	});
});
