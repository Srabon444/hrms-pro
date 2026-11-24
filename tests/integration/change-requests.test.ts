import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pendingApprovals } from '../../src/lib/server/approvals';
import {
	cancelChange,
	decideChange,
	getChange,
	ownPendingChange,
	requestChange
} from '../../src/lib/server/change-requests';
import { addFiles, openFile } from '../../src/lib/server/attachments';
import { closePools } from '../../src/lib/server/db';
import {
	changeRequests,
	employees,
	memberships,
	notificationPrefs,
	notifications
} from '../../src/lib/server/db/schema';
import {
	bankChangeAlert,
	createEmployee,
	updateEmployee,
	EMPLOYMENT_FIELDS,
	PROFILE_FIELDS
} from '../../src/lib/server/employees';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess, type requireMember } from '../../src/lib/server/rbac/access';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { createTenant, createUser } from './helpers';

type Member = ReturnType<typeof requireMember>;
let tenant: { id: string; slug: string };
const ids: Record<string, string> = {};
const who: Record<string, Member> = {};

const pdf = (name: string) => new File([`%PDF-1.7 ${name}`], name, { type: 'application/pdf' });
const code = (p: Promise<unknown>) =>
	p
		.then(() => 'ok')
		.catch((e: { code?: string; issues?: unknown[] }) => (e.issues ? 'invalid' : (e.code ?? String(e))));
const blanks = Object.fromEntries(Object.keys({ ...PROFILE_FIELDS, ...EMPLOYMENT_FIELDS }).map((k) => [k, '']));
const person = (fullName: string) => ({
	...blanks,
	fullName,
	employmentType: 'full_time',
	status: 'active',
	joinDate: '2026-01-05'
});
const sys = () => systemCtx(tenant.id);

async function member(key: string, roles: string[], employeeId: string | null) {
	const u = await createUser();
	const id = await withTenant(sys(), async (tx) => {
		const membershipId = await addMember(tx, tenant.id, u.id, roles);
		if (employeeId) await tx.update(memberships).set({ employeeId }).where(eq(memberships.id, membershipId));
		return membershipId;
	});
	ids[`${key}Membership`] = id;
	who[key] = {
		user: { userId: u.id },
		tenant: { id: tenant.id, slug: tenant.slug, name: tenant.slug },
		access: await loadAccess(tenant.id, { id, status: 'active', employeeId })
	} as unknown as Member;
}

const record = (id: string) =>
	withTenant(sys(), async (tx) => (await tx.select().from(employees).where(eq(employees.id, id)))[0]);
const pending = (employeeId: string) =>
	withTenant(sys(), (tx) => ownPendingChange(tx, { employeeId } as Member['access'], employeeId));

beforeAll(async () => {
	tenant = await createTenant('changes');
	await withTenant(sys(), (tx) => seedTenant(tx, tenant.id));
	const hrAll = { 'employee.read': ['all'], 'employee.create': ['all'], 'employee.update': ['all'] } as const;
	const creator = { membershipId: '', employeeId: null, grants: hrAll, roleKeys: [], isOwner: false };
	for (const name of ['me', 'hrPerson', 'other'])
		ids[name] = await createEmployee({ tenantId: tenant.id, actor: 'user' }, creator as never, person(`${name} x`));
	await member('me', ['employee'], ids.me);
	await member('hr', ['hr_admin'], ids.hrPerson);
	await member('other', ['employee'], ids.other);
	await member('manager', ['employee', 'line_manager'], null);
});

afterAll(closePools);

describe('change requests', () => {
	it('lets an employee ask for their own change only, one at a time', async () => {
		expect(await code(requestChange(who.me, ids.me, {}))).toBe('no_change');
		expect(await code(requestChange(who.me, ids.me, { fullName: 'me x' }))).toBe('no_change');
		expect(await code(requestChange(who.other, ids.me, { taxId: '1' }))).toBe('not_found');
		expect(await code(requestChange(who.hr, ids.me, { taxId: '1' }))).toBe('forbidden');
		expect(await code(requestChange(who.me, ids.me, { dateOfBirth: 'soon' }))).toBe('invalid');
		expect(await code(requestChange(who.me, ids.me, { fullName: 'Me Changed', bankAccountNumber: '0123' }))).toBe('ok');
		expect(await code(requestChange(who.me, ids.me, { taxId: '1' }))).toBe('request_pending');
		expect((await pending(ids.me))?.summary).toBe('Full name, Bank account number');
		expect((await record(ids.me)).fullName).toBe('me x');
	});

	it('shows the request only to people who may change sensitive fields', async () => {
		const forHr = await withTenant(sys(), (tx) => pendingApprovals(tx, who.hr.access));
		expect(forHr.map((i) => i.title)).toEqual(['me x: Full name, Bank account number']);
		for (const key of ['me', 'other', 'manager'])
			expect(await withTenant(sys(), (tx) => pendingApprovals(tx, who[key].access))).toEqual([]);
		const id = forHr[0].id;
		expect(await withTenant(sys(), (tx) => getChange(tx, who.other.access, id))).toBeNull();
		const view = await withTenant(sys(), (tx) => getChange(tx, who.hr.access, id));
		expect(view?.rows).toEqual([
			{ key: 'fullName', label: 'Full name', current: 'me x', requested: 'Me Changed' },
			{ key: 'bankAccountNumber', label: 'Bank account number', current: '', requested: '0123' }
		]);
		expect(await code(decideChange(who.other, id, { decision: 'approve', note: '' }))).toBe('not_found');
	});

	it('lets the requester attach proof to a waiting change that only HR can open', async () => {
		const req = (await pending(ids.me))!;
		const [nid] = await addFiles(who.me, 'change_request', req.id, [pdf('nid.pdf')]);
		expect((await openFile(who.hr, nid)).fileName).toBe('nid.pdf');
		expect(await code(openFile(who.other, nid))).toBe('not_found');
		expect(await code(openFile(who.manager, nid))).toBe('not_found');
		expect(await code(addFiles(who.hr, 'change_request', req.id, [pdf('x.pdf')]))).toBe('forbidden');
		expect(await code(addFiles(who.other, 'change_request', req.id, [pdf('x.pdf')]))).toBe('not_found');
	});

	it('applies an approved change once and tells the employee', async () => {
		const [{ id }] = await withTenant(sys(), (tx) => pendingApprovals(tx, who.hr.access));
		expect(await code(decideChange(who.hr, id, { decision: 'maybe', note: '' }))).toBe('invalid');
		expect(await code(decideChange(who.hr, id, { decision: 'approve', note: 'Checked the bank letter' }))).toBe('ok');
		expect(await code(decideChange(who.hr, id, { decision: 'reject', note: '' }))).toBe('already_decided');
		expect(await record(ids.me)).toMatchObject({ fullName: 'Me Changed', bankAccountNumber: '0123' });
		const titles = await withTenant(sys(), (tx) =>
			tx
				.select({ title: notifications.title })
				.from(notifications)
				.where(eq(notifications.membershipId, ids.meMembership))
		);
		expect(titles.map((t) => t.title).sort()).toEqual([
			'Your bank details were changed',
			'Your profile change was approved'
		]);
		expect(await pending(ids.me)).toBeNull();
	});

	it('blocks deciding on your own request unless the owner allows it', async () => {
		await requestChange(who.hr, ids.hrPerson, { taxId: 'TIN-1' });
		const [{ id }] = await withTenant(sys(), (tx) => pendingApprovals(tx, who.hr.access));
		expect(await code(decideChange(who.hr, id, { decision: 'approve', note: '' }))).toBe('self_approval');
		await withTenant(sys(), (tx) => tx.execute(sql`update tenant_settings set allow_single_admin_approval = true`));
		expect(await code(decideChange(who.hr, id, { decision: 'approve', note: '' }))).toBe('ok');
		await withTenant(sys(), (tx) => tx.execute(sql`update tenant_settings set allow_single_admin_approval = false`));
		expect((await record(ids.hrPerson)).taxId).toBe('TIN-1');
	});

	it('leaves a rejected or cancelled request unapplied', async () => {
		await requestChange(who.other, ids.other, { passportNumber: 'P1' });
		let [{ id }] = await withTenant(sys(), (tx) => pendingApprovals(tx, who.hr.access));
		expect(await code(cancelChange(who.me, id))).toBe('not_found');
		expect(await code(cancelChange(who.other, id))).toBe('ok');
		expect(await code(decideChange(who.hr, id, { decision: 'approve', note: '' }))).toBe('already_decided');
		await requestChange(who.other, ids.other, { passportNumber: 'P2' });
		[{ id }] = await withTenant(sys(), (tx) => pendingApprovals(tx, who.hr.access));
		expect(await code(decideChange(who.hr, id, { decision: 'reject', note: 'Send a scan first' }))).toBe('ok');
		expect(await code(cancelChange(who.other, id))).toBe('not_found');
		expect((await record(ids.other)).passportNumber).toBeNull();
		const rows = await withTenant(sys(), (tx) =>
			tx.select({ status: changeRequests.status }).from(changeRequests).where(eq(changeRequests.employeeId, ids.other))
		);
		expect(rows.map((r) => r.status).sort()).toEqual(['cancelled', 'rejected']);
	});

	it('alerts the employee when HR edits their bank details directly', async () => {
		const hrCtx = { tenantId: tenant.id, userId: who.hr.user.userId, actor: 'user' as const };
		const current = await record(ids.other);
		const form = { ...person(current.fullName), joinDate: current.joinDate, status: current.status };
		await updateEmployee(hrCtx, who.hr.access, ids.other, { ...form, phone: '017' }, tenant.slug);
		await updateEmployee(hrCtx, who.hr.access, ids.other, { ...form, bankAccountNumber: '555' }, tenant.slug);
		const titles = await withTenant(sys(), (tx) =>
			tx
				.select({ title: notifications.title })
				.from(notifications)
				.where(eq(notifications.membershipId, ids.otherMembership))
		);
		expect(titles.filter((t) => t.title === 'Your bank details were changed')).toHaveLength(1);
	});

	it('emails a bank change even to someone who opted out', async () => {
		await withTenant(sys(), (tx) =>
			tx
				.insert(notificationPrefs)
				.values({ tenantId: tenant.id, membershipId: ids.meMembership, category: 'profile', email: false })
		);
		const mails = await withTenant(sys(), (tx) => bankChangeAlert(tx, tenant.id, ids.me, tenant.slug));
		expect(mails).toHaveLength(1);
		const prefs = await withTenant(sys(), (tx) =>
			tx
				.select()
				.from(notificationPrefs)
				.where(and(eq(notificationPrefs.membershipId, ids.meMembership), eq(notificationPrefs.category, 'profile')))
		);
		expect(prefs[0].email).toBe(false);
	});
});
