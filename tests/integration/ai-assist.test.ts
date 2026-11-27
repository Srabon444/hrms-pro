import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { keyAad } from '../../src/lib/server/ai/service';
import { saveAi } from '../../src/lib/server/ai/settings';
import { encrypt } from '../../src/lib/server/auth/crypto';
import { closePools, ownerPool } from '../../src/lib/server/db';
import { memberships } from '../../src/lib/server/db/schema';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from '../../src/lib/server/employees';
import { categoryOptions, commentOnTicket, createTicket } from '../../src/lib/server/helpdesk';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { closeRedis, redisReady, rkey } from '../../src/lib/server/redis';
import { loadAccess, userCtx, type requireMember } from '../../src/lib/server/rbac/access';
import { addCandidate, saveOpening } from '../../src/lib/server/recruitment';
import { putObject } from '../../src/lib/server/storage';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { generate } from '../../src/lib/server/ai/service';
import { POST as announcementDraft } from '../../src/routes/t/[slug]/announcements/draft/+server';
import { POST as documentOcr } from '../../src/routes/t/[slug]/employees/[employeeId]/documents/ocr/+server';
import { POST as receiptOcr } from '../../src/routes/t/[slug]/expenses/ocr/+server';
import { POST as replyDraft } from '../../src/routes/t/[slug]/helpdesk/[ticketId]/draft/+server';
import { POST as cvOcr } from '../../src/routes/t/[slug]/recruitment/[openingId]/cv/+server';
import { POST as openingDraft } from '../../src/routes/t/[slug]/recruitment/draft/+server';
import { createTenant, createUser, TEST_LOCALE } from './helpers';

vi.mock('../../src/lib/server/storage', async (load) => {
	const real = await load<typeof import('../../src/lib/server/storage')>();
	return { ...real, putObject: vi.fn(real.putObject) };
});
vi.mock('../../src/lib/server/ai/service', async (load) => {
	const real = await load<typeof import('../../src/lib/server/ai/service')>();
	return { ...real, generate: vi.fn(real.generate) };
});

type Member = ReturnType<typeof requireMember>;
type Tenant = { id: string; slug: string };
type Handler = (event: never) => Response | Promise<Response>;
let a: Tenant;
let b: Tenant;
const who: Record<string, Member> = {};
const ids: Record<string, string> = {};
const sql = () => ownerPool().sql;
const blanks = Object.fromEntries(Object.keys({ ...PROFILE_FIELDS, ...EMPLOYMENT_FIELDS }).map((k) => [k, '']));
const creator = {
	membershipId: '',
	employeeId: null,
	grants: { 'employee.read': ['all'], 'employee.create': ['all'], 'employee.update': ['all'] },
	roleKeys: [],
	isOwner: false
};
const hire = (t: Tenant, fullName: string) =>
	createEmployee({ tenantId: t.id, actor: 'user' }, creator as never, {
		...blanks,
		fullName,
		employmentType: 'full_time',
		status: 'active',
		joinDate: '2026-01-01'
	});

async function member(key: string, t: Tenant, roleKeys: string[], employeeId: string | null) {
	const u = await createUser();
	const id = await withTenant(systemCtx(t.id), async (tx) => {
		const membershipId = await addMember(tx, t.id, u.id, roleKeys);
		await tx.update(memberships).set({ employeeId }).where(eq(memberships.id, membershipId));
		return membershipId;
	});
	who[key] = {
		user: { userId: u.id },
		tenant: { id: t.id, slug: t.slug, name: t.slug, require2faForSensitive: false, aiPlatform: true },
		access: await loadAccess(t.id, { id, status: 'active', employeeId })
	} as unknown as Member;
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const png = (size = 64) => {
	const bytes = new Uint8Array(size);
	bytes.set(PNG);
	return new File([bytes], 'scan.png', { type: 'image/png' });
};
const textFile = () => new File(['just some text'], 'notes.png', { type: 'image/png' });

const call = async (
	handler: Handler,
	key: string,
	fields: Record<string, string | File> = {},
	params: Record<string, string> = {}
) => {
	const body = new FormData();
	Object.entries(fields).forEach(([k, v]) => body.set(k, v));
	const m = who[key];
	const event = {
		locals: { user: m.user, tenant: m.tenant, access: m.access },
		params: { slug: m.tenant.slug, ...params },
		request: new Request('http://localhost/x', { method: 'POST', body })
	};
	try {
		const res = await handler(event as never);
		return {
			status: res.status,
			body: (await res.json()) as { fill?: Record<string, string>; note?: string; code?: string }
		};
	} catch (err) {
		return { status: (err as { status: number }).status, body: {} };
	}
};
const usage = async (key: string) =>
	(
		await sql()<{ feature: string; ok: boolean }[]>`
		select feature, ok from ai_usage where membership_id = ${who[key].access.membershipId} order by created_at`
	).map((r) => `${r.feature}:${r.ok}`);
const setFeatures = (features: string[]) =>
	saveAi(
		who.hr,
		(() => {
			const f = new FormData();
			Object.entries({
				enabled: 'on',
				consent: 'on',
				provider: 'gemini',
				model: '',
				apiKey: '',
				budget: '2000000'
			}).forEach(([k, v]) => f.set(k, v));
			features.forEach((x) => f.append('features', x));
			return f;
		})()
	);

beforeAll(async () => {
	a = await createTenant('aiassist');
	b = await createTenant('aiassistb');
	await withTenant(systemCtx(a.id), (tx) => seedTenant(tx, a.id, TEST_LOCALE));
	await withTenant(systemCtx(b.id), (tx) => seedTenant(tx, b.id, TEST_LOCALE));
	await sql()`update tenant_settings set currency = 'BDT' where tenant_id = ${a.id}`;
	ids.hana = await hire(a, 'Hana');
	ids.ana = await hire(a, 'Ana');
	ids.bob = await hire(b, 'Bob');
	await member('hr', a, ['hr_admin', 'employee'], ids.hana);
	await member('ana', a, ['employee'], ids.ana);
	await member('hrB', b, ['hr_admin', 'employee'], null);
	await member('it', a, ['it_asset_manager'], null);
	who.none = { ...who.it, access: { ...who.it.access, grants: {} } } as Member;
	await setFeatures(['ask', 'ocr', 'write']);
	const [meals] = await sql()<{ id: string }[]>`
		insert into expense_categories (tenant_id, name, active) values (${a.id}, 'Meals', true) returning id`;
	ids.meals = meals.id;
	ids.opening = await saveOpening(userCtx(who.hr), { title: 'QA Engineer', headcount: '1' });
	ids.openingB = await saveOpening(userCtx(who.hrB), { title: 'Other', headcount: '1' });
	const [dept] = await sql()<{ id: string }[]>`
		insert into departments (tenant_id, name) values (${a.id}, 'Quality') returning id`;
	ids.dept = dept.id;
	const [deptB] = await sql()<{ id: string }[]>`
		insert into departments (tenant_id, name) values (${b.id}, 'Hidden') returning id`;
	ids.deptB = deptB.id;
	const r = await redisReady();
	const keys = await r.keys(`${rkey('t', a.id, 'ai')}*`);
	if (keys.length) await r.del(...keys);
});

afterAll(async () => {
	await closeRedis();
	await closePools();
});

describe('receipt OCR', () => {
	it('fills the expense row, stores nothing and counts usage', async () => {
		vi.mocked(putObject).mockClear();
		const res = await call(receiptOcr, 'hr', { file: png() });
		expect(res).toEqual({
			status: 200,
			body: { fill: { description: 'City Cafe', spentOn: '2026-01-15', amount: '450.50', categoryId: ids.meals } }
		});
		expect(putObject).not.toHaveBeenCalled();
		expect((await sql()`select 1 from expense_claims where tenant_id = ${a.id}`).length).toBe(0);
		expect(await usage('hr')).toEqual(['ocr:true']);
	});

	it('leaves the amount out when the receipt is in another currency', async () => {
		await sql()`update tenant_settings set currency = 'USD' where tenant_id = ${a.id}`;
		const res = await call(receiptOcr, 'hr', { file: png() });
		await sql()`update tenant_settings set currency = 'BDT' where tenant_id = ${a.id}`;
		expect(res.body.fill?.amount).toBeUndefined();
		expect(res.body.note).toMatch(/not in USD/);
	});

	it('rejects missing, wrong and big files before any AI call', async () => {
		vi.mocked(generate).mockClear();
		expect((await call(receiptOcr, 'hr')).body.code).toBe('no_file');
		expect(await call(receiptOcr, 'hr', { file: textFile() })).toMatchObject({ status: 415 });
		expect(await call(receiptOcr, 'hr', { file: png(10 * 1024 * 1024 + 1) })).toMatchObject({ status: 413 });
		expect(generate).not.toHaveBeenCalled();
	});

	it('needs expense.submit and an employee record', async () => {
		expect((await call(receiptOcr, 'none', { file: png() })).status).toBe(403);
		expect(await call(receiptOcr, 'it', { file: png() })).toMatchObject({ status: 409, body: { code: 'no_employee' } });
		expect((await call(receiptOcr, 'ana', { file: png() })).status).toBe(200);
	});

	it('stops when the tenant turns OCR off', async () => {
		await setFeatures(['ask', 'write']);
		const res = await call(receiptOcr, 'hr', { file: png() });
		await setFeatures(['ask', 'ocr', 'write']);
		expect(res).toMatchObject({ status: 409, body: { code: 'disabled' } });
	});
});

describe('CV OCR', () => {
	it('fills the candidate form and warns about a known email', async () => {
		const first = await call(cvOcr, 'hr', { file: png() }, { openingId: ids.opening });
		expect(first.body).toEqual({
			fill: {
				fullName: 'Rina Akter',
				email: 'rina.akter@example.com',
				phone: '+880 1711 000000',
				tags: 'Playwright, SQL',
				notes: 'QA Engineer, 4 years of experience'
			}
		});
		await addCandidate(
			userCtx(who.hr),
			{ openingId: ids.opening, fullName: 'Rina', email: 'rina.akter@example.com' },
			null
		);
		const again = await call(cvOcr, 'hr', { file: png() }, { openingId: ids.opening });
		expect(again.body.note).toBe('That email is already a candidate for this opening.');
	});

	it('hides other tenants openings and refuses people without recruitment.manage', async () => {
		expect((await call(cvOcr, 'hr', { file: png() }, { openingId: ids.openingB })).status).toBe(404);
		expect((await call(cvOcr, 'hr', { file: png() }, { openingId: 'nope' })).status).toBe(404);
		expect((await call(cvOcr, 'ana', { file: png() }, { openingId: ids.opening })).status).toBe(403);
	});
});

describe('document OCR', () => {
	it('fills title and expiry for a certificate', async () => {
		const res = await call(documentOcr, 'hr', { file: png(), category: 'certificate' }, { employeeId: ids.ana });
		expect(res.body).toEqual({ fill: { title: 'AWS Certified Developer', expiresOn: '2029-03-31' } });
	});

	it('refuses identity and contract documents and people out of scope', async () => {
		vi.mocked(generate).mockClear();
		for (const category of ['identity', 'contract', ''])
			expect(await call(documentOcr, 'hr', { file: png(), category }, { employeeId: ids.ana })).toMatchObject({
				status: 400,
				body: { code: 'refused' }
			});
		expect(
			(await call(documentOcr, 'hr', { file: png(), category: 'certificate' }, { employeeId: ids.bob })).status
		).toBe(404);
		expect(
			(await call(documentOcr, 'ana', { file: png(), category: 'certificate' }, { employeeId: ids.ana })).status
		).toBe(403);
		expect(generate).not.toHaveBeenCalled();
	});
});

describe('writing help', () => {
	it('drafts an announcement body from the title', async () => {
		expect((await call(announcementDraft, 'hr')).body.code).toBe('invalid');
		const res = await call(announcementDraft, 'hr', { title: 'Team outing' });
		expect(res.body.fill?.body).toMatch(/^The office will close early/);
		expect((await call(announcementDraft, 'ana', { title: 'Hi' })).status).toBe(403);
	});

	it('drafts a job description and only accepts this tenants departments', async () => {
		const res = await call(openingDraft, 'hr', { title: 'QA Engineer', departmentId: ids.dept, designationId: '' });
		expect(res.body.fill?.description).toMatch(/^We are hiring/);
		const parts = vi.mocked(generate).mock.lastCall![2].parts;
		expect(parts).toEqual([{ text: 'Job title: QA Engineer\nDepartment: Quality' }]);
		expect(
			await call(openingDraft, 'hr', { title: 'QA Engineer', departmentId: ids.deptB, designationId: '' })
		).toMatchObject({ status: 400, body: { code: 'invalid' } });
	});

	it('suggests a ticket reply without internal notes and never for confidential tickets', async () => {
		const cats = Object.fromEntries(
			(await withTenant(systemCtx(a.id), (tx) => categoryOptions(tx, true))).map((c) => [c.name, c.id])
		);
		const open = await createTicket(who.ana, {
			categoryId: cats['HR query'],
			subject: 'Leave rule',
			description: 'How many days?'
		});
		await commentOnTicket(who.hr, { ticketId: open.id, body: 'Secret internal hint', internal: 'on' });
		await commentOnTicket(who.ana, { ticketId: open.id, body: 'Any update?', internal: '' });
		const res = await call(replyDraft, 'hr', {}, { ticketId: open.id });
		expect(res.body.fill?.body).toMatch(/^Thanks for raising this/);
		const sent = JSON.stringify(vi.mocked(generate).mock.lastCall![2].parts);
		expect(sent).toContain('Any update?');
		expect(sent).not.toContain('Secret internal hint');
		expect((await call(replyDraft, 'ana', {}, { ticketId: open.id })).status).toBe(403);
		const secret = await createTicket(who.ana, {
			categoryId: cats.Grievance,
			subject: 'Private',
			description: 'Private matter'
		});
		expect(await call(replyDraft, 'hr', {}, { ticketId: secret.id })).toMatchObject({
			status: 400,
			body: { code: 'refused' }
		});
		expect((await call(replyDraft, 'hrB', {}, { ticketId: open.id })).status).toBe(404);
	});
});

describe('limits', () => {
	it('blocks big images for Anthropic keys before sending', async () => {
		await sql()`
			update ai_settings set provider = 'anthropic', key_enc = ${encrypt('sk-ant-fake-key', undefined, keyAad(a.id))}, key_hint = 'key'
			where tenant_id = ${a.id}`;
		const res = await call(receiptOcr, 'hr', { file: png(6 * 1024 * 1024) });
		await sql()`update ai_settings set provider = 'gemini', key_enc = null, key_hint = null where tenant_id = ${a.id}`;
		expect(res).toMatchObject({ status: 413, body: { code: 'file_too_large' } });
	});

	it('caps OCR at the per-minute OCR limit', async () => {
		await member('busy', a, ['employee'], await hire(a, 'Busy'));
		const runs = await Array.from({ length: 11 }).reduce<Promise<number[]>>(
			(prior) => prior.then(async (acc) => [...acc, (await call(receiptOcr, 'busy', { file: png() })).status]),
			Promise.resolve([])
		);
		expect(runs.slice(0, 10).every((s) => s === 200)).toBe(true);
		expect(runs[10]).toBe(429);
	});
});
