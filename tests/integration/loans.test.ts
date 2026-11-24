import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePools } from '../../src/lib/server/db';
import { employees, loanInstalments, loans, memberships, tenantSettings } from '../../src/lib/server/db/schema';
import { addMonths } from '../../src/lib/server/dates';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from '../../src/lib/server/employees';
import { tenantToday } from '../../src/lib/server/lifecycle';
import { cancelLoan, decideLoan, loanApprovals, loanBoard, requestLoan } from '../../src/lib/server/loans';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess, type requireMember } from '../../src/lib/server/rbac/access';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { createTenant, createUser } from './helpers';

type Member = ReturnType<typeof requireMember>;
let tenant: { id: string; slug: string };
let month: string;
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
const hire = (fullName: string) =>
	createEmployee({ tenantId: tenant.id, actor: 'user' }, creator as never, {
		...blanks,
		fullName,
		employmentType: 'full_time',
		status: 'active',
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

const ask = (key: string, extra: Record<string, string> = {}) =>
	requestLoan(who[key], {
		kind: 'loan',
		amount: '10000',
		instalments: '3',
		startPeriod: month,
		reason: 'Family need',
		...extra
	});
const decide = (key: string, loanId: string, decision = 'approve', note = '') =>
	decideLoan(who[key], { loanId, decision, note });
const loanOf = async (id: string) =>
	(await withTenant(sys(), (tx) => tx.select().from(loans).where(eq(loans.id, id))))[0];
const scheduleOf = (loanId: string) =>
	withTenant(sys(), (tx) =>
		tx
			.select({ period: loanInstalments.period, amount: loanInstalments.amount, status: loanInstalments.status })
			.from(loanInstalments)
			.where(eq(loanInstalments.loanId, loanId))
			.orderBy(loanInstalments.period)
	);

beforeAll(async () => {
	tenant = await createTenant('loans');
	await withTenant(sys(), (tx) => seedTenant(tx, tenant.id));
	month = (await withTenant(sys(), tenantToday)).slice(0, 7);
	ids.ana = await hire('Ana');
	ids.ben = await hire('Ben');
	ids.fin = await hire('Fin');
	await member('ana', ['employee'], ids.ana);
	await member('ben', ['employee'], ids.ben);
	await member('fin', ['finance', 'employee'], ids.fin);
	await member('fin2', ['finance'], null);
});

afterAll(closePools);

describe('requesting', () => {
	it('validates the request on the server', async () => {
		expect(await code(ask('ana', { amount: '0' }))).toMatch(/more than zero/);
		expect(await code(ask('ana', { amount: '12.345' }))).toMatch(/2 decimals/);
		expect(await code(ask('ana', { instalments: '0' }))).toMatch(/at least one/);
		expect(await code(ask('ana', { instalments: '61' }))).toMatch(/at most 60/);
		expect(await code(ask('ana', { instalments: '1.5' }))).toMatch(/whole number/);
		expect(await code(ask('ana', { kind: 'gift' }))).toMatch(/loan or advance/);
		expect(await code(ask('ana', { startPeriod: '2026-13' }))).toMatch(/repayment month/);
		expect(await code(ask('ana', { startPeriod: addMonths(month, -1) }))).toBe('past_start');
		expect(await code(ask('ana', { reason: ' ' }))).toMatch(/reason/);
		expect(await code(ask('ana', { amount: '5', instalments: '6' }))).toBe('tiny_instalment');
		expect(await code(ask('ana', { amount: '6', instalments: '6' }))).toBe('ok');
		await withTenant(sys(), (tx) => tx.delete(loans).where(eq(loans.employeeId, ids.ana)));
	});

	it('caps instalments at the organisation limit', async () => {
		await withTenant(sys(), (tx) => tx.update(tenantSettings).set({ loanMaxInstalments: 6 }));
		try {
			expect(await code(ask('ana', { instalments: '7' }))).toBe('too_many_instalments');
			expect((await withTenant(sys(), (tx) => loanBoard(tx, who.ana))).maxInstalments).toBe(6);
		} finally {
			await withTenant(sys(), (tx) => tx.update(tenantSettings).set({ loanMaxInstalments: 60 }));
		}
	});

	it('allows one waiting request per person and refuses leavers and non-employees', async () => {
		const id = await ask('ana');
		expect(await loanOf(id)).toMatchObject({ status: 'requested', amount: 1000000, instalments: 3, kind: 'loan' });
		expect(await code(ask('ana'))).toBe('pending_exists');
		expect(await code(cancelLoan(who.ben, { loanId: id }))).toBe('not_found');
		expect(await code(cancelLoan(who.ana, { loanId: id }))).toBe('ok');
		expect(await code(cancelLoan(who.ana, { loanId: id }))).toBe('decided');
		expect((await loanOf(id)).status).toBe('cancelled');
		expect(await code(ask('ana'))).toBe('ok');
		await withTenant(sys(), (tx) => tx.delete(loans).where(eq(loans.employeeId, ids.ana)));

		await withTenant(sys(), (tx) =>
			tx.update(employees).set({ status: 'exited', exitDate: '2026-03-01' }).where(eq(employees.id, ids.ben))
		);
		expect(await code(ask('ben'))).toBe('exited');
		await withTenant(sys(), (tx) =>
			tx.update(employees).set({ status: 'active', exitDate: null }).where(eq(employees.id, ids.ben))
		);
		expect(await code(ask('fin2'))).toBe('no_employee');
	});
});

describe('deciding', () => {
	it('schedules whole-taka instalments from the first month and tells the employee', async () => {
		const id = await ask('ana', { amount: '10000.50', startPeriod: addMonths(month, 1) });
		const inbox = await withTenant(sys(), (tx) => loanApprovals(tx, who.fin.access));
		expect(inbox.find((i) => i.id === id)).toMatchObject({ kind: 'Loan', title: 'Ana: ৳10000.50 over 3 month(s)' });
		expect(await code(decide('ana', id))).toBe('not_found');
		const mails = await decide('fin', id);
		expect(mails[0].subject).toBe('Loan approved');
		expect(mails[0].text).toContain(
			`৳10000.50 was approved. Repayment of 3 instalment(s) starts with the ${addMonths(month, 1)} salary.`
		);
		expect(await loanOf(id)).toMatchObject({ status: 'approved', decidedByUserId: who.fin.user.userId });
		expect(await scheduleOf(id)).toEqual([
			{ period: addMonths(month, 1), amount: 333300, status: 'due' },
			{ period: addMonths(month, 2), amount: 333300, status: 'due' },
			{ period: addMonths(month, 3), amount: 333450, status: 'due' }
		]);
		expect(await code(decide('fin', id))).toBe('decided');
		expect((await withTenant(sys(), (tx) => loanApprovals(tx, who.fin.access))).map((i) => i.id)).not.toContain(id);
	});

	it('moves a start month that has passed to the current month', async () => {
		const id = await ask('ben', { kind: 'advance', amount: '3000', instalments: '1' });
		await withTenant(sys(), (tx) => tx.update(loans).set({ startPeriod: '2026-01' }).where(eq(loans.id, id)));
		const mails = await decide('fin', id);
		expect(mails[0].subject).toBe('Salary advance approved');
		expect((await loanOf(id)).startPeriod).toBe(month);
		expect(await scheduleOf(id)).toEqual([{ period: month, amount: 300000, status: 'due' }]);
	});

	it('blocks deciding your own request and records rejections', async () => {
		const own = await ask('fin');
		expect(await code(decide('fin', own))).toBe('own_loan');
		const inbox = await withTenant(sys(), (tx) => loanApprovals(tx, who.fin.access));
		expect(inbox.map((i) => i.id)).not.toContain(own);
		const mails = await decide('fin2', own, 'reject', 'Budget');
		expect(mails[0]).toMatchObject({ subject: 'Loan rejected' });
		expect(mails[0].text).toContain('Budget');
		expect(await loanOf(own)).toMatchObject({ status: 'rejected', decisionNote: 'Budget', startPeriod: month });
		expect(await scheduleOf(own)).toEqual([]);
	});
});

describe('board', () => {
	it('shows balances to the employee and the approver', async () => {
		const [paid] = await withTenant(sys(), (tx) =>
			tx
				.update(loanInstalments)
				.set({ status: 'paid', paidAt: new Date() })
				.where(eq(loanInstalments.employeeId, ids.ben))
				.returning()
		);
		expect(paid.amount).toBe(300000);
		const ana = await withTenant(sys(), (tx) => loanBoard(tx, who.ana));
		expect(ana.canRequest).toBe(true);
		expect(ana.toDecide).toEqual([]);
		expect(ana.active).toEqual([]);
		expect(ana.mine[0]).toMatchObject({ amount: 1000050, repaid: 0, balance: 1000050 });
		const fin = await withTenant(sys(), (tx) => loanBoard(tx, who.fin));
		expect(fin.active.find((l) => l.employeeId === ids.ben)).toMatchObject({ repaid: 300000, balance: 0 });
		expect(fin.active.every((l) => l.status === 'approved')).toBe(true);
		expect(fin.active).toHaveLength(2);
		const fin2 = await withTenant(sys(), (tx) => loanBoard(tx, who.fin2));
		expect(fin2.canRequest).toBe(false);
		await ask('ben');
		await ask('fin');
		expect((await withTenant(sys(), (tx) => loanBoard(tx, who.fin))).toDecide.map((l) => l.name)).toEqual(['Ben']);
		const teamOnly = { ...who.ana, access: { ...who.ana.access, grants: { 'loan.approve': ['team'] } } } as Member;
		const narrow = await withTenant(sys(), (tx) => loanBoard(tx, teamOnly));
		expect(narrow.toDecide).toEqual([]);
		expect(narrow.active.map((l) => l.employeeId)).toEqual([ids.ana]);
		expect(narrow.canRequest).toBe(false);
		expect((await withTenant(sys(), (tx) => loanBoard(tx, who.fin2))).toDecide.map((l) => l.name)).toEqual([
			'Ben',
			'Fin'
		]);
		expect(
			(await withTenant(sys(), (tx) => loanBoard(tx, who.ben))).mine.find((l) => l.status === 'requested')
		).toMatchObject({ balance: 0, schedule: [] });
	});
});
