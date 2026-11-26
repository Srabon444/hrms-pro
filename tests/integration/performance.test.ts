import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addFiles, openFile } from '../../src/lib/server/attachments';
import { closePools } from '../../src/lib/server/db';
import { memberships, notifications, rolePermissions, roles, reviews } from '../../src/lib/server/db/schema';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from '../../src/lib/server/employees';
import {
	closeCycle,
	createCycle,
	cycleView,
	finaliseReview,
	performanceHome,
	removeGoal,
	reviewView,
	saveGoal,
	shareReview,
	submitManager,
	submitSelf
} from '../../src/lib/server/performance';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess, userCtx, type requireMember } from '../../src/lib/server/rbac/access';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { createTenant, createUser, TEST_LOCALE } from './helpers';

type Member = ReturnType<typeof requireMember>;
const pdf = (name: string) => new File([`%PDF-1.7 ${name}`], name, { type: 'application/pdf' });
let tenant: { id: string; slug: string };
const ids: Record<string, string> = {};
const who: Record<string, Member> = {};
const sys = () => systemCtx(tenant.id);
const code = (p: Promise<unknown>) =>
	p
		.then(() => 'ok')
		.catch((e: { code?: string; issues?: { message: string }[] }) =>
			e.issues ? `invalid: ${e.issues[0].message}` : (e.code ?? String(e))
		);
const blanks = Object.fromEntries(Object.keys({ ...PROFILE_FIELDS, ...EMPLOYMENT_FIELDS }).map((k) => [k, '']));
const creator = {
	membershipId: '',
	employeeId: null,
	grants: { 'employee.read': ['all'], 'employee.create': ['all'], 'employee.update': ['all'] },
	roleKeys: [],
	isOwner: false
};
const hire = (fullName: string, managerId = '', status = 'active') =>
	createEmployee({ tenantId: tenant.id, actor: 'user' }, creator as never, {
		...blanks,
		fullName,
		managerId,
		employmentType: 'full_time',
		status,
		joinDate: '2026-01-01'
	});

async function member(key: string, roleKeys: string[], employeeId: string | null) {
	const u = await createUser();
	const id = await withTenant(sys(), async (tx) => {
		const membershipId = await addMember(tx, tenant.id, u.id, roleKeys);
		await tx.update(memberships).set({ employeeId }).where(eq(memberships.id, membershipId));
		return membershipId;
	});
	who[key] = {
		user: { userId: u.id },
		tenant: { id: tenant.id, slug: tenant.slug, name: tenant.slug },
		access: await loadAccess(tenant.id, { id, status: 'active', employeeId })
	} as unknown as Member;
}

const view = (key: string, id: string) => withTenant(userCtx(who[key]), (tx) => reviewView(tx, who[key].access, id));
const reviewOf = async (cycleId: string, employeeId: string) =>
	(
		await withTenant(sys(), (tx) =>
			tx
				.select()
				.from(reviews)
				.where(and(eq(reviews.cycleId, cycleId), eq(reviews.employeeId, employeeId)))
		)
	)[0];
const inbox = (key: string) =>
	withTenant(sys(), (tx) =>
		tx
			.select({ title: notifications.title })
			.from(notifications)
			.where(eq(notifications.membershipId, who[key].access.membershipId))
	).then((rows) => rows.map((r) => r.title));
const goal = (key: string, reviewId: string, title: string, weight: string, goalId = '') =>
	saveGoal(who[key], { reviewId, goalId, title, target: `${title} target`, weight });

beforeAll(async () => {
	tenant = await createTenant('perf');
	await withTenant(sys(), (tx) => seedTenant(tx, tenant.id, TEST_LOCALE));
	ids.lea = await hire('Lea');
	ids.ana = await hire('Ana', ids.lea);
	ids.ben = await hire('Ben');
	ids.oli = await hire('Oli', '', 'onboarding');
	await member('hr', ['hr_admin'], null);
	await member('lea', ['line_manager'], ids.lea);
	await member('ana', [], ids.ana);
	await member('ben', [], ids.ben);
	await member('rec', ['recruiter'], null);
	await withTenant(sys(), async (tx) => {
		const [r] = await tx.insert(roles).values({ tenantId: tenant.id, key: 'perf_viewer', name: 'Viewer' }).returning();
		await tx
			.insert(rolePermissions)
			.values({ tenantId: tenant.id, roleId: r.id, permission: 'performance.read', scope: 'all' });
	});
	await member('viewer', ['perf_viewer'], null);
});

afterAll(closePools);

describe('performance reviews', () => {
	let cycleId: string;
	let ana: string;
	let ben: string;

	it('lets only HR open a cycle, which creates a review for every current employee', async () => {
		const cycle = { name: 'H2 2026', periodStart: '2026-07-01', periodEnd: '2026-12-31' };
		expect(await code(createCycle(who.lea, cycle))).toBe('forbidden');
		expect(await code(createCycle(who.hr, { ...cycle, periodEnd: '2026-06-30' }))).toBe(
			'invalid: The period must end on or after its start.'
		);
		expect(await code(createCycle(who.hr, { ...cycle, periodEnd: '2026-02-30' }))).toBe(
			'invalid: Choose when the period ends.'
		);
		cycleId = (await createCycle(who.hr, cycle)).cycleId;
		expect(await code(createCycle(who.hr, cycle))).toBe('cycle_exists');
		const people = await withTenant(sys(), (tx) => tx.select().from(reviews).where(eq(reviews.cycleId, cycleId)));
		expect(people.map((p) => p.employeeId).sort()).toEqual([ids.lea, ids.ana, ids.ben].sort());
		ana = (await reviewOf(cycleId, ids.ana)).id;
		ben = (await reviewOf(cycleId, ids.ben)).id;
		expect(await inbox('ana')).toContain('Performance review: H2 2026');
	});

	it('lets the employee and their manager set goals until the self review is sent', async () => {
		expect(await code(goal('ana', ana, 'Ship billing', '60'))).toBe('ok');
		expect(await code(goal('ana', ana, 'Mentor', '50'))).toBe('overweight');
		expect(await code(goal('ana', ana, 'Mentor', '0'))).toBe('invalid: Give the goal a weight from 1 to 100.');
		expect(await code(goal('lea', ana, 'Mentor', '40'))).toBe('ok');
		expect(await code(goal('ben', ana, 'Sneak', '1'))).toBe('not_found');
		expect(await code(goal('rec', ana, 'Sneak', '1'))).toBe('not_found');
		expect(await code(goal('viewer', ana, 'Sneak', '1'))).toBe('not_allowed');
		const [billing, mentor] = (await view('ana', ana))!.goals;
		expect([billing.title, mentor.title, mentor.weight]).toEqual(['Ship billing', 'Mentor', 40]);
		expect(await code(goal('lea', ana, 'Mentor juniors', '40', mentor.id))).toBe('ok');
		expect(await code(goal('ana', ben, 'Sneak', '1', mentor.id))).toBe('not_found');
		const [plan] = await addFiles(who.lea, 'goal', mentor.id, [pdf('plan.pdf')]);
		expect((await openFile(who.viewer, plan)).fileName).toBe('plan.pdf');
		expect(await code(openFile(who.ben, plan))).toBe('not_found');
		expect(await code(addFiles(who.viewer, 'goal', mentor.id, [pdf('x.pdf')]))).toBe('forbidden');
		expect(await code(removeGoal(who.ana, { reviewId: ana, goalId: mentor.id }))).toBe('ok');
		expect(await code(openFile(who.lea, plan))).toBe('not_found');
		expect(await code(goal('lea', ana, 'Mentor juniors', '40'))).toBe('ok');

		const goals = (await view('ana', ana))!.goals;
		const form = Object.fromEntries(goals.flatMap((g) => [[`actual.${g.id}`, `done ${g.title}`]]));
		expect(await code(submitSelf(who.ana, { reviewId: ana, ...form }))).toBe(
			'invalid: Rate yourself from 1 to 5 on every goal.'
		);
		expect(await code(submitSelf(who.lea, { reviewId: ana, ...form }))).toBe('not_allowed');
		const rated = { ...form, ...Object.fromEntries(goals.map((g) => [`rating.${g.id}`, '4'])) };
		const [proof] = await addFiles(who.ana, 'review', ana, [pdf('proof.pdf')]);
		expect(await code(addFiles(who.lea, 'review', ana, [pdf('x.pdf')]))).toBe('forbidden');
		expect(await code(addFiles(who.ben, 'review', ana, [pdf('x.pdf')]))).toBe('not_found');
		expect(await code(submitSelf(who.ana, { reviewId: ana, comments: 'Good half', ...rated }))).toBe('ok');
		expect(await code(addFiles(who.ana, 'review', ana, [pdf('x.pdf')]))).toBe('forbidden');
		expect(await code(addFiles(who.lea, 'review', ana, [pdf('notes.pdf')]))).toBe('ok');
		expect((await openFile(who.lea, proof)).fileName).toBe('proof.pdf');
		expect((await reviewOf(cycleId, ids.ana)).stage).toBe('manager');
		expect(await inbox('lea')).toContain('Self review sent: Ana');
		expect(await code(goal('ana', ana, 'Late', '1'))).toBe('not_allowed');
		expect(await code(submitSelf(who.ana, { reviewId: ana, ...rated }))).toBe('not_allowed');

		expect(await code(submitSelf(who.ben, { reviewId: ben }))).toBe('no_goals');
		await goal('ben', ben, 'Docs', '50');
		expect(await code(submitSelf(who.ben, { reviewId: ben }))).toBe('weights');
	});

	it('scores the manager ratings, and the employee sees them only once HR shares the review', async () => {
		const goals = (await view('lea', ana))!.goals;
		expect(goals.map((g) => [g.actual, g.selfRating])).toEqual([
			['done Ship billing', 4],
			['done Mentor juniors', 4]
		]);
		const lea = await withTenant(userCtx(who.lea), (tx) => performanceHome(tx, who.lea.access));
		expect(lea.toReview.map((r) => r.name)).toEqual(['Ana']);
		const ratings = { [`rating.${goals[0].id}`]: '4', [`rating.${goals[1].id}`]: '3' };
		expect(await code(submitManager(who.ana, { reviewId: ana, ...ratings }))).toBe('not_allowed');
		expect(await code(submitManager(who.ben, { reviewId: ana, ...ratings }))).toBe('not_found');
		expect(await code(submitManager(who.lea, { reviewId: ana, [`rating.${goals[0].id}`]: '4' }))).toBe(
			'invalid: Rate the employee from 1 to 5 on every goal.'
		);
		expect(await code(finaliseReview(who.hr, { reviewId: ana }))).toBe('not_allowed');
		expect(await code(submitManager(who.lea, { reviewId: ana, comments: 'Solid', ...ratings }))).toBe('ok');
		expect((await reviewOf(cycleId, ids.ana)).score).toBe(360);

		const hr = await withTenant(userCtx(who.hr), (tx) => performanceHome(tx, who.hr.access));
		expect(hr.toFinalise.map((r) => r.name)).toEqual(['Ana']);
		expect(await code(finaliseReview(who.lea, { reviewId: ana }))).toBe('not_allowed');
		expect(await code(shareReview(who.hr, { reviewId: ana }))).toBe('not_allowed');
		expect(await code(finaliseReview(who.hr, { reviewId: ana }))).toBe('ok');

		const hidden = (await view('ana', ana))!;
		expect([hidden.review.score, hidden.review.managerComments, hidden.goals[0].managerRating]).toEqual([
			null,
			'',
			null
		]);
		const row = await withTenant(userCtx(who.ana), (tx) => cycleView(tx, who.ana.access, cycleId, 1));
		expect(row!.rows.map((r) => [r.name, r.score])).toEqual([['Ana', null]]);
		expect((await view('lea', ana))!.review.score).toBe(360);
		expect(await inbox('ana')).not.toContain('Your H2 2026 review is ready');

		expect(await code(shareReview(who.hr, { reviewId: ana }))).toBe('ok');
		const shown = (await view('ana', ana))!;
		expect([shown.review.score, shown.review.managerComments, shown.goals[1].managerRating]).toEqual([360, 'Solid', 3]);
		expect(await inbox('ana')).toContain('Your H2 2026 review is ready');
		expect(await code(shareReview(who.hr, { reviewId: ana }))).toBe('not_allowed');
	});

	it('hides reviews outside the viewer scope and freezes them once the cycle closes', async () => {
		expect(await view('ben', ana)).toBeNull();
		expect(await view('rec', ana)).toBeNull();
		const team = await withTenant(userCtx(who.lea), (tx) => cycleView(tx, who.lea.access, cycleId, 1));
		expect(team!.rows.map((r) => r.name)).toEqual(['Ana', 'Lea']);
		const lea = (await reviewOf(cycleId, ids.lea)).id;
		const anaGoal = (await view('ana', ana))!.goals[0];
		expect(await code(goal('lea', lea, 'Hijack', '10', anaGoal.id))).toBe('not_found');
		expect(await code(removeGoal(who.lea, { reviewId: lea, goalId: anaGoal.id }))).toBe('not_found');
		expect((await view('ana', ana))!.goals[0].title).toBe('Ship billing');
		await goal('lea', lea, 'Grow the team', '100');
		const [own] = (await view('lea', lea))!.goals;
		expect(await code(submitSelf(who.lea, { reviewId: lea, [`rating.${own.id}`]: '5' }))).toBe('ok');
		expect(await code(submitManager(who.lea, { reviewId: lea, [`rating.${own.id}`]: '5' }))).toBe('not_allowed');
		const queue = async (key: string) =>
			(await withTenant(userCtx(who[key]), (tx) => performanceHome(tx, who[key].access))).toReview.map((r) => r.name);
		expect(await queue('lea')).toEqual([]);
		expect(await queue('hr')).toEqual(['Lea']);
		expect(await code(closeCycle(who.lea, { cycleId }))).toBe('forbidden');
		expect(await code(closeCycle(who.hr, { cycleId }))).toBe('ok');
		expect(await code(closeCycle(who.hr, { cycleId }))).toBe('closed');
		expect(await code(goal('ben', ben, 'More docs', '50'))).toBe('closed');
		expect(await queue('hr')).toEqual([]);
	});
});
