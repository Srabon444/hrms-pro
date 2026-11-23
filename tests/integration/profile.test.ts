import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GrantMap } from '../../src/lib/rbac/grants';
import { closePools } from '../../src/lib/server/db';
import { employees } from '../../src/lib/server/db/schema';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from '../../src/lib/server/employees';
import { seedTenant } from '../../src/lib/server/platform/tenants';
import {
	addListEntry,
	MAX_LIST_ENTRIES,
	profileLists,
	removeListEntry,
	updateOwnDetails
} from '../../src/lib/server/profile';
import type { Access } from '../../src/lib/server/rbac/access';
import { withTenant, type TenantCtx } from '../../src/lib/server/tenancy';
import { createTenant } from './helpers';

let ctx: TenantCtx;
const ids: Record<string, string> = {};

const access = (employeeId: string | null, grants: GrantMap): Access => ({
	membershipId: crypto.randomUUID(),
	employeeId,
	grants,
	roleKeys: [],
	isOwner: false
});
const hr = access(null, { 'employee.read': ['all'], 'employee.create': ['all'], 'employee.update': ['all'] });
const self = (id: string) => access(id, { 'employee.read': ['own'] });
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
const own = {
	phone: '01711000000',
	personalEmail: 'me@home.test',
	presentAddress: 'Dhaka',
	permanentAddress: 'Khulna'
};
const contact = { name: 'Rina', relation: 'Sister', phone: '01811000000' };
const lists = (a: Access, id: string) =>
	withTenant(ctx, async (tx) => {
		const [e] = await tx.select({ status: employees.status }).from(employees).where(eq(employees.id, id));
		return profileLists(tx, a, id, e.status);
	});

beforeAll(async () => {
	const t = await createTenant('profile');
	await withTenant({ tenantId: t.id, actor: 'system' }, (tx) => seedTenant(tx, t.id));
	ctx = { tenantId: t.id, actor: 'user' };
	for (const name of ['me', 'peer', 'gone']) ids[name] = await createEmployee(ctx, hr, person(`${name} person`));
	await withTenant(ctx, (tx) =>
		tx.execute(sql`update employees set status = 'exited', exit_date = '2026-06-01' where id = ${ids.gone}::uuid`)
	);
});

afterAll(closePools);

describe('self-service profile', () => {
	it('lets an employee change only their own contact details', async () => {
		expect(await code(updateOwnDetails(ctx, self(ids.me), ids.me, own))).toBe('ok');
		const [row] = await withTenant(ctx, (tx) => tx.select().from(employees).where(eq(employees.id, ids.me)));
		expect(row).toMatchObject({ phone: own.phone, personalEmail: own.personalEmail, permanentAddress: 'Khulna' });
		expect(await code(updateOwnDetails(ctx, self(ids.me), ids.peer, own))).toBe('not_found');
		expect(await code(updateOwnDetails(ctx, hr, ids.me, own))).toBe('forbidden');
		expect(await code(updateOwnDetails(ctx, self(ids.me), ids.me, { ...own, personalEmail: 'nope' }))).toBe('invalid');
	});

	it('ignores fields outside the self-service set', async () => {
		await updateOwnDetails(ctx, self(ids.me), ids.me, { ...own, fullName: 'Hacked', nationalId: '999' } as never);
		const [row] = await withTenant(ctx, (tx) => tx.select().from(employees).where(eq(employees.id, ids.me)));
		expect(row.fullName).toBe('me person');
		expect(row.nationalId).toBeNull();
	});

	it('lets the employee and HR keep the lists, but not a peer', async () => {
		expect(await code(addListEntry(ctx, self(ids.me), ids.me, 'contact', contact))).toBe('ok');
		expect(
			await code(
				addListEntry(ctx, hr, ids.me, 'education', { degree: 'BSc CSE', institution: 'BUET', passingYear: '2018' })
			)
		).toBe('ok');
		expect(await code(addListEntry(ctx, self(ids.peer), ids.me, 'contact', contact))).toBe('not_found');
		const peerWithRead = access(ids.peer, { 'employee.read': ['all'] });
		expect(await code(addListEntry(ctx, peerWithRead, ids.me, 'contact', contact))).toBe('forbidden');
		const view = await lists(peerWithRead, ids.me);
		expect(view.contacts.map((c) => c.name)).toEqual(['Rina']);
		expect(view.education[0].passingYear).toBe(2018);
		expect(view.canEditLists).toBe(false);
		expect((await lists(self(ids.me), ids.me)).canEditSelf).toBe(true);
		const contactId = view.contacts[0].id;
		expect(await code(removeListEntry(ctx, peerWithRead, ids.me, 'contact', contactId))).toBe('forbidden');
		expect(await code(removeListEntry(ctx, self(ids.peer), ids.peer, 'contact', contactId))).toBe('not_found');
		expect(await code(removeListEntry(ctx, self(ids.me), ids.me, 'contact', contactId))).toBe('ok');
		expect((await lists(hr, ids.me)).contacts).toEqual([]);
	});

	it('validates entries and rejects unknown kinds', async () => {
		const job = { company: 'Acme', title: 'Engineer', startDate: '2024-01-01', endDate: '2023-01-01' };
		expect(await code(addListEntry(ctx, self(ids.me), ids.me, 'experience', job))).toBe('invalid');
		expect(await code(addListEntry(ctx, self(ids.me), ids.me, 'experience', { ...job, endDate: '' }))).toBe('ok');
		expect(await code(addListEntry(ctx, self(ids.me), ids.me, 'salary', contact))).toBe('invalid');
		expect(await code(addListEntry(ctx, self(ids.me), ids.me, 'contact', { ...contact, name: '  ' }))).toBe('invalid');
	});

	it('caps each list', async () => {
		for (let i = 0; i < MAX_LIST_ENTRIES; i++) await addListEntry(ctx, self(ids.peer), ids.peer, 'contact', contact);
		expect(await code(addListEntry(ctx, self(ids.peer), ids.peer, 'contact', contact))).toBe('too_many');
	});

	it('closes the profile of someone who has left', async () => {
		expect(await code(updateOwnDetails(ctx, self(ids.gone), ids.gone, own))).toBe('exited');
		expect(await code(addListEntry(ctx, hr, ids.gone, 'contact', contact))).toBe('exited');
		const view = await lists(self(ids.gone), ids.gone);
		expect([view.canEditSelf, view.canEditLists]).toEqual([false, false]);
	});
});
