import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTestNow } from '../../src/lib/server/clock';
import { closePools } from '../../src/lib/server/db';
import {
	designations,
	employees,
	employeeSalaries,
	letters,
	letterTemplates,
	memberships,
	notifications,
	rolePermissions,
	roles,
	salaryChanges,
	tenantSettings
} from '../../src/lib/server/db/schema';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from '../../src/lib/server/employees';
import {
	issueLetter,
	letterBoard,
	letterPreview,
	openLetter,
	saveTemplate,
	templateList
} from '../../src/lib/server/letters';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess, userCtx, type requireMember } from '../../src/lib/server/rbac/access';
import { getObject } from '../../src/lib/server/storage';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { createTenant, createUser, TEST_LOCALE } from './helpers';

type Member = ReturnType<typeof requireMember>;
let tenant: { id: string; slug: string };
const ids: Record<string, string> = {};
const who: Record<string, Member> = {};
const tpl: Record<string, string> = {};
const sys = () => systemCtx(tenant.id);
const at = <T>(fn: () => Promise<T>) => withTestNow('2026-11-24T06:00:00Z', fn);
const code = (p: () => Promise<unknown>) =>
	at(p)
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
const hire = (fullName: string, managerId = '') =>
	createEmployee({ tenantId: tenant.id, actor: 'user' }, creator as never, {
		...blanks,
		fullName,
		managerId,
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
		tenant: { id: tenant.id, slug: tenant.slug, name: 'Acme Ltd' },
		access: await loadAccess(tenant.id, { id, status: 'active', employeeId })
	} as unknown as Member;
}

async function role(key: string, grants: [string, string][]) {
	await withTenant(sys(), async (tx) => {
		const [r] = await tx.insert(roles).values({ tenantId: tenant.id, key, name: key }).returning({ id: roles.id });
		await tx
			.insert(rolePermissions)
			.values(grants.map(([permission, scope]) => ({ tenantId: tenant.id, roleId: r.id, permission, scope })));
	});
}

const template = (key: string, f: Record<string, string>) =>
	code(() =>
		saveTemplate(who[key], {
			templateId: '',
			kind: 'other',
			name: 'Visa letter',
			subject: 'Visa support',
			body: 'Dear {{employee.name}}',
			active: 'on',
			...f
		})
	);
const preview = (key: string, employee: string, t: string) => at(() => letterPreview(who[key], ids[employee], tpl[t]));
const issue = (key: string, employee: string, f: Record<string, string> = {}) =>
	code(() =>
		issueLetter(who[key], {
			employeeId: ids[employee],
			templateId: tpl['Salary certificate'],
			subject: 'Salary certificate',
			body: 'This is to certify.',
			...f
		})
	);
const board = (key: string) => at(() => withTenant(userCtx(who[key]), (tx) => letterBoard(tx, who[key].access)));
const inbox = async (key: string) =>
	(
		await withTenant(sys(), (tx) =>
			tx
				.select({ t: notifications.title })
				.from(notifications)
				.where(eq(notifications.membershipId, who[key].access.membershipId))
				.orderBy(asc(notifications.createdAt))
		)
	).map((r) => r.t);
const issued = () => withTenant(sys(), (tx) => tx.select().from(letters).orderBy(asc(letters.number)));

beforeAll(async () => {
	tenant = await createTenant('letters');
	await withTenant(sys(), (tx) => seedTenant(tx, tenant.id, TEST_LOCALE));
	ids.lea = await hire('Lea');
	ids.bo = await hire('Bo', ids.lea);
	ids.sa = await hire('Sa');
	ids.mo = await hire('Mo');
	ids.so = await hire('So');
	await withTenant(sys(), async (tx) => {
		const [d] = await tx.insert(designations).values({ tenantId: tenant.id, name: 'Engineer' }).returning();
		await tx
			.update(employees)
			.set({ designationId: d.id, confirmationDate: '2026-07-01' })
			.where(eq(employees.id, ids.bo));
	});
	const maker = await createUser();
	await withTenant({ ...sys(), salaryAll: true }, async (tx) => {
		const [old] = await tx
			.insert(salaryChanges)
			.values({
				tenantId: tenant.id,
				employeeId: ids.bo,
				effectiveFrom: '2025-01-01',
				reason: 'Hire',
				status: 'approved',
				lines: [],
				gross: 4_000_000,
				requestedByUserId: maker.id
			})
			.returning();
		await tx.insert(employeeSalaries).values({
			tenantId: tenant.id,
			employeeId: ids.bo,
			effectiveFrom: '2025-01-01',
			effectiveTo: '2025-12-31',
			gross: 4_000_000,
			changeId: old.id
		});
		const [c] = await tx
			.insert(salaryChanges)
			.values({
				tenantId: tenant.id,
				employeeId: ids.bo,
				effectiveFrom: '2026-01-01',
				reason: 'Raise',
				status: 'approved',
				lines: [],
				gross: 5_000_000,
				requestedByUserId: maker.id
			})
			.returning();
		await tx.insert(employeeSalaries).values({
			tenantId: tenant.id,
			employeeId: ids.bo,
			effectiveFrom: '2026-01-01',
			gross: 5_000_000,
			changeId: c.id
		});
	});
	await role('pay_letters', [
		['letter.issue', 'all'],
		['salary.read', 'all']
	]);
	await role('team_letters', [
		['letter.issue', 'team'],
		['salary.read', 'team']
	]);
	await role('mixed_letters', [
		['letter.issue', 'all'],
		['salary.read', 'team']
	]);
	await member('hr', ['hr_admin'], null);
	await member('mix', ['mixed_letters'], ids.mo);
	await member('solo', ['team_letters'], ids.so);
	await member('pay', ['pay_letters'], null);
	await member('lead', ['team_letters'], ids.lea);
	await member('bo', ['employee'], ids.bo);
	await member('sa', ['employee'], ids.sa);
	for (const t of await withTenant(sys(), (tx) => templateList(tx))) tpl[t.name] = t.id;
});

afterAll(closePools);

describe('letters', () => {
	it('seeds the standard templates and guards template changes', async () => {
		expect(Object.keys(tpl).sort()).toEqual([
			'Appointment letter',
			'Confirmation letter',
			'Experience certificate',
			'Increment letter',
			'Offer letter',
			'Salary certificate'
		]);
		expect(await template('bo', {})).toBe('forbidden');
		expect(await template('lead', {})).toBe('forbidden');
		expect(await template('hr', { body: 'Hi {{employee.nickname}}' })).toBe(
			'invalid: Use only the placeholders listed under the editor.'
		);
		expect(await template('hr', { kind: 'memo' })).toBe('invalid: Choose the kind of letter.');
		expect(await template('hr', { name: ' ' })).toBe('invalid: Name the template.');
		expect(await template('hr', { name: 'offer LETTER' })).toBe('name_exists');
		expect(await template('hr', { templateId: crypto.randomUUID() })).toBe('not_found');
		expect(await template('hr', { body: 'Dear {{ employee.name }}, from {{company.name}} on {{today}}' })).toBe('ok');
		const visa = (await withTenant(sys(), (tx) => templateList(tx))).find((t) => t.name === 'Visa letter')!;
		tpl.Visa = visa.id;
		expect([visa.kind, visa.active]).toEqual(['other', true]);
		expect(await template('hr', { templateId: visa.id, name: 'Visa letter', active: '', kind: 'experience' })).toBe(
			'ok'
		);
		const [retired] = await withTenant(sys(), (tx) =>
			tx.select().from(letterTemplates).where(eq(letterTemplates.id, visa.id))
		);
		expect([retired.kind, retired.active]).toEqual(['experience', false]);
		expect((await board('hr')).templates.map((t) => t.name)).not.toContain('Visa letter');
	});

	it('fills the placeholders it may show and leaves the rest for the issuer', async () => {
		const p = await preview('hr', 'bo', 'Confirmation letter');
		expect(p.subject).toBe('Confirmation of employment');
		expect(p.body).toContain('Dear Bo,');
		expect(p.body).toContain('as Engineer with effect from 1 July 2026.');
		expect(p.body).toContain('Human Resources\nAcme Ltd');

		const hidden = await preview('hr', 'bo', 'Salary certificate');
		expect(hidden.body).toContain(
			'since 1 January 2026, and currently draws a monthly gross salary of {{salary.currency}} {{salary.gross}}.'
		);
		expect((await preview('pay', 'bo', 'Salary certificate')).body).toContain('salary of BDT 50000.00.');
		expect((await preview('lead', 'bo', 'Salary certificate')).body).toContain('salary of BDT 50000.00.');
		await withTenant(sys(), (tx) => tx.update(tenantSettings).set({ currency: 'USD' }));
		expect((await preview('pay', 'bo', 'Salary certificate')).body).toContain('salary of USD 50000.00.');
		await withTenant(sys(), (tx) => tx.update(tenantSettings).set({ currency: 'BDT' }));
		expect((await preview('pay', 'sa', 'Salary certificate')).body).toContain(
			'salary of {{salary.currency}} {{salary.gross}}.'
		);
		expect((await preview('mix', 'bo', 'Salary certificate')).body).toContain(
			'salary of {{salary.currency}} {{salary.gross}}.'
		);
		expect(await template('hr', { name: 'Reference', subject: 'Reference for {{employee.name}}' })).toBe('ok');
		tpl.Reference = (await withTenant(sys(), (tx) => templateList(tx))).find((t) => t.name === 'Reference')!.id;
		expect((await preview('hr', 'bo', 'Reference')).subject).toBe('Reference for Bo');
		expect((await preview('hr', 'sa', 'Appointment letter')).body).toContain(
			'on probation until {{employee.probation_end}}.'
		);
		expect((await preview('hr', 'sa', 'Offer letter')).body).toContain(
			'the position of {{employee.designation}} in the {{employee.department}} department'
		);

		expect(await code(() => letterPreview(who.lead, ids.lea, tpl['Salary certificate']))).toBe('not_found');
		expect(await code(() => letterPreview(who.lead, ids.sa, tpl['Salary certificate']))).toBe('not_found');
		expect(await code(() => letterPreview(who.hr, ids.bo, tpl.Visa))).toBe('not_found');
		expect(await code(() => letterPreview(who.hr, 'nope', tpl.Visa))).toBe('not_found');
		expect(await code(() => letterPreview(who.hr, ids.bo, 'nope'))).toBe('not_found');
	});

	it('issues numbered PDF letters and tells the employee', async () => {
		expect(await issue('hr', 'bo', { body: 'Salary BDT {{salary.gross}}' })).toBe(
			'invalid: Fill in every {{placeholder}} before issuing.'
		);
		expect(await issue('hr', 'bo', { subject: 'For {{employee.name}}' })).toBe(
			'invalid: Fill in every {{placeholder}} before issuing.'
		);
		expect(await issue('hr', 'bo', { templateId: tpl.Visa })).toBe('not_found');
		expect(await issue('lead', 'lea')).toBe('not_found');
		expect(await issue('lead', 'sa')).toBe('not_found');
		expect(await issue('bo', 'bo')).toBe('not_found');
		expect(await issued()).toEqual([]);

		expect(await issue('hr', 'bo', { subject: 'Salary / certificate: 2026' })).toBe('ok');
		expect(await issue('lead', 'bo', { templateId: tpl['Experience certificate'], subject: 'Experience' })).toBe('ok');
		expect(await issue('hr', 'sa')).toBe('ok');
		const [first, second, third] = await issued();
		expect([first.number, second.number, third.number]).toEqual([1, 2, 3]);
		expect([first.kind, second.kind]).toEqual(['salary_certificate', 'experience']);
		expect([first.fileName, first.issuedOn, first.issuedByUserId]).toEqual([
			'Salary  certificate 2026.pdf',
			'2026-11-24',
			who.hr.user.userId
		]);
		expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
		const bytes = await getObject(first.storageKey);
		expect(Buffer.from(bytes).toString('latin1').startsWith('%PDF-')).toBe(true);
		expect(bytes.byteLength).toBe(first.sizeBytes);
		expect(await inbox('bo')).toEqual([
			'A letter was issued to you: Salary / certificate: 2026',
			'A letter was issued to you: Experience'
		]);
		expect(await inbox('hr')).toEqual([]);
		expect(await issue('mix', 'mo', { subject: 'Own letter' })).toBe('ok');
		expect(await inbox('mix')).toEqual([]);
		expect(await inbox('sa')).toEqual(['A letter was issued to you: Salary certificate']);
	});

	it('shows each person their own letters and what they may issue', async () => {
		const bo = await board('bo');
		expect(bo.mine.map((l) => l.number)).toEqual([2, 1]);
		expect([bo.issued, bo.people]).toEqual([null, []]);
		const hr = await board('hr');
		expect(hr.mine).toEqual([]);
		expect(hr.issued!.map((l) => `${l.number}:${l.employee}`)).toEqual(['4:Mo', '3:Sa', '2:Bo', '1:Bo']);
		expect(hr.people.map((p) => p.name)).toEqual(['Bo', 'Lea', 'Mo', 'Sa', 'So']);
		const lead = await board('lead');
		expect(lead.issued!.map((l) => l.number)).toEqual([2, 1]);
		expect(lead.people.map((p) => p.name)).toEqual(['Bo']);
		expect(lead.templates.length).toBe(7);
		const solo = await board('solo');
		expect([solo.issued, solo.people, solo.mine.map((l) => l.number)]).toEqual([null, [], []]);
	});

	it('lets only the employee and their issuers download, and audits it', async () => {
		const [first, , third] = await issued();
		const file = await at(() => openLetter(who.bo, first.id));
		expect([file.fileName, file.contentType]).toEqual(['Salary  certificate 2026.pdf', 'application/pdf']);
		expect(await code(() => openLetter(who.sa, first.id))).toBe('not_found');
		expect(await code(() => openLetter(who.lead, first.id))).toBe('ok');
		expect(await code(() => openLetter(who.lead, third.id))).toBe('not_found');
		expect(await code(() => openLetter(who.hr, third.id))).toBe('ok');
		expect(await code(() => openLetter(who.bo, 'nope'))).toBe('not_found');
		const audits = await withTenant(sys(), (tx) =>
			tx.execute<{ n: number }>(
				sql`select count(*)::int as n from audit_log where row_id = ${first.id} and event = 'letter.download'`
			)
		);
		expect(audits[0].n).toBe(2);
	});
});
