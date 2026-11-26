import { eq } from 'drizzle-orm';
import { addFiles, openFile, removeFile } from '../../src/lib/server/attachments';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	addTemplateItem,
	createTemplate,
	employeeChecklists,
	listTemplates,
	myTasks,
	scopeTasks,
	setTaskDone,
	setTemplateActive
} from '../../src/lib/server/checklists';
import { closePools } from '../../src/lib/server/db';
import { files, memberships } from '../../src/lib/server/db/schema';
import { addDays, dateIn } from '../../src/lib/server/dates';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from '../../src/lib/server/employees';
import { recordExit, rehire, withdrawExit } from '../../src/lib/server/exits';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess, type requireMember } from '../../src/lib/server/rbac/access';
import { getObject } from '../../src/lib/server/storage';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { createTenant, createUser, TEST_LOCALE } from './helpers';

type Member = ReturnType<typeof requireMember>;
let tenant: { id: string; slug: string };
const ids: Record<string, string> = {};
const who: Record<string, Member> = {};
const pdf = (name: string) => new File([`%PDF-1.7 ${name}`], name, { type: 'application/pdf' });
const today = dateIn(new Date(), 'Asia/Dhaka');
const sys = () => systemCtx(tenant.id);
const ctx = () => ({ tenantId: tenant.id, actor: 'user' as const });

const code = (p: Promise<unknown>) =>
	p
		.then(() => 'ok')
		.catch((e: { code?: string; issues?: unknown[] }) => (e.issues ? 'invalid' : (e.code ?? String(e))));
const blanks = Object.fromEntries(Object.keys({ ...PROFILE_FIELDS, ...EMPLOYMENT_FIELDS }).map((k) => [k, '']));
const creator = {
	membershipId: '',
	employeeId: null,
	grants: { 'employee.read': ['all'], 'employee.create': ['all'], 'employee.update': ['all'] },
	roleKeys: [],
	isOwner: false
};
const hire = (fullName: string, extra: Record<string, string> = {}) =>
	createEmployee({ tenantId: tenant.id, actor: 'user' }, creator as never, {
		...blanks,
		fullName,
		employmentType: 'full_time',
		status: 'active',
		joinDate: addDays(today, -400),
		...extra
	});

async function member(key: string, roleKeys: string[], employeeId: string) {
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

const lists = (key: string, employeeId: string) =>
	withTenant(sys(), (tx) => employeeChecklists(tx, who[key].access, { id: employeeId, managerId: ids.boss }));
const mine = async (key: string) =>
	(await withTenant(sys(), (tx) => myTasks(tx, who[key].access))).map((t) => `${t.title}/${t.employeeName}`);
const inScopeOf = async (key: string) =>
	(await withTenant(sys(), (tx) => scopeTasks(tx, who[key].access))).map((t) => t.title);
const itemId = async (employeeId: string, title: string) =>
	(await lists('hr', employeeId)).flatMap((c) => c.items).find((i) => i.title === title)!.id;

beforeAll(async () => {
	tenant = await createTenant('tasks');
	await withTenant(sys(), (tx) => seedTenant(tx, tenant.id, TEST_LOCALE));
	await createTemplate(ctx(), { kind: 'onboarding', name: 'Joiners' });
	await createTemplate(ctx(), { kind: 'onboarding', name: 'Old way' });
	await createTemplate(ctx(), { kind: 'offboarding', name: 'Leavers' });
	const { templates } = await withTenant(sys(), listTemplates);
	const t = Object.fromEntries(templates.map((x) => [x.name, x.id]));
	const add = (tpl: string, title: string, assigneeRole: string, dueOffsetDays: number) =>
		addTemplateItem(ctx(), t[tpl], { title, assigneeRole, dueOffsetDays: String(dueOffsetDays) });
	await add('Joiners', 'Issue laptop', 'it_asset_manager', -2);
	await add('Joiners', 'Sign handbook', 'employee', 1);
	await add('Joiners', 'Meet the team', 'line_manager', 3);
	await add('Old way', 'Fax the form', 'hr_admin', 0);
	await add('Leavers', 'Exit talk', 'line_manager', -1);
	await add('Leavers', 'Collect laptop', 'it_asset_manager', 0);
	await setTemplateActive(ctx(), t['Old way'], false);

	ids.boss = await hire('Bo Boss');
	ids.it = await hire('It Ivy');
	ids.hrEmp = await hire('Ha HR');
	ids.stranger = await hire('St Stranger');
	ids.staff = await hire('Sam Staff', { managerId: ids.boss });
	ids.joiner = await hire('Jo Joiner', { managerId: ids.boss, status: 'onboarding', joinDate: addDays(today, 1) });
	await member('boss', ['line_manager'], ids.boss);
	await member('it', ['it_asset_manager'], ids.it);
	await member('hr', ['hr_admin'], ids.hrEmp);
	await member('stranger', [], ids.stranger);
	await member('joiner', [], ids.joiner);
});

afterAll(closePools);

describe('checklist tasks', () => {
	it('starts the active onboarding checklists for an onboarding hire only', async () => {
		const [joiners, ...rest] = await lists('hr', ids.joiner);
		expect(rest).toEqual([]);
		expect([joiners.name, joiners.kind, joiners.anchorDate]).toEqual(['Joiners', 'onboarding', addDays(today, 1)]);
		expect(joiners.items.map((i) => [i.title, i.dueDate, i.done])).toEqual([
			['Issue laptop', addDays(today, -1), false],
			['Sign handbook', addDays(today, 2), false],
			['Meet the team', addDays(today, 4), false]
		]);
		expect(await lists('hr', ids.staff)).toEqual([]);
	});

	it('gives each task to its role, the joiner or their manager, and all of them to HR', async () => {
		expect(await mine('it')).toEqual(['Issue laptop/Jo Joiner']);
		expect(await mine('joiner')).toEqual(['Sign handbook/Jo Joiner']);
		expect(await mine('boss')).toEqual(['Meet the team/Jo Joiner']);
		expect(await mine('stranger')).toEqual([]);
		expect(await mine('hr')).toEqual([]);
		expect(await inScopeOf('hr')).toEqual(['Issue laptop', 'Sign handbook', 'Meet the team']);
		expect(await inScopeOf('it')).toEqual([]);
		const [laptop] = await withTenant(sys(), (tx) => myTasks(tx, who.it.access));
		expect(laptop.overdue).toBe(true);
		const [meet] = await withTenant(sys(), (tx) => myTasks(tx, who.boss.access));
		expect(meet.overdue).toBe(false);
		const can = async (key: string) =>
			(await lists(key, ids.joiner))[0].items.filter((i) => i.canComplete).map((i) => i.title);
		expect(await can('joiner')).toEqual(['Sign handbook']);
		expect(await can('boss')).toEqual(['Meet the team']);
		expect(await can('hr')).toEqual(['Issue laptop', 'Sign handbook', 'Meet the team']);
	});

	it('lets only the assignee or HR tick a task off, and undo it', async () => {
		const laptop = await itemId(ids.joiner, 'Issue laptop');
		expect(await code(setTaskDone(who.stranger, laptop, true))).toBe('not_found');
		expect(await code(setTaskDone(who.boss, laptop, true))).toBe('forbidden');
		expect(await code(setTaskDone(who.joiner, laptop, true))).toBe('forbidden');
		expect(await code(setTaskDone(who.it, 'nope', true))).toBe('not_found');
		expect(await code(setTaskDone(who.it, crypto.randomUUID(), true))).toBe('not_found');
		expect(await code(setTaskDone(who.it, laptop, true))).toBe('ok');
		expect(await mine('it')).toEqual([]);
		expect((await lists('hr', ids.joiner))[0].items[0].done).toBe(true);
		expect(await code(setTaskDone(who.hr, laptop, false))).toBe('ok');
		expect(await mine('it')).toEqual(['Issue laptop/Jo Joiner']);
		expect(await code(setTaskDone(who.joiner, await itemId(ids.joiner, 'Sign handbook'), true))).toBe('ok');
		expect(await code(setTaskDone(who.boss, await itemId(ids.joiner, 'Meet the team'), true))).toBe('ok');
		expect(await mine('joiner')).toEqual([]);
		expect(await mine('boss')).toEqual([]);
	});

	it('lets whoever can do a task attach proof that its readers can download', async () => {
		const laptop = await itemId(ids.joiner, 'Issue laptop');
		const [receipt] = await addFiles(who.it, 'checklist_item', laptop, [pdf('handover.pdf')]);
		expect((await openFile(who.hr, receipt)).fileName).toBe('handover.pdf');
		expect((await openFile(who.boss, receipt)).fileName).toBe('handover.pdf');
		expect(await code(openFile(who.stranger, receipt))).toBe('not_found');
		expect(await code(addFiles(who.boss, 'checklist_item', laptop, [pdf('x.pdf')]))).toBe('forbidden');
		expect(await code(addFiles(who.stranger, 'checklist_item', laptop, [pdf('x.pdf')]))).toBe('not_found');
		expect(await code(removeFile(who.joiner, { type: 'checklist_item', id: laptop }, receipt))).toBe('forbidden');
		await addFiles(who.hr, 'checklist_item', laptop, [pdf('signed.pdf')]);
		await removeFile(who.it, { type: 'checklist_item', id: laptop }, receipt);
	});

	it('starts offboarding on exit, moves it with the last day and drops it on withdraw', async () => {
		const exit = (exitDate: string) =>
			recordExit(who.hr, ids.staff, { exitDate, exitType: 'resignation', exitReason: '' });
		expect(await code(exit(addDays(today, 10)))).toBe('ok');
		await setTaskDone(who.boss, await itemId(ids.staff, 'Exit talk'), true);
		expect(await code(exit(addDays(today, 20)))).toBe('ok');
		const [leavers, ...rest] = await lists('hr', ids.staff);
		expect(rest).toEqual([]);
		expect([leavers.name, leavers.anchorDate]).toEqual(['Leavers', addDays(today, 20)]);
		expect(leavers.items.map((i) => [i.title, i.dueDate, i.done])).toEqual([
			['Exit talk', addDays(today, 19), true],
			['Collect laptop', addDays(today, 20), false]
		]);
		expect(await mine('it')).toEqual(['Issue laptop/Jo Joiner', 'Collect laptop/Sam Staff']);
		const collect = await itemId(ids.staff, 'Collect laptop');
		await addFiles(who.it, 'checklist_item', collect, [pdf('returned.pdf')]);
		const [proof] = await withTenant(sys(), (tx) => tx.select().from(files).where(eq(files.ownerId, collect)));
		expect(await code(withdrawExit(who.hr, ids.staff))).toBe('ok');
		expect(await lists('hr', ids.staff)).toEqual([]);
		expect(await withTenant(sys(), (tx) => tx.select().from(files).where(eq(files.ownerId, collect)))).toEqual([]);
		expect(await code(getObject(proof.key))).not.toBe('ok');
	});

	it('runs offboarding for a same-day exit and onboarding again on rehire', async () => {
		await recordExit(who.hr, ids.staff, { exitDate: today, exitType: 'termination', exitReason: '' });
		expect(await code(rehire(who.hr, ids.staff, { joinDate: addDays(today, 3) }))).toBe('ok');
		expect((await lists('hr', ids.staff)).map((c) => [c.name, c.anchorDate])).toEqual([
			['Leavers', today],
			['Joiners', addDays(today, 3)]
		]);
	});
});
