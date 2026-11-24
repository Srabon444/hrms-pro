import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTestNow } from '../../src/lib/server/clock';
import { config } from '../../src/lib/server/config';
import { closePools } from '../../src/lib/server/db';
import {
	employees,
	memberships,
	notifications,
	policies,
	policyAcknowledgements,
	rolePermissions,
	roles
} from '../../src/lib/server/db/schema';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from '../../src/lib/server/employees';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { acknowledgePolicy, openPolicy, policyList, policyReport, savePolicy } from '../../src/lib/server/policies';
import { loadAccess, userCtx, type requireMember } from '../../src/lib/server/rbac/access';
import { s3 } from '../../src/lib/server/storage';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { createTenant, createUser } from './helpers';

type Member = ReturnType<typeof requireMember>;
let tenant: { id: string; slug: string };
const ids: Record<string, string> = {};
const who: Record<string, Member> = {};
const pol: Record<string, string> = {};
const sys = () => systemCtx(tenant.id);
let now = '2026-11-24T06:00:00Z';
const at = <T>(fn: () => Promise<T>) => withTestNow(now, fn);
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
const hire = (fullName: string) =>
	createEmployee({ tenantId: tenant.id, actor: 'user' }, creator as never, {
		...blanks,
		fullName,
		employmentType: 'full_time',
		status: 'active',
		joinDate: '2026-01-01'
	});

async function member(key: string, roleKeys: string[], employeeId: string | null, status = 'active') {
	const u = await createUser();
	const id = await withTenant(sys(), async (tx) => {
		const membershipId = await addMember(tx, tenant.id, u.id, roleKeys);
		await tx.update(memberships).set({ employeeId, status }).where(eq(memberships.id, membershipId));
		return membershipId;
	});
	who[key] = {
		user: { userId: u.id },
		tenant: { id: tenant.id, slug: tenant.slug, name: tenant.slug },
		access: await loadAccess(tenant.id, { id, status, employeeId })
	} as unknown as Member;
}

const pdf = (text: string, name = 'policy.pdf') => new File([`%PDF-1.7 ${text}`], name, { type: 'application/pdf' });
const save = (key: string, f: Record<string, string>, file: File | null = null) =>
	code(async () => {
		const r = await savePolicy(who[key], { policyId: '', requiresAck: 'on', active: 'on', ...f }, file);
		if (!f.policyId) pol[f.title] = r.id;
	});
const ack = (key: string, title: string, version: number | string) =>
	code(() => acknowledgePolicy(who[key], { policyId: pol[title], version: String(version) }));
const list = (key: string) => at(() => withTenant(userCtx(who[key]), (tx) => policyList(tx, who[key].access)));
const inbox = async (key: string) =>
	(
		await withTenant(sys(), (tx) =>
			tx
				.select({ t: notifications.title })
				.from(notifications)
				.where(eq(notifications.membershipId, who[key].access.membershipId))
				.orderBy(asc(notifications.createdAt), asc(notifications.title))
		)
	).map((r) => r.t);
const row = async (title: string) =>
	(await withTenant(sys(), (tx) => tx.select().from(policies).where(eq(policies.id, pol[title]))))[0];
const objects = async () =>
	(await s3().send(new ListObjectsV2Command({ Bucket: config().S3_BUCKET, Prefix: `t/${tenant.id}/policies/` })))
		.KeyCount ?? 0;

beforeAll(async () => {
	tenant = await createTenant('policies');
	await withTenant(sys(), (tx) => seedTenant(tx, tenant.id));
	ids.bo = await hire('Bo');
	ids.sa = await hire('Sa');
	ids.ex = await hire('Ex');
	ids.dis = await hire('Dis');
	await withTenant(sys(), (tx) => tx.update(employees).set({ status: 'exited' }).where(eq(employees.id, ids.ex)));
	await member('hr', ['hr_admin'], ids.sa);
	await member('bo', ['employee'], ids.bo);
	await member('ex', ['employee'], ids.ex);
	await member('dis', ['employee'], ids.dis, 'disabled');
	await member('x', ['employee'], null);
	await member('officer', ['hr_officer'], null);
	await withTenant(sys(), async (tx) => {
		const [r] = await tx
			.insert(roles)
			.values({ tenantId: tenant.id, key: 'team_policy', name: 'Team policy' })
			.returning({ id: roles.id });
		await tx
			.insert(rolePermissions)
			.values({ tenantId: tenant.id, roleId: r.id, permission: 'policy.manage', scope: 'team' });
	});
	await member('lead', ['team_policy'], null);
});

afterAll(closePools);

describe('policies', () => {
	it('refuses bad uploads and only lets policy managers publish', async () => {
		expect(await save('bo', { title: 'Sneak' }, pdf('a'))).toBe('forbidden');
		expect(await save('officer', { title: 'Sneak' }, pdf('a'))).toBe('forbidden');
		expect(await save('lead', { title: 'Sneak' }, pdf('a'))).toBe('forbidden');
		expect(await save('hr', { title: 'No file' })).toBe('no_file');
		expect(await save('hr', { title: 'Empty' }, new File([], 'a.pdf'))).toBe('no_file');
		expect(await save('hr', { title: 'Exe' }, new File(['MZ\x90\x00'], 'a.pdf'))).toBe('unsupported_file');
		expect(
			await save('hr', { title: 'Png' }, new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])], 'a.png'))
		).toBe('unsupported_file');
		expect(await save('hr', { title: 'Big' }, new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'big.pdf'))).toBe(
			'too_large'
		);
		expect(await save('hr', { title: '  ' }, pdf('a'))).toBe('invalid: Name the policy.');
		expect(await save('hr', { title: 'Lost', policyId: crypto.randomUUID() })).toBe('not_found');
		expect(await objects()).toBe(0);
	});

	it('publishes a policy and asks current staff to read it', async () => {
		expect(await save('hr', { title: 'Code of conduct', description: 'Be kind' }, pdf('v1', 'coc.pdf'))).toBe('ok');
		const p = await row('Code of conduct');
		expect([p.version, p.fileName, p.contentType, p.publishedOn, p.sizeBytes]).toEqual([
			1,
			'coc.pdf',
			'application/pdf',
			'2026-11-24',
			11
		]);
		expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(await inbox('bo')).toEqual(['Please read Code of conduct']);
		expect(await inbox('hr')).toEqual([]);
		expect(await inbox('ex')).toEqual([]);
		expect(await inbox('dis')).toEqual([]);

		expect(await save('hr', { title: 'code OF conduct' }, pdf('dup'))).toBe('title_exists');
		expect(await objects()).toBe(1);

		expect(await save('hr', { title: 'Dress code', requiresAck: '' }, pdf('dress'))).toBe('ok');
		expect(await save('hr', { title: 'Draft', active: '' }, pdf('draft'))).toBe('ok');
		expect(await inbox('bo')).toEqual(['Please read Code of conduct']);
	});

	it('records who acknowledged which version', async () => {
		expect(await ack('x', 'Code of conduct', 1)).toBe('no_employee');
		expect(await ack('bo', 'Code of conduct', 2)).toBe('stale_version');
		expect(await ack('bo', 'Dress code', 1)).toBe('no_ack');
		expect(await ack('bo', 'Draft', 1)).toBe('not_found');
		expect(await ack('bo', 'Code of conduct', 'x')).toBe('invalid: Choose a policy version.');
		expect(await ack('bo', 'Code of conduct', 1)).toBe('ok');
		expect(await ack('bo', 'Code of conduct', 1)).toBe('ok');
		await withTenant(sys(), (tx) =>
			tx.insert(policyAcknowledgements).values({
				tenantId: tenant.id,
				policyId: pol['Code of conduct'],
				employeeId: ids.ex,
				version: 1,
				sha256: 'x'
			})
		);
		const acks = await withTenant(sys(), (tx) =>
			tx.select().from(policyAcknowledgements).where(eq(policyAcknowledgements.employeeId, ids.bo))
		);
		expect(acks.map((a) => [a.version, a.sha256])).toEqual([[1, (await row('Code of conduct')).sha256]]);

		const mine = await list('bo');
		expect(mine.manager).toBe(false);
		expect(mine.canAck).toBe(true);
		expect(mine.rows.map((r) => [r.title, !!r.acknowledgedAt, r.acked])).toEqual([
			['Code of conduct', true, 0],
			['Dress code', false, 0]
		]);
		expect((await list('x')).canAck).toBe(false);
		const all = await list('hr');
		expect([all.manager, all.staff]).toEqual([true, 3]);
		expect(all.rows.map((r) => [r.title, r.acked, !!r.acknowledgedAt])).toEqual([
			['Code of conduct', 1, false],
			['Dress code', 0, false],
			['Draft', 0, false]
		]);
	});

	it('starts a new version that everyone must acknowledge again', async () => {
		const id = pol['Code of conduct'];
		const before = await row('Code of conduct');
		expect(await save('hr', { policyId: id, title: 'Code of conduct', description: 'Be kinder' })).toBe('ok');
		expect((await row('Code of conduct')).version).toBe(1);
		expect(await inbox('bo')).toEqual(['Please read Code of conduct']);

		expect(await save('hr', { policyId: id, title: 'Dress code' }, pdf('clash'))).toBe('title_exists');
		expect(await objects()).toBe(3);

		now = '2026-11-25T06:00:00Z';
		expect(await save('hr', { policyId: id, title: 'Code of conduct' }, pdf('version two'))).toBe('ok');
		const after = await row('Code of conduct');
		expect([after.version, after.publishedOn]).toEqual([2, '2026-11-25']);
		expect(after.sha256).not.toBe(before.sha256);
		expect(after.storageKey).not.toBe(before.storageKey);
		expect(after.createdByUserId).toBe(before.createdByUserId);
		expect(await objects()).toBe(4);
		expect(await inbox('bo')).toEqual([
			'Please read Code of conduct',
			'Code of conduct was updated. Please read it again.'
		]);
		expect(await ack('bo', 'Code of conduct', 1)).toBe('stale_version');
		expect((await list('bo')).rows[0].acknowledgedAt).toBeNull();
		expect((await list('hr')).rows[0].acked).toBe(0);

		const report = await at(() => withTenant(sys(), (tx) => policyReport(tx, who.hr.access, id)));
		expect(report!.people.map((p) => [p.name, !!p.acknowledgedAt])).toEqual([
			['Bo', false],
			['Dis', false],
			['Sa', false]
		]);
		expect(await ack('bo', 'Code of conduct', 2)).toBe('ok');
		const again = await at(() => withTenant(sys(), (tx) => policyReport(tx, who.hr.access, id)));
		expect(again!.people.map((p) => p.name)).toEqual(['Dis', 'Sa', 'Bo']);
		expect(await withTenant(sys(), (tx) => policyReport(tx, who.bo.access, id))).toBeNull();
		expect(await withTenant(sys(), (tx) => policyReport(tx, who.hr.access, 'nope'))).toBeNull();
		expect(await withTenant(sys(), (tx) => policyReport(tx, who.hr.access, crypto.randomUUID()))).toBeNull();
	});

	it('asks again when a policy is published or starts needing acknowledgement', async () => {
		const draft = pol.Draft;
		expect(await save('hr', { policyId: draft, title: 'Draft', active: '' })).toBe('ok');
		expect(await save('hr', { policyId: draft, title: 'Draft', requiresAck: '' })).toBe('ok');
		expect(await save('hr', { policyId: draft, title: 'Leave rules' })).toBe('ok');
		const dress = pol['Dress code'];
		expect(await save('hr', { policyId: dress, title: 'Dress code' })).toBe('ok');
		expect(await save('hr', { policyId: dress, title: 'Dress code' })).toBe('ok');
		expect((await inbox('bo')).slice(2)).toEqual(['Please read Leave rules', 'Please read Dress code']);
		const leave = await row('Draft');
		expect([leave.title, leave.version, leave.active, leave.requiresAck, leave.publishedOn]).toEqual([
			'Leave rules',
			1,
			true,
			true,
			'2026-11-24'
		]);
	});

	it('serves the file to staff and audits each download', async () => {
		const id = pol['Code of conduct'];
		const file = await at(() => openPolicy(who.bo, id));
		expect([file.fileName, new TextDecoder().decode(file.body)]).toEqual(['policy.pdf', '%PDF-1.7 version two']);
		expect(await save('hr', { policyId: id, title: 'Code of conduct', active: '' })).toBe('ok');
		expect(await code(() => openPolicy(who.bo, id))).toBe('not_found');
		expect(await code(() => openPolicy(who.hr, id))).toBe('ok');
		expect(await code(() => openPolicy(who.bo, 'nope'))).toBe('not_found');
		expect((await list('bo')).rows.map((r) => r.title)).toEqual(['Dress code', 'Leave rules']);
		expect(await ack('bo', 'Code of conduct', 2)).toBe('not_found');
		const audits = await withTenant(sys(), (tx) =>
			tx.execute<{ n: number }>(
				sql`select count(*)::int as n from audit_log where row_id = ${id} and event = 'policy.download'`
			)
		);
		expect(audits[0].n).toBe(2);
	});
});
