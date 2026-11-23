import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTestNow } from '../../src/lib/server/clock';
import { closePools } from '../../src/lib/server/db';
import { announcements, branches, departments, memberships } from '../../src/lib/server/db/schema';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from '../../src/lib/server/employees';
import {
	announcementAdmin,
	announcementFeed,
	deleteAnnouncement,
	saveAnnouncement
} from '../../src/lib/server/announcements';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess, userCtx, type requireMember } from '../../src/lib/server/rbac/access';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { createTenant, createUser } from './helpers';

type Member = ReturnType<typeof requireMember>;
let tenant: { id: string; slug: string };
const ids: Record<string, string> = {};
const who: Record<string, Member> = {};
const org: Record<string, string> = {};
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
const hire = (fullName: string, departmentId = '', branchId = '') =>
	createEmployee({ tenantId: tenant.id, actor: 'user' }, creator as never, {
		...blanks,
		fullName,
		departmentId,
		branchId,
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

const save = (key: string, f: Record<string, string>) =>
	code(() =>
		saveAnnouncement(who[key], {
			announcementId: '',
			body: 'Details',
			audience: 'all',
			departmentId: '',
			branchId: '',
			pinned: '',
			publishOn: '2026-11-24',
			expiresOn: '',
			...f
		})
	);
const feed = async (key: string) =>
	(await at(() => withTenant(userCtx(who[key]), (tx) => announcementFeed(tx, who[key].access)))).map((a) => a.title);
const admin = () => at(() => withTenant(sys(), (tx) => announcementAdmin(tx)));
const idOf = async (title: string) => (await admin()).rows.find((r) => r.title === title)!.id;

beforeAll(async () => {
	tenant = await createTenant('announce');
	await withTenant(sys(), async (tx) => {
		await seedTenant(tx, tenant.id);
		const [eng] = await tx.insert(departments).values({ tenantId: tenant.id, name: 'Eng' }).returning();
		const [be] = await tx
			.insert(departments)
			.values({ tenantId: tenant.id, name: 'Backend', parentId: eng.id })
			.returning();
		const [sales] = await tx.insert(departments).values({ tenantId: tenant.id, name: 'Sales' }).returning();
		const [dhaka] = await tx.insert(branches).values({ tenantId: tenant.id, name: 'Dhaka' }).returning();
		const [ctg] = await tx.insert(branches).values({ tenantId: tenant.id, name: 'Ctg' }).returning();
		Object.assign(org, { eng: eng.id, be: be.id, sales: sales.id, dhaka: dhaka.id, ctg: ctg.id });
	});
	ids.bo = await hire('Bo', org.be, org.dhaka);
	ids.sa = await hire('Sa', org.sales, org.ctg);
	ids.ed = await hire('Ed', org.eng);
	await member('hr', ['hr_admin'], null);
	await member('bo', ['employee'], ids.bo);
	await member('sa', ['employee'], ids.sa);
	await member('ed', ['employee'], ids.ed);
	await member('x', ['employee'], null);
});

afterAll(closePools);

describe('announcements', () => {
	it('validates the audience and the publish window', async () => {
		expect(await save('bo', { title: 'Sneak' })).toBe('forbidden');
		expect(await save('hr', { title: 'No dept', audience: 'department' })).toBe('invalid: Choose the department.');
		expect(await save('hr', { title: 'No branch', audience: 'branch' })).toBe('invalid: Choose the branch.');
		expect(await save('hr', { title: 'Ghost', audience: 'department', departmentId: crypto.randomUUID() })).toBe(
			'invalid_department'
		);
		expect(await save('hr', { title: 'Ghost', audience: 'branch', branchId: crypto.randomUUID() })).toBe(
			'invalid_branch'
		);
		expect(await save('hr', { title: 'Backwards', expiresOn: '2026-11-23' })).toBe(
			'invalid: The end date cannot be before the publish date.'
		);
		expect(await save('hr', { title: '  ' })).toBe('invalid: Add a title.');
		expect(await save('hr', { title: 'Lost', announcementId: crypto.randomUUID() })).toBe('not_found');
	});

	it('shows each person only live announcements meant for them', async () => {
		expect(await save('hr', { title: 'Old', publishOn: '2026-11-01', expiresOn: '2026-11-23' })).toBe('ok');
		expect(await save('hr', { title: 'Last day', publishOn: '2026-11-20', expiresOn: '2026-11-24' })).toBe('ok');
		expect(
			await save('hr', {
				title: 'Backend deploy',
				audience: 'department',
				departmentId: org.be,
				publishOn: '2026-11-23'
			})
		).toBe('ok');
		expect(
			await save('hr', { title: 'Eng party', audience: 'department', departmentId: org.eng, branchId: org.ctg })
		).toBe('ok');
		expect(await save('hr', { title: 'Dhaka wifi', audience: 'branch', branchId: org.dhaka })).toBe('ok');
		expect(await save('hr', { title: 'All hands', pinned: 'on', departmentId: org.sales })).toBe('ok');
		expect(await save('hr', { title: 'Future', publishOn: '2026-11-25' })).toBe('ok');

		expect(await feed('bo')).toEqual(['All hands', 'Dhaka wifi', 'Eng party', 'Backend deploy', 'Last day']);
		expect(await feed('ed')).toEqual(['All hands', 'Eng party', 'Last day']);
		expect(await feed('sa')).toEqual(['All hands', 'Last day']);
		expect(await feed('x')).toEqual(['All hands', 'Last day']);

		const a = await admin();
		expect(a.rows.map((r) => `${r.title}:${r.state}:${r.target ?? '-'}`)).toEqual([
			'Future:scheduled:-',
			'All hands:live:-',
			'Dhaka wifi:live:Dhaka',
			'Eng party:live:Eng',
			'Backend deploy:live:Backend',
			'Last day:live:-',
			'Old:ended:-'
		]);
		const party = a.rows.find((r) => r.title === 'Eng party')!;
		expect([party.departmentId, party.branchId]).toEqual([org.eng, null]);
		expect(a.rows.find((r) => r.title === 'All hands')!.departmentId).toBeNull();
	});

	it('edits, re-pins and deletes', async () => {
		const party = await idOf('Eng party');
		expect(
			await save('hr', { announcementId: party, title: 'Party for all', audience: 'all', departmentId: org.eng })
		).toBe('ok');
		expect(await feed('sa')).toEqual(['All hands', 'Party for all', 'Last day']);
		const last = await idOf('Last day');
		expect(
			await save('hr', {
				announcementId: last,
				title: 'Last day',
				pinned: 'on',
				publishOn: '2026-11-20',
				expiresOn: '2026-11-24'
			})
		).toBe('ok');
		expect(await feed('x')).toEqual(['All hands', 'Last day', 'Party for all']);
		expect(await code(() => deleteAnnouncement(who.bo, { announcementId: last }))).toBe('forbidden');
		expect(await code(() => deleteAnnouncement(who.hr, { announcementId: last }))).toBe('ok');
		expect(await code(() => deleteAnnouncement(who.hr, { announcementId: last }))).toBe('not_found');
		expect(await code(() => deleteAnnouncement(who.hr, { announcementId: 'x' }))).toBe(
			'invalid: Choose an announcement.'
		);
		const left = await withTenant(sys(), (tx) => tx.select().from(announcements).where(eq(announcements.id, last)));
		expect(left).toEqual([]);
	});
});
