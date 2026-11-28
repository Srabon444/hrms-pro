import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePools, ownerPool } from '../../src/lib/server/db';
import { withTestNow } from '../../src/lib/server/clock';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { applyPublic, CAREERS, careersJob, careersPage } from '../../src/lib/server/public/careers';
import { loadAccess, userCtx, type requireMember } from '../../src/lib/server/rbac/access';
import { openingView, purgeTenantCandidates, saveOpening } from '../../src/lib/server/recruitment';
import { closeRedis, redisReady, rkey } from '../../src/lib/server/redis';
import { getObject } from '../../src/lib/server/storage';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { createTenant, createUser, TEST_LOCALE } from './helpers';

type Member = ReturnType<typeof requireMember>;
type Tenant = { id: string; slug: string };
let tenant: Tenant;
let other: Tenant;
let hr: Member;
let jobId: string;
let boardId: string;
const sql = () => ownerPool().sql;
const T0 = '2026-11-20T09:00:00.000Z';
const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();
const code = (p: Promise<unknown>) =>
	p
		.then(() => 'ok')
		.catch((e: { code?: string; issues?: { message: string }[] }) =>
			e.issues ? `invalid: ${e.issues[0].message}` : (e.code ?? String(e))
		);
const pdf = (bytes = 64, name = 'cv.pdf') =>
	new File([new TextEncoder().encode('%PDF-1.4\n'.padEnd(bytes, ' '))], name, { type: 'application/pdf' });
const token = async (slug = tenant.slug, job = 'data-analyst') =>
	(await withTestNow(T0, () => careersJob(slug, job))).formToken;

function formOf(fields: Record<string, string | File>) {
	const f = new FormData();
	for (const [k, v] of Object.entries(fields)) f.append(k, v);
	return f;
}

const applicant = async (email: string, extra: Record<string, string | File> = {}) => ({
	formToken: await token(),
	fullName: 'Rina Akter',
	email,
	phone: '+880 1711-000000',
	consent: 'on',
	cv: pdf(),
	website: '',
	...extra
});

const apply = (fields: Record<string, string | File>, ms = 5000, ip = '203.0.113.7', job = 'data-analyst') =>
	withTestNow(at(ms), () => applyPublic(tenant.slug, job, ip, async () => formOf(fields)));

const rows = (email: string) =>
	sql()<{ id: string; source: string; resume_key: string; resume_type: string; stage: string }[]>`
		select c.id, c.source, c.resume_key, c.resume_type, ps.kind as stage
		from candidates c join pipeline_stages ps on ps.id = c.stage_id
		where c.tenant_id = ${tenant.id} and c.email = ${email}`;

const LIMIT_KEYS = () => [
	rkey('rl', 'careers_ip', `${jobId}:203.0.113.7`),
	rkey('rl', 'careers_ip', `${jobId}:203.0.113.8`),
	rkey('rl', 'careers_opening', jobId),
	rkey('rl', 'careers_tenant', tenant.id)
];
const resetLimits = async () => (await redisReady()).del(...LIMIT_KEYS());

const modules = (t: Tenant, on: string[]) =>
	sql()`update tenant_settings set modules_enabled = ${on} where tenant_id = ${t.id}`;

beforeAll(async () => {
	tenant = await createTenant('car');
	other = await createTenant('carb');
	await withTenant(systemCtx(tenant.id), (tx) => seedTenant(tx, tenant.id, TEST_LOCALE));
	await withTenant(systemCtx(other.id), (tx) => seedTenant(tx, other.id, TEST_LOCALE));
	await modules(tenant, ['careers', 'talent']);
	await modules(other, ['careers']);
	await sql()`update tenant_settings set retention_candidates_days = 90, legal_name = 'Car Ltd',
		address = '1 Road, Dhaka' where tenant_id = ${tenant.id}`;
	const u = await createUser();
	const m = await withTenant(systemCtx(tenant.id), (tx) => addMember(tx, tenant.id, u.id, ['hr_admin']));
	hr = {
		user: { userId: u.id, email: u.email },
		tenant: { id: tenant.id, slug: tenant.slug, name: tenant.slug },
		access: await loadAccess(tenant.id, { id: m, status: 'active', employeeId: null })
	} as unknown as Member;
});

afterAll(async () => {
	await resetLimits();
	await closeRedis();
	await closePools();
});

describe('careers link on the opening', () => {
	it('derives, checks and keeps the public link unique per tenant', async () => {
		const ctx = userCtx(hr);
		const base = { headcount: '1', status: 'open', description: '# Role\n\nCrunch **numbers**.' };
		jobId = await saveOpening(ctx, { ...base, title: 'Data Analyst!', visibility: 'public' });
		boardId = await saveOpening(ctx, { ...base, title: 'Board only', visibility: 'internal' });
		const view = await withTenant(ctx, (tx) => openingView(tx, jobId));
		expect(view.opening.publicSlug).toBe('data-analyst');
		expect((await withTenant(ctx, (tx) => openingView(tx, boardId))).opening.publicSlug).toBeNull();

		const slugOfId = async (id: string) => (await withTenant(ctx, (tx) => openingView(tx, id))).opening.publicSlug;
		expect(
			await code(saveOpening(ctx, { ...base, title: 'Other', visibility: 'both', publicSlug: 'data-analyst' }))
		).toBe('slug_taken');
		const again = await saveOpening(ctx, { ...base, title: 'Data analyst', visibility: 'both', status: 'on_hold' });
		expect(await slugOfId(again)).toBe('data-analyst-2');
		await saveOpening(ctx, { ...base, openingId: again, title: 'Data analyst', visibility: 'none', publicSlug: 'x' });
		expect(await slugOfId(again)).toBeNull();
		expect(await code(saveOpening(ctx, { ...base, title: 'X', visibility: 'public', publicSlug: '-bad' }))).toBe(
			'invalid: Use up to 63 lowercase letters, digits and dashes for the link.'
		);
		expect(
			await code(saveOpening(ctx, { ...base, title: 'X', visibility: 'public', publicSlug: 'a'.repeat(64) }))
		).toBe('invalid: Use up to 63 lowercase letters, digits and dashes for the link.');
		const named = await saveOpening(ctx, { ...base, title: 'Ops', visibility: 'both', publicSlug: ' Ops-Lead ' });
		expect((await withTenant(ctx, (tx) => openingView(tx, named))).opening.publicSlug).toBe('ops-lead');
		const bangla = { ...base, title: 'বিক্রয় কর্মকর্তা', visibility: 'public', status: 'closed' };
		const first = await saveOpening(ctx, bangla);
		const second = await saveOpening(ctx, { ...bangla, title: 'হিসাব কর্মকর্তা' });
		expect([await slugOfId(first), await slugOfId(second)]).toEqual(['job', 'job-2']);
		await saveOpening(ctx, { ...bangla, openingId: first });
		expect(await slugOfId(first)).toBe('job');
	});
});

describe('public careers page', () => {
	it('lists only open public openings of the tenant', async () => {
		const page = await careersPage(tenant.slug);
		expect(page.tenant).toBe(tenant.slug);
		expect(page.openings.map((o) => o.slug).sort()).toEqual(['data-analyst', 'ops-lead']);
		expect(Object.keys(page.openings[0]).sort()).toEqual(['department', 'designation', 'slug', 'title']);
		expect((await careersPage(other.slug)).openings).toEqual([]);
	});

	it('shows the job with retention, contact and a form token', async () => {
		const job = await careersJob(tenant.slug, 'data-analyst');
		expect([job.job.title, job.job.description, job.retentionDays, job.contact]).toEqual([
			'Data Analyst!',
			'# Role\n\nCrunch **numbers**.',
			90,
			{ name: 'Car Ltd', address: '1 Road, Dhaka' }
		]);
		expect(job.job).not.toHaveProperty('id');
		expect(job.formToken).toMatch(/^\d+\.\S+:\S+$/);
	});

	it('hides internal, closed, foreign and unknown jobs and switched-off or suspended tenants', async () => {
		expect(await code(careersJob(tenant.slug, 'board-only'))).toBe('not_found');
		expect(await code(careersJob(tenant.slug, 'job'))).toBe('not_found');
		expect(await code(careersJob(other.slug, 'data-analyst'))).toBe('not_found');
		expect(await code(careersJob(tenant.slug, '../etc'))).toBe('not_found');
		expect(await code(careersPage('no-such-tenant'))).toBe('not_found');
		expect(await code(careersPage('Bad Slug'))).toBe('not_found');

		const off = await applicant('off@example.com');
		const sus = await applicant('sus@example.com');
		await modules(tenant, ['talent']);
		expect(await code(careersPage(tenant.slug))).toBe('not_found');
		expect(await code(apply(off))).toBe('not_found');
		await modules(tenant, ['careers', 'talent']);

		await sql()`update tenants set status = 'suspended' where id = ${tenant.id}`;
		try {
			expect(await code(careersPage(tenant.slug))).toBe('not_found');
			expect(await code(careersJob(tenant.slug, 'data-analyst'))).toBe('not_found');
			expect(await code(apply(sus))).toBe('not_found');
		} finally {
			await sql()`update tenants set status = 'active' where id = ${tenant.id}`;
		}
		expect(await rows('off@example.com')).toEqual([]);
		expect(await rows('sus@example.com')).toEqual([]);
	});
});

describe('applying', () => {
	it('adds a website candidate with the CV in the first stage', async () => {
		await resetLimits();
		expect(await code(apply(await applicant('rina@example.com')))).toBe('ok');
		const [row] = await rows('rina@example.com');
		expect([row.source, row.resume_type, row.stage]).toEqual(['website', 'application/pdf', 'active']);
		expect(row.resume_key).toMatch(new RegExp(`^t/${tenant.id}/resumes/`));
		expect(new TextDecoder().decode((await getObject(row.resume_key)).slice(0, 8))).toBe('%PDF-1.4');
	});

	it('answers a repeat email with the same success and keeps one row', async () => {
		expect(await code(apply(await applicant('RINA@example.com')))).toBe('ok');
		expect(await rows('rina@example.com')).toHaveLength(1);
	});

	it('quietly drops bots: honeypot, too fast, stale, forged or borrowed token', async () => {
		await resetLimits();
		const bot = (email: string) => applicant(email);
		expect(await code(apply({ ...(await bot('b1@example.com')), website: 'http://spam' }))).toBe('ok');
		expect(await code(apply(await bot('b2@example.com'), CAREERS.minFillMs - 1))).toBe('ok');
		expect(await code(apply(await bot('b3@example.com'), CAREERS.maxFormAgeMs + 1))).toBe('ok');
		expect(await code(apply({ ...(await bot('b4@example.com')), formToken: `${Date.parse(T0)}.k1:forged` }))).toBe(
			'ok'
		);
		expect(await code(apply({ ...(await bot('b5@example.com')), formToken: '' }))).toBe('ok');
		const opsToken = await token(tenant.slug, 'ops-lead');
		expect(await code(apply({ ...(await bot('b6@example.com')), formToken: opsToken }, 5000, '203.0.113.8'))).toBe(
			'ok'
		);
		const done = await sql()`select 1 from candidates where tenant_id = ${tenant.id} and email like 'b_@example.com'`;
		expect(done).toHaveLength(0);
	});

	it('checks the fields and the CV on the server', async () => {
		await resetLimits();
		const ok = await applicant('cv@example.com');
		expect(await code(apply({ ...ok, consent: '' }))).toBe('invalid: Agree to how we keep your application.');
		expect(await code(apply({ ...ok, email: 'nope' }))).toBe('invalid: Enter a valid email.');
		expect(await code(apply({ ...ok, fullName: ' ' }))).toBe('invalid: Enter the candidate name.');
		expect(await code(apply({ ...ok, fullName: 'a\0b' }))).toBe('invalid: Remove unsupported characters.');
		await resetLimits();
		expect(await code(apply({ ...ok, phone: 'call me' }))).toBe('invalid: Enter a valid phone number.');
		const { cv: _, ...noCv } = ok;
		expect(await code(apply(noCv))).toBe('no_cv');
		expect(await code(apply({ ...ok, cv: new File(['MZ fake exe'], 'cv.pdf') }))).toBe('unsupported_file');
		expect(await code(apply({ ...ok, cv: pdf(CAREERS.maxCvBytes + 1) }))).toBe('too_large');
		await resetLimits();
		expect(await code(apply({ ...ok, cv: new File(['%PDF-1.7 hidden'], '../\u202ecv.exe') }))).toBe('ok');
		const [cv] = await sql()<{ resume_name: string; resume_type: string }[]>`
			select resume_name, resume_type from candidates where tenant_id = ${tenant.id} and email = 'cv@example.com'`;
		expect(cv).toEqual({ resume_name: 'cv.exe.pdf', resume_type: 'application/pdf' });
	});

	it('limits each address per opening per hour, then each opening and tenant per day', async () => {
		await resetLimits();
		const sent = await [1, 2, 3, 4, 5].reduce(
			(prior, i) => prior.then(async (all) => [...all, await code(apply(await applicant(`ip${i}@example.com`)))]),
			Promise.resolve([] as string[])
		);
		expect(sent).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
		expect(await code(apply(await applicant('ip6@example.com')))).toBe('busy');
		expect(await code(apply(await applicant('ip7@example.com'), 5000, '203.0.113.8'))).toBe('ok');

		const redis = await redisReady();
		await resetLimits();
		await redis.set(rkey('rl', 'careers_opening', jobId), String(CAREERS.perOpeningDay), 'EX', 60);
		expect(await code(apply(await applicant('op@example.com')))).toBe('busy');
		await resetLimits();
		await redis.set(rkey('rl', 'careers_tenant', tenant.id), String(CAREERS.perTenantDay), 'EX', 60);
		expect(await code(apply(await applicant('tn@example.com')))).toBe('busy');
		await resetLimits();
		expect(await rows('op@example.com')).toEqual([]);
		expect(await rows('tn@example.com')).toEqual([]);
	});
});

describe('retention', () => {
	it('purges website candidates with the rest once the opening closed past the window', async () => {
		const [row] = await rows('rina@example.com');
		await sql()`update job_openings set status = 'closed' where id = ${jobId}`;
		const later = new Date(Date.now() + 200 * 86_400_000).toISOString();
		expect(await withTestNow(later, () => purgeTenantCandidates(tenant.id))).toBeGreaterThan(0);
		expect(await rows('rina@example.com')).toEqual([]);
		expect(await code(getObject(row.resume_key))).not.toBe('ok');
	});
});
