import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTestNow } from '../../src/lib/server/clock';
import { homeDashboard } from '../../src/lib/server/dashboard';
import { closePools } from '../../src/lib/server/db';
import {
	employeeDocuments,
	employees,
	leaveRequestDays,
	leaveRequests,
	leaveTypes,
	memberships,
	payrollRuns,
	payslips,
	rolePermissions,
	roles,
	salaryChanges
} from '../../src/lib/server/db/schema';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from '../../src/lib/server/employees';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess, type requireMember } from '../../src/lib/server/rbac/access';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { createTenant, createUser } from './helpers';

type Member = ReturnType<typeof requireMember>;
let tenant: { id: string; slug: string };
const ids: Record<string, string> = {};
const who: Record<string, Member> = {};
const sys = () => systemCtx(tenant.id);
const home = (key: string) => withTestNow('2026-11-24T06:00:00Z', () => homeDashboard(who[key]));
const blanks = Object.fromEntries(Object.keys({ ...PROFILE_FIELDS, ...EMPLOYMENT_FIELDS }).map((k) => [k, '']));
const creator = {
	membershipId: '',
	employeeId: null,
	grants: { 'employee.read': ['all'], 'employee.create': ['all'], 'employee.update': ['all'] },
	roleKeys: [],
	isOwner: false
};
const hire = (fullName: string, joinDate: string, managerId = '', status = 'active', probationEndDate = '') =>
	createEmployee({ tenantId: tenant.id, actor: 'user' }, creator as never, {
		...blanks,
		fullName,
		managerId,
		employmentType: 'full_time',
		status,
		joinDate,
		probationEndDate
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

beforeAll(async () => {
	tenant = await createTenant('dashboard');
	await withTenant(sys(), (tx) => seedTenant(tx, tenant.id));
	ids.lea = await hire('Lea', '2026-01-01');
	ids.ana = await hire('Ana', '2026-01-01', ids.lea);
	ids.ben = await hire('Ben', '2026-01-01', ids.lea, 'probation', '2026-12-10');
	ids.cy = await hire('Cy', '2026-11-10', '', 'probation', '2027-05-10');
	ids.di = await hire('Di', '2026-01-01');
	await member('hr', ['hr_admin'], null);
	await member('pay', ['payroll_officer'], null);
	await member('lea', ['line_manager'], ids.lea);
	await member('fin', ['finance'], null);
	await withTenant(sys(), async (tx) => {
		const [r] = await tx
			.insert(roles)
			.values({ tenantId: tenant.id, key: 'company_numbers', name: 'Company numbers' })
			.returning({ id: roles.id });
		await tx
			.insert(rolePermissions)
			.values({ tenantId: tenant.id, roleId: r.id, permission: 'report.headcount', scope: 'all' });
	});
	await member('ana', ['company_numbers'], ids.ana);
	await withTenant({ ...sys(), payrollAll: true, salaryAll: true }, async (tx) => {
		await tx.update(employees).set({ status: 'exited', exitDate: '2026-11-05' }).where(eq(employees.id, ids.di));
		const [casual] = await tx.select().from(leaveTypes).where(eq(leaveTypes.code, 'casual'));
		const request = async (employeeId: string, date: string, status: string) => {
			const [r] = await tx
				.insert(leaveRequests)
				.values({
					tenantId: tenant.id,
					employeeId,
					leaveTypeId: casual.id,
					startDate: date,
					endDate: date,
					session: 'full',
					days: 1,
					status,
					requestedByUserId: who.hr.user.userId
				})
				.returning({ id: leaveRequests.id });
			await tx.insert(leaveRequestDays).values({
				tenantId: tenant.id,
				requestId: r.id,
				employeeId,
				date,
				session: 'full',
				fiscalYear: 2026,
				status
			});
		};
		await request(ids.ana, '2026-11-24', 'approved');
		await request(ids.ben, '2026-12-01', 'pending');
		const doc = (employeeId: string, title: string, expiresOn: string) => ({
			tenantId: tenant.id,
			employeeId,
			category: 'identity',
			title,
			fileName: `${title}.pdf`,
			contentType: 'application/pdf',
			sizeBytes: 1,
			sha256: 'x',
			storageKey: `${tenant.id}/${title}`,
			expiresOn
		});
		await tx
			.insert(employeeDocuments)
			.values([
				doc(ids.ana, 'Ana passport', '2026-12-04'),
				doc(ids.ben, 'Ben visa', '2026-11-20'),
				doc(ids.ben, 'Ben old visa', '2026-10-24'),
				doc(ids.lea, 'Lea licence', '2026-12-20'),
				doc(ids.ana, 'Ana visa', '2026-12-25'),
				doc(ids.di, 'Di permit', '2026-11-30')
			]);
		const run = async (period: string, status: string, createdAt: string, slips: [string, number, string | null][]) => {
			const [r] = await tx
				.insert(payrollRuns)
				.values({
					tenantId: tenant.id,
					period,
					status,
					runType: 'regular',
					inputsHash: 'x',
					outputHash: 'x',
					computedByUserId: who.hr.user.userId,
					computedAt: new Date(createdAt),
					createdAt: new Date(createdAt)
				})
				.returning({ id: payrollRuns.id });
			await tx.insert(payslips).values(
				slips.map(([employeeId, gross, error]) => ({
					tenantId: tenant.id,
					runId: r.id,
					employeeId,
					gross,
					net: gross - gross / 10,
					error
				}))
			);
			return r.id;
		};
		await run('2026-09', 'paid', '2026-09-30T00:00:00Z', [[ids.ana, 5_000_000, null]]);
		ids.run = await run('2026-10', 'approved', '2026-10-30T00:00:00Z', [
			[ids.ana, 5_000_000, null],
			[ids.lea, 7_000_000, null],
			[ids.ben, 1_000_000, 'No salary']
		]);
		await tx.insert(salaryChanges).values({
			tenantId: tenant.id,
			employeeId: ids.cy,
			effectiveFrom: '2026-12-01',
			reason: 'Review',
			lines: [],
			gross: 6_000_000,
			requestedByUserId: who.pay.user.userId
		});
		await run('2026-11', 'void', '2026-11-20T00:00:00Z', [[ids.ana, 9_000_000, null]]);
	});
});

afterAll(closePools);

describe('home dashboard', () => {
	it('shows an employee their own day, balances, meals and expiring documents', async () => {
		const d = await home('ana');
		expect(d.today).toBe('2026-11-24');
		expect(d.leave!.map((l) => l.name)).toContain('Casual leave');
		expect(d.attendance).toMatchObject({ day: '2026-11-24', punches: [] });
		expect(d.meals).toMatchObject({ date: '2026-11-24' });
		expect(d.documents).toEqual([
			{
				id: expect.any(String),
				employeeId: ids.ana,
				name: 'Ana',
				title: 'Ana passport',
				expiresOn: '2026-12-04',
				expired: false
			}
		]);
		expect(d.headcount).toMatchObject({ start: 4, end: 4 });
		expect([d.approvals.count, d.out, d.probation, d.payroll]).toEqual([0, null, null, null]);
	});

	it('shows a manager who is out and what waits for them', async () => {
		const d = await home('lea');
		expect(d.out).toEqual([{ date: '2026-11-24', session: 'full', name: 'Ana', type: 'Casual leave' }]);
		expect(d.approvals.count).toBe(1);
		expect(d.approvals.items[0].title).toContain('Ben');
		expect(d.documents!.map((x) => x.title)).toEqual(['Lea licence']);
		expect([d.headcount, d.payroll]).toEqual([null, null]);
	});

	it('shows HR headcount, probation and documents without personal cards', async () => {
		const d = await home('hr');
		expect(d.headcount).toEqual({ from: '2026-11-01', start: 4, joiners: 1, leavers: 1, end: 4, attrition: 25 });
		expect(d.probation!.map((p) => p.fullName)).toEqual(['Ben']);
		expect(d.documents!.map((x) => [x.title, x.expired])).toEqual([
			['Ben visa', true],
			['Ana passport', false],
			['Lea licence', false]
		]);
		expect([d.leave, d.attendance, d.meals, d.payroll]).toEqual([null, null, null, null]);
	});

	it('shows payroll the latest run that was not voided, with error slips left out', async () => {
		const d = await home('pay');
		expect(d.payroll).toEqual({
			id: ids.run,
			period: '2026-10',
			title: null,
			runType: 'regular',
			status: 'approved',
			employees: 2,
			gross: '120000.00',
			net: '108000.00'
		});
	});

	it('shows finance the salary changes waiting for approval', async () => {
		const d = await home('fin');
		expect(d.approvals.items.map((i) => i.title)).toContain('Cy: ৳60000.00 from 2026-12-01');
	});

	it('drops personal cards once the tenant takes those permissions away from employees', async () => {
		await withTenant(sys(), async (tx) => {
			const [employee] = await tx.select().from(roles).where(eq(roles.key, 'employee'));
			await tx
				.delete(rolePermissions)
				.where(
					and(
						eq(rolePermissions.roleId, employee.id),
						inArray(rolePermissions.permission, ['attendance.punch', 'meal.order'])
					)
				);
		});
		const membershipId = who.ana.access.membershipId;
		who.ana = {
			...who.ana,
			access: await loadAccess(tenant.id, { id: membershipId, status: 'active', employeeId: ids.ana })
		};
		const d = await home('ana');
		expect([d.attendance, d.meals]).toEqual([null, null]);
		expect(d.leave).not.toBeNull();
	});
});
