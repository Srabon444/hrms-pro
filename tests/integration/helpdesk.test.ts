import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addFiles, listFiles, openFile } from '../../src/lib/server/attachments';
import { withTestNow } from '../../src/lib/server/clock';
import { closePools } from '../../src/lib/server/db';
import {
	memberships,
	notifications,
	rolePermissions,
	roles,
	ticketCategories,
	tickets
} from '../../src/lib/server/db/schema';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from '../../src/lib/server/employees';
import {
	categoryOptions,
	commentOnTicket,
	createTicket,
	requesterAction,
	saveCategory,
	ticketList,
	ticketView,
	updateTicket
} from '../../src/lib/server/helpdesk';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess, userCtx, type requireMember } from '../../src/lib/server/rbac/access';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { createTenant, createUser } from './helpers';

type Member = ReturnType<typeof requireMember>;
let tenant: { id: string; slug: string };
const ids: Record<string, string> = {};
const who: Record<string, Member> = {};
const cat: Record<string, string> = {};
const tix: Record<string, string> = {};
const sys = () => systemCtx(tenant.id);
let clock = '2026-11-24T06:00:00Z';
const at = <T>(fn: () => Promise<T>) => withTestNow(clock, fn);
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
		tenant: { id: tenant.id, slug: tenant.slug, name: tenant.slug },
		access: await loadAccess(tenant.id, { id, status: 'active', employeeId })
	} as unknown as Member;
}

const raise = (key: string, category: string, subject: string, extra: Record<string, string> = {}) =>
	at(() =>
		createTicket(who[key], { categoryId: cat[category], subject, description: `${subject} details`, ...extra })
	).then((r) => r.id);
const list = async (key: string, filter: string | null = null) =>
	(await at(() => withTenant(userCtx(who[key]), (tx) => ticketList(tx, who[key].access, filter)))).rows.map(
		(r) => r.subject
	);
const view = (key: string, id: string) =>
	at(() => withTenant(userCtx(who[key]), (tx) => ticketView(tx, who[key].access, id)));
const update = (key: string, ticket: string, status: string, assignee = '', priority = 'normal') =>
	code(() => updateTicket(who[key], { ticketId: tix[ticket], status, priority, assignee }));
const comment = (key: string, ticket: string, body: string, internal = false) =>
	code(() => commentOnTicket(who[key], { ticketId: tix[ticket], body, internal: internal ? 'on' : '' }));
const act = (key: string, ticket: string, action: string) =>
	code(() => requesterAction(who[key], { ticketId: tix[ticket], action }));
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
const status = async (ticket: string) =>
	(await withTenant(sys(), (tx) => tx.select().from(tickets).where(eq(tickets.id, tix[ticket]))))[0];

beforeAll(async () => {
	tenant = await createTenant('helpdesk');
	await withTenant(sys(), (tx) => seedTenant(tx, tenant.id));
	ids.lea = await hire('Lea');
	ids.ana = await hire('Ana', ids.lea);
	ids.ben = await hire('Ben');
	ids.hana = await hire('Hana');
	await member('lea', ['line_manager'], ids.lea);
	await member('ana', ['employee'], ids.ana);
	await member('ben', ['employee'], ids.ben);
	await member('hr', ['hr_admin', 'employee'], ids.hana);
	await member('it', ['it_asset_manager'], null);
	ids.tia = await hire('Tia');
	await withTenant(sys(), async (tx) => {
		const made = await tx
			.insert(roles)
			.values([
				{ tenantId: tenant.id, key: 'secret_desk', name: 'Secret desk' },
				{ tenantId: tenant.id, key: 'team_desk', name: 'Team desk' }
			])
			.returning({ id: roles.id, key: roles.key });
		const id = (k: string) => made.find((x) => x.key === k)!.id;
		await tx.insert(rolePermissions).values([
			{ tenantId: tenant.id, roleId: id('secret_desk'), permission: 'helpdesk.confidential', scope: 'all' },
			{ tenantId: tenant.id, roleId: id('team_desk'), permission: 'helpdesk.manage', scope: 'team' }
		]);
	});
	await member('cf', ['secret_desk'], null);
	await member('td', ['team_desk'], ids.tia);
	await member('gone', ['it_asset_manager'], null);
	await withTenant(sys(), (tx) =>
		tx.update(memberships).set({ status: 'disabled' }).where(eq(memberships.id, who.gone.access.membershipId))
	);
	for (const c of await withTenant(sys(), (tx) => categoryOptions(tx, true))) cat[c.name] = c.id;
});

afterAll(closePools);

describe('helpdesk', () => {
	it('seeds categories and lets only the right people change them', async () => {
		expect(Object.keys(cat)).toEqual(['Facilities', 'Grievance', 'HR query', 'IT support', 'Payroll']);
		const save = (key: string, f: Record<string, string>) =>
			code(() => saveCategory(who[key], { categoryId: '', slaHours: '8', active: 'on', confidential: '', ...f }));
		expect(await save('ana', { name: 'Laptops' })).toBe('forbidden');
		expect(await save('it', { name: 'Network' })).toBe('ok');
		expect(await save('it', { name: 'network' })).toBe('name_exists');
		expect(await save('it', { name: 'Network 2', slaHours: '0' })).toBe('invalid: Allow at least 1 hour.');
		expect(await save('it', { name: 'Secret', confidential: 'on' })).toBe('forbidden');
		expect(await save('it', { categoryId: cat.Grievance, name: 'Grievance', slaHours: '2', confidential: '' })).toBe(
			'forbidden'
		);
		expect(await save('it', { categoryId: crypto.randomUUID(), name: 'Ghost' })).toBe('not_found');
		expect(await save('hr', { name: 'Harassment', slaHours: '4', confidential: 'on' })).toBe('ok');
		expect(await save('it', { categoryId: cat.Facilities, name: 'Facilities', active: '' })).toBe('ok');
		const now = await withTenant(sys(), (tx) => categoryOptions(tx));
		expect(now.map((c) => `${c.name}:${c.slaHours}:${c.confidential}`)).toEqual([
			'Grievance:24:true',
			'Harassment:4:true',
			'HR query:48:false',
			'IT support:24:false',
			'Network:8:false',
			'Payroll:48:false'
		]);
		const [g] = await withTenant(sys(), (tx) =>
			tx.select().from(ticketCategories).where(eq(ticketCategories.id, cat.Grievance))
		);
		expect(g.slaHours).toBe(24);
	});

	it('numbers tickets, sets the SLA and tells the right agents', async () => {
		tix.vpn = await raise('ana', 'IT support', 'VPN down', { priority: 'high' });
		tix.boss = await raise('ana', 'Grievance', 'Boss issue');
		tix.ben = await raise('ben', 'Payroll', 'Missing bonus');
		expect(await code(() => raise('it', 'IT support', 'No record'))).toBe('no_employee');
		expect(await code(() => raise('ana', 'Facilities', 'Closed category'))).toBe('invalid_category');
		expect(await code(() => raise('ana', 'IT support', '  '))).toBe('invalid: Add a subject.');
		expect(await code(() => raise('ana', 'IT support', 'Odd', { priority: 'meh' }))).toBe(
			'invalid: Choose a priority.'
		);
		const vpn = await status('vpn');
		expect([vpn.number, vpn.priority, vpn.status, vpn.slaDueAt.toISOString()]).toEqual([
			1,
			'high',
			'open',
			'2026-11-25T06:00:00.000Z'
		]);
		expect([(await status('boss')).number, (await status('ben')).number]).toEqual([2, 3]);
		expect(await inbox('it')).toEqual(['New IT support ticket #1: VPN down', 'New Payroll ticket #3: Missing bonus']);
		expect(await inbox('hr')).toEqual([
			'New IT support ticket #1: VPN down',
			'New Grievance ticket #2: Boss issue',
			'New Payroll ticket #3: Missing bonus'
		]);
		expect(await inbox('ana')).toEqual([]);
	});

	it('keeps confidential tickets to the requester and confidential handlers', async () => {
		expect(await list('ana')).toEqual(['Boss issue', 'VPN down']);
		expect(await list('ben')).toEqual(['Missing bonus']);
		expect(await list('lea')).toEqual([]);
		expect(await list('it')).toEqual(['Missing bonus', 'VPN down']);
		expect(await list('hr')).toEqual(['Missing bonus', 'Boss issue', 'VPN down']);
		expect(await view('it', tix.boss)).toBeNull();
		expect(await view('ben', tix.vpn)).toBeNull();
		expect(await view('lea', tix.vpn)).toBeNull();
		expect(await view('it', 'nope')).toBeNull();
		expect((await view('ana', tix.boss))?.agent).toBe(false);
		expect(await list('cf')).toEqual(['Boss issue']);
		const agentIds = async (key: string, t: string) => new Set((await view(key, tix[t]))?.agents.map((a) => a.id));
		expect(await agentIds('hr', 'boss')).toEqual(new Set([who.hr.access.membershipId, who.cf.access.membershipId]));
		expect(await agentIds('it', 'vpn')).toEqual(new Set([who.hr.access.membershipId, who.it.access.membershipId]));
		expect(await update('it', 'boss', 'in_progress')).toBe('not_found');
		expect(await comment('it', 'boss', 'peek')).toBe('not_found');
	});

	it('lets agents assign and move tickets, and tells the requester', async () => {
		expect(await update('ana', 'vpn', 'resolved')).toBe('forbidden');
		expect(await update('ben', 'vpn', 'resolved')).toBe('not_found');
		expect(await update('it', 'vpn', 'in_progress', crypto.randomUUID())).toBe('invalid_assignee');
		expect(await update('hr', 'boss', 'in_progress', who.it.access.membershipId)).toBe('invalid_assignee');
		expect(await update('it', 'vpn', 'paused')).toBe('invalid: Choose a status.');
		expect(await update('it', 'vpn', 'in_progress', who.hr.access.membershipId, 'urgent')).toBe('ok');
		expect(await inbox('hr')).toContain('Ticket #1 VPN down was assigned to you');
		expect(await inbox('ana')).toEqual(['Ticket #1 VPN down is now in progress']);
		expect((await status('vpn')).priority).toBe('urgent');
		expect(await update('hr', 'vpn', 'in_progress', who.hr.access.membershipId, 'urgent')).toBe('ok');
		expect((await inbox('ana')).length).toBe(1);
		expect(await update('it', 'vpn', 'in_progress', who.hr.access.membershipId, 'urgent')).toBe('ok');
		expect((await inbox('hr')).filter((t) => t.includes('assigned'))).toHaveLength(1);
		expect(await update('it', 'vpn', 'waiting', who.it.access.membershipId)).toBe('ok');
		expect((await inbox('it')).filter((t) => t.includes('assigned'))).toEqual([]);
		expect((await view('hr', tix.vpn))?.assignee).toBe((await view('it', tix.vpn))?.assignee);
		expect(await update('hr', 'boss', 'in_progress', who.hr.access.membershipId)).toBe('ok');
		expect((await inbox('hr')).filter((t) => t.includes('Boss'))).toEqual(['New Grievance ticket #2: Boss issue']);
	});

	it('threads comments, hides internal notes and wakes waiting tickets', async () => {
		expect(await comment('it', 'vpn', 'Check the router', true)).toBe('ok');
		expect(await comment('it', 'vpn', 'Which office are you in?')).toBe('ok');
		expect(await comment('ana', 'vpn', 'Secret note', true)).toBe('forbidden');
		expect(await comment('ana', 'vpn', '   ')).toBe('invalid: Write a comment.');
		expect((await status('vpn')).status).toBe('waiting');
		expect(await comment('ana', 'vpn', 'Dhaka office')).toBe('ok');
		expect((await status('vpn')).status).toBe('open');
		expect((await view('ana', tix.vpn))?.comments.map((c) => c.body)).toEqual([
			'Which office are you in?',
			'Dhaka office'
		]);
		expect((await view('it', tix.vpn))?.comments.map((c) => `${c.body}:${c.internal}`)).toEqual([
			'Check the router:true',
			'Which office are you in?:false',
			'Dhaka office:false'
		]);
		expect((await inbox('ana')).filter((t) => t.startsWith('New comment'))).toEqual([
			'New comment on ticket #1 VPN down'
		]);
		expect((await inbox('it')).filter((t) => t.startsWith('New comment'))).toEqual([
			'New comment on ticket #1 VPN down'
		]);
		expect(await comment('ana', 'boss', 'Any update?')).toBe('ok');
		expect((await status('boss')).status).toBe('in_progress');
		expect(await comment('ben', 'ben', 'Any news?')).toBe('ok');
		expect((await inbox('hr')).filter((t) => t.startsWith('New comment on ticket #3'))).toEqual([
			'New comment on ticket #3 Missing bonus'
		]);
		expect((await inbox('it')).filter((t) => t.startsWith('New comment on ticket #3'))).toEqual([
			'New comment on ticket #3 Missing bonus'
		]);
	});

	it('flags tickets past their SLA', async () => {
		clock = '2026-11-25T07:00:00Z';
		expect(await list('it', 'overdue')).toEqual(['VPN down']);
		expect(await list('hr', 'overdue')).toEqual(['Boss issue', 'VPN down']);
		expect(await list('hr', 'mine')).toEqual(['Boss issue']);
		expect(await list('ana', 'mine')).toEqual(['Boss issue', 'VPN down']);
		expect(await list('ana', 'junk')).toEqual(['Boss issue', 'VPN down']);
		expect((await view('it', tix.ben))?.overdue).toBe(false);
	});

	it('lets the requester confirm or reopen a resolved ticket', async () => {
		expect(await act('ana', 'vpn', 'reopen')).toBe('not_resolved');
		expect(await update('it', 'vpn', 'resolved', who.it.access.membershipId)).toBe('ok');
		expect(await update('it', 'vpn', 'in_progress', who.it.access.membershipId)).toBe('ok');
		expect((await status('vpn')).resolvedAt).toBeNull();
		expect(await update('it', 'vpn', 'resolved', who.it.access.membershipId)).toBe('ok');
		const resolved = (await status('vpn')).resolvedAt;
		expect(resolved?.toISOString()).toBe('2026-11-25T07:00:00.000Z');
		expect((await view('it', tix.vpn))?.overdue).toBe(true);
		clock = '2026-11-25T08:00:00Z';
		expect(await update('it', 'vpn', 'resolved', who.it.access.membershipId, 'low')).toBe('ok');
		expect((await status('vpn')).resolvedAt?.toISOString()).toBe(resolved?.toISOString());
		expect(await act('ben', 'vpn', 'reopen')).toBe('not_found');
		expect(await act('it', 'vpn', 'reopen')).toBe('forbidden');
		expect(await act('ana', 'vpn', 'reopen')).toBe('ok');
		expect([(await status('vpn')).status, (await status('vpn')).resolvedAt]).toEqual(['open', null]);
		expect(await inbox('it')).toContain('Ticket #1 VPN down was reopened');
		expect(await update('it', 'vpn', 'resolved', who.it.access.membershipId)).toBe('ok');
		expect(await act('ana', 'vpn', 'close')).toBe('ok');
		expect((await status('vpn')).status).toBe('closed');
		expect(await comment('ana', 'vpn', 'Thanks')).toBe('closed');
		expect(await update('it', 'vpn', 'open', who.it.access.membershipId)).toBe('closed');
		expect(await act('ana', 'vpn', 'reopen')).toBe('not_resolved');
		expect(await list('ana', 'settled')).toEqual(['VPN down']);
		expect(await list('ana', 'junk')).toEqual(['Boss issue']);
		expect(await list('it', 'overdue')).toEqual([]);
		expect((await inbox('it')).filter((t) => t.includes('reopened'))).toHaveLength(1);
	});

	it('keeps agents who raise their own tickets out of their own notifications', async () => {
		tix.own = await raise('hr', 'IT support', 'Laptop slow');
		expect(await inbox('hr')).not.toContain('New IT support ticket #4: Laptop slow');
		expect(await inbox('it')).toContain('New IT support ticket #4: Laptop slow');
		expect(await update('hr', 'own', 'waiting', who.it.access.membershipId)).toBe('ok');
		expect((await inbox('hr')).filter((t) => t.startsWith('Ticket #4'))).toEqual([]);
		expect(await comment('hr', 'own', 'Note to self', true)).toBe('ok');
		expect((await status('own')).status).toBe('waiting');
		expect((await inbox('it')).filter((t) => t.includes('#4'))).toEqual([
			'New IT support ticket #4: Laptop slow',
			'Ticket #4 Laptop slow was assigned to you',
			'New comment on ticket #4 Laptop slow'
		]);
	});

	it('lets the requester attach files to an open ticket and keeps confidential files private', async () => {
		const shot = () => new File(['%PDF-1.7 log'], 'error.pdf');
		const id = await raise('ana', 'IT support', 'Printer jam');
		const secret = await raise('ana', 'Grievance', 'Shouting');
		const files = (key: string, t: string) => withTenant(sys(), (tx) => listFiles(tx, who[key].access, 'ticket', t));
		expect(await code(() => addFiles(who.it, 'ticket', id, [shot()]))).toBe('forbidden');
		const [fid] = await addFiles(who.ana, 'ticket', id, [shot()]);
		const [sid] = await addFiles(who.ana, 'ticket', secret, [shot()]);
		expect((await files('it', id))?.canEdit).toBe(false);
		expect((await openFile(who.it, fid)).fileName).toBe('error.pdf');
		expect(await files('it', secret)).toBeNull();
		expect(await code(() => openFile(who.it, sid))).toBe('not_found');
		expect(await code(() => openFile(who.ben, fid))).toBe('not_found');
		expect((await openFile(who.cf, sid)).fileName).toBe('error.pdf');
		expect(
			await code(() => updateTicket(who.it, { ticketId: id, status: 'resolved', priority: 'normal', assignee: '' }))
		).toBe('ok');
		expect((await files('ana', id))?.canEdit).toBe(false);
		expect(await code(() => addFiles(who.ana, 'ticket', id, [shot()]))).toBe('forbidden');
	});
});
