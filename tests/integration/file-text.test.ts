import { deflateRawSync, deflateSync } from 'node:zlib';
import PDFDocument from 'pdfkit';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveAi } from '../../src/lib/server/ai/settings';
import { closePools, ownerPool } from '../../src/lib/server/db';
import { memberships } from '../../src/lib/server/db/schema';
import { createEmployee, EMPLOYMENT_FIELDS, PROFILE_FIELDS } from '../../src/lib/server/employees';
import { extractFileText, readFileText, reconcileFileTexts } from '../../src/lib/server/file-text';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { savePolicy } from '../../src/lib/server/policies';
import { closeQueues, queue } from '../../src/lib/server/queue';
import { loadAccess, userCtx, type requireMember } from '../../src/lib/server/rbac/access';
import { addCandidate, saveOpening } from '../../src/lib/server/recruitment';
import { closeRedis, redisReady, rkey } from '../../src/lib/server/redis';
import { globalSearch } from '../../src/lib/server/search';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { createTenant, createUser, TEST_LOCALE } from './helpers';

type Member = ReturnType<typeof requireMember>;
type Tenant = { id: string; slug: string };
let a: Tenant;
let b: Tenant;
let opening: string;
const who: Record<string, Member> = {};
const sql = () => ownerPool().sql;
const blanks = Object.fromEntries(Object.keys({ ...PROFILE_FIELDS, ...EMPLOYMENT_FIELDS }).map((k) => [k, '']));
const creator = {
	membershipId: '',
	employeeId: null,
	grants: { 'employee.read': ['all'], 'employee.create': ['all'] },
	roleKeys: [],
	isOwner: false
};

async function member(key: string, t: Tenant, roleKeys: string[]) {
	const employeeId = await createEmployee({ tenantId: t.id, actor: 'user' }, creator as never, {
		...blanks,
		fullName: key,
		employmentType: 'full_time',
		status: 'active',
		joinDate: '2026-01-01'
	});
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

const pdf = (lines: string[]) =>
	new Promise<File>((resolve) => {
		const doc = new PDFDocument();
		const chunks: Buffer[] = [];
		doc.on('data', (c: Buffer) => chunks.push(c));
		doc.on('end', () => resolve(new File([Buffer.concat(chunks)], 'policy.pdf', { type: 'application/pdf' })));
		lines.forEach((l) => doc.text(l));
		doc.end();
	});
const png = () => {
	const bytes = new Uint8Array(256);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	return new File([bytes], 'cv.png', { type: 'image/png' });
};
const zip = (files: Record<string, Buffer>) => {
	const parts: Buffer[] = [];
	const central: Buffer[] = [];
	const offset = Object.entries(files).reduce((at, [name, raw]) => {
		const data = deflateRawSync(raw);
		const n = Buffer.from(name);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(8, 8);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(raw.length, 22);
		local.writeUInt16LE(n.length, 26);
		const cd = Buffer.alloc(46);
		cd.writeUInt32LE(0x02014b50, 0);
		cd.writeUInt16LE(8, 10);
		cd.writeUInt32LE(data.length, 20);
		cd.writeUInt32LE(raw.length, 24);
		cd.writeUInt16LE(n.length, 28);
		cd.writeUInt32LE(at, 42);
		parts.push(local, n, data);
		central.push(cd, n);
		return at + 30 + n.length + data.length;
	}, 0);
	const dir = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(Object.keys(files).length, 8);
	end.writeUInt16LE(Object.keys(files).length, 10);
	end.writeUInt32LE(dir.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...parts, dir, end]);
};
const docx = (xml: Buffer) =>
	new File([zip({ '[Content_Types].xml': Buffer.from('<Types/>'), 'word/document.xml': xml })], 'cv.docx');
const bombPdf = (mb: number) => {
	const stream = deflateSync(
		Buffer.concat([
			Buffer.from('BT /F1 12 Tf 72 720 Td ('),
			Buffer.alloc(mb * 1024 * 1024, 0x41),
			Buffer.from(') Tj ET')
		])
	);
	return Buffer.concat([
		Buffer.from(
			'%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
				'3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>endobj\n' +
				`4 0 obj<</Length ${stream.length}/Filter/FlateDecode>>stream\n`
		),
		stream,
		Buffer.from(
			'\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF'
		)
	]);
};
const policyJob = async (id: string) => {
	const [p] = await sql()<{ sha256: string }[]>`select sha256 from policies where id = ${id}`;
	return `ft-${a.id}-p-${id}-${p.sha256.slice(0, 16)}`;
};
const textOf = async (column: 'policy_id' | 'candidate_id', id: string) =>
	(
		await sql()<
			{ status: string; text: string; model: string | null; attempts: number; last_error: string | null }[]
		>`select status, text, model, attempts, last_error from file_texts where ${sql()(column)} = ${id}`
	)[0];
const find = (key: string, q: string) =>
	withTenant(userCtx(who[key]), (tx) => globalSearch(tx, { access: who[key].access, active: true }, q));
const aiOn = (on: boolean) => {
	const f = new FormData();
	Object.entries({ provider: 'gemini', model: '', apiKey: '', budget: '2000000', consent: 'on' }).forEach(([k, v]) =>
		f.set(k, v)
	);
	if (on) f.set('enabled', 'on');
	['ask', 'ocr', 'write'].forEach((x) => f.append('features', x));
	return saveAi(who.hr, f);
};
const policy = async (title: string, lines: string[], policyId = '') =>
	(await savePolicy(who.hr, { policyId, title, requiresAck: '', active: 'on' }, await pdf(lines))).id;
const candidate = (fullName: string, file: File) =>
	addCandidate(userCtx(who.hr), { openingId: opening, fullName, email: '' }, file);

beforeAll(async () => {
	a = await createTenant('ftext');
	b = await createTenant('ftextb');
	await withTenant(systemCtx(a.id), (tx) => seedTenant(tx, a.id, TEST_LOCALE));
	await withTenant(systemCtx(b.id), (tx) => seedTenant(tx, b.id, TEST_LOCALE));
	await member('hr', a, ['hr_admin']);
	await member('emp', a, ['employee']);
	await member('other', b, ['hr_admin']);
	opening = await saveOpening(userCtx(who.hr), { title: 'Night guard', headcount: '1' });
	const r = await redisReady();
	const keys = await r.keys(`${rkey('t', a.id, 'ai')}*`);
	if (keys.length) await r.del(...keys);
});

afterAll(async () => {
	await closeQueues();
	await closeRedis();
	await closePools();
});

describe('policy text', () => {
	it('reads the text layer for free and lets staff search inside the file', async () => {
		const id = await policy('Leave rules', ['Staff get twenty days of annual leave.', 'Carry over is capped at five.']);
		expect(await queue('file-text').getJob(await policyJob(id))).toBeTruthy();
		await extractFileText({ tenantId: a.id, policyId: id });
		expect(await textOf('policy_id', id)).toMatchObject({ status: 'ok', model: null, attempts: 1 });
		expect((await textOf('policy_id', id)).text).toContain('twenty days of annual leave');
		expect((await sql()`select 1 from ai_usage where tenant_id = ${a.id} and feature = 'index'`).length).toBe(0);
		const hits = await find('emp', 'annual leave');
		expect(hits).toContainEqual(
			expect.objectContaining({
				kind: 'policy',
				id,
				href: `policies/${id}/file`,
				sub: expect.stringContaining('annual leave')
			})
		);
		expect(await find('other', 'annual leave')).toEqual([]);
		expect((await find('emp', '-zzzzqq')).some((h) => h.kind === 'policy')).toBe(false);
	});

	it('drops stale text when the file is replaced and hides inactive policies from staff', async () => {
		const id = await policy('Overtime', ['Overtime is paid at double the hourly rate.']);
		await extractFileText({ tenantId: a.id, policyId: id });
		const oldJob = await policyJob(id);
		await policy('Overtime', ['Overtime needs approval from your manager first.'], id);
		expect(await textOf('policy_id', id)).toBeUndefined();
		expect(await policyJob(id)).not.toBe(oldJob);
		expect(await queue('file-text').getJob(await policyJob(id))).toBeTruthy();
		expect((await find('emp', 'double hourly')).some((h) => h.id === id)).toBe(false);
		await extractFileText({ tenantId: a.id, policyId: id });
		expect((await find('emp', 'manager approval')).some((h) => h.id === id)).toBe(true);
		await savePolicy(who.hr, { policyId: id, title: 'Overtime', requiresAck: '', active: '' }, null);
		expect((await find('emp', 'manager approval')).some((h) => h.id === id)).toBe(false);
		expect((await find('hr', 'manager approval')).find((h) => h.id === id)?.href).toBe(`policies/${id}`);
	});
});

describe('CV text', () => {
	it('waits for AI before reading an image, then reads it with OCR and charges the tenant', async () => {
		await aiOn(false);
		const id = await candidate('Imran', png());
		await extractFileText({ tenantId: a.id, candidateId: id });
		expect(await textOf('candidate_id', id)).toMatchObject({ status: 'failed', attempts: 0, last_error: 'disabled' });
		await aiOn(true);
		await queue('file-text').remove(`ft-${a.id}-c-${id}`);
		await reconcileFileTexts();
		expect(await queue('file-text').getJob(`ft-${a.id}-c-${id}`)).toBeTruthy();
		await extractFileText({ tenantId: a.id, candidateId: id });
		expect(await textOf('candidate_id', id)).toMatchObject({
			status: 'ok',
			text: 'Night shift allowance is paid with the monthly salary.',
			model: 'gemini-4-neon'
		});
		const usage = await sql()`
			select membership_id from ai_usage where tenant_id = ${a.id} and feature = 'index' and ok`;
		expect(usage).toEqual([{ membership_id: null }]);
		expect((await find('hr', 'night shift allowance')).some((h) => h.kind === 'candidate' && h.id === id)).toBe(true);
		expect((await find('emp', 'night shift allowance')).some((h) => h.kind === 'candidate')).toBe(false);
	});

	it('sends a scanned PDF without a text layer to OCR', async () => {
		const id = await candidate('Scanned', await pdf([]));
		await extractFileText({ tenantId: a.id, candidateId: id });
		expect(await textOf('candidate_id', id)).toMatchObject({ status: 'ok', model: 'gemini-4-neon' });
	});

	it('reads a scanned PDF and a PDF holding only a watermark with OCR', async () => {
		const blank = await candidate('Scanned', await pdf([]));
		const marked = await candidate('Marked', await pdf(['Scanned with CamScanner']));
		await extractFileText({ tenantId: a.id, candidateId: blank });
		await extractFileText({ tenantId: a.id, candidateId: marked });
		expect(await textOf('candidate_id', blank)).toMatchObject({ status: 'ok', model: 'gemini-4-neon' });
		expect(await textOf('candidate_id', marked)).toMatchObject({
			status: 'ok',
			model: 'gemini-4-neon',
			text: 'Night shift allowance is paid with the monthly salary.'
		});
	});

	it('reads Word resumes locally and refuses a zip bomb for good', async () => {
		const id = await candidate(
			'Worded',
			docx(
				Buffer.from(
					'<w:document><w:body><w:p><w:r><w:t>Five years of payroll &amp; tax</w:t></w:r></w:p>' +
						'<w:p><w:r><w:t>Dhaka &#x2014; Bangladesh</w:t></w:r></w:p></w:body></w:document>'
				)
			)
		);
		await extractFileText({ tenantId: a.id, candidateId: id });
		expect(await textOf('candidate_id', id)).toMatchObject({
			status: 'ok',
			model: null,
			text: 'Five years of payroll & tax\nDhaka \u2014 Bangladesh'
		});
		expect((await find('hr', 'payroll tax')).some((h) => h.kind === 'candidate' && h.id === id)).toBe(true);
		const bomb = await candidate('Bomb', docx(Buffer.alloc(40 * 1024 * 1024, 0x20)));
		await extractFileText({ tenantId: a.id, candidateId: bomb });
		expect(await textOf('candidate_id', bomb)).toMatchObject({
			status: 'failed',
			attempts: 3,
			last_error: 'too_complex'
		});
		await sql()`update file_texts set next_retry_at = now() - interval '1 minute' where candidate_id = ${bomb}`;
		await queue('file-text').remove(`ft-${a.id}-c-${bomb}`);
		await reconcileFileTexts();
		expect(await queue('file-text').getJob(`ft-${a.id}-c-${bomb}`)).toBeUndefined();
	});

	it('stops a PDF that inflates past the memory limit without hurting the worker', async () => {
		const started = Date.now();
		const heap = process.memoryUsage().heapUsed;
		await expect(readFileText(a.id, bombPdf(300), 'application/pdf')).rejects.toThrow('too_complex');
		expect(Date.now() - started).toBeLessThan(25_000);
		expect(process.memoryUsage().heapUsed - heap).toBeLessThan(200 * 1024 * 1024);
	}, 60_000);

	it('records a missing file and retries fixable AI errors once AI settings are saved again', async () => {
		const gone = await candidate('Gone', png());
		await sql()`update candidates set resume_key = ${`t/${a.id}/resumes/missing`} where id = ${gone}`;
		await extractFileText({ tenantId: a.id, candidateId: gone });
		expect(await textOf('candidate_id', gone)).toMatchObject({ status: 'failed', attempts: 1, last_error: 'missing' });
		await sql()`update file_texts set attempts = 3, last_error = 'key_invalid' where candidate_id = ${gone}`;
		await aiOn(true);
		expect(await textOf('candidate_id', gone)).toMatchObject({ attempts: 0, last_error: 'key_invalid' });
		expect(
			(await sql()`select 1 from file_texts where tenant_id = ${a.id} and last_error = 'too_complex' and attempts = 3`)
				.length
		).toBe(1);
	});
});
