import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { closePools } from '../../src/lib/server/db';
import { auditLog, candidates, departments, designations } from '../../src/lib/server/db/schema';
import {
	addCandidate,
	candidateView,
	moveCandidate,
	openingView,
	openResume,
	recruitmentBoard,
	saveOpening
} from '../../src/lib/server/recruitment';
import { getObject } from '../../src/lib/server/storage';
import { withTenant, type TenantCtx } from '../../src/lib/server/tenancy';
import { createTenant } from './helpers';

let ctx: TenantCtx;
let other: TenantCtx;
let dept: string;
let desig: string;
const pdf = (name = 'cv.pdf') => new File(['%PDF-1.7 resume'], name, { type: 'application/pdf' });
const code = (p: Promise<unknown>) =>
	p
		.then(() => 'ok')
		.catch((e: { code?: string; issues?: { message: string }[] }) =>
			e.issues ? `invalid: ${e.issues[0].message}` : (e.code ?? String(e))
		);
const opening = { title: 'Backend engineer', departmentId: '', designationId: '', headcount: '2', description: '' };

beforeAll(async () => {
	const t = await createTenant('ats');
	ctx = { tenantId: t.id, actor: 'user', userId: undefined };
	other = { tenantId: (await createTenant('ats-other')).id, actor: 'user' };
	[dept, desig] = await withTenant(ctx, async (tx) => [
		(await tx.insert(departments).values({ tenantId: t.id, name: 'Engineering' }).returning())[0].id,
		(await tx.insert(designations).values({ tenantId: t.id, name: 'Engineer' }).returning())[0].id
	]);
});
afterAll(closePools);

it('opens a job with the default pipeline and refuses bad input', async () => {
	expect(await code(saveOpening(ctx, { ...opening, title: ' ' }))).toBe('invalid: Enter the job title.');
	expect(await code(saveOpening(ctx, { ...opening, headcount: '0' }))).toBe('invalid: Headcount is 1 to 500.');
	expect(await code(saveOpening(ctx, { ...opening, headcount: '1.5' }))).toBe('invalid: Headcount is 1 to 500.');
	expect(await code(saveOpening(ctx, { ...opening, departmentId: crypto.randomUUID() }))).toBe('invalid_department');
	const foreign = await withTenant(
		other,
		async (tx) => (await tx.insert(designations).values({ tenantId: other.tenantId, name: 'Spy' }).returning())[0].id
	);
	expect(await code(saveOpening(ctx, { ...opening, designationId: foreign }))).toBe('invalid_designation');

	const id = await saveOpening(ctx, { ...opening, departmentId: dept, designationId: desig });
	const view = await withTenant(ctx, (tx) => openingView(tx, id));
	expect([view.opening.title, view.opening.headcount, view.opening.status]).toEqual(['Backend engineer', 2, 'open']);
	expect(view.stages.map((s) => [s.name, s.kind])).toEqual([
		['Applied', 'active'],
		['Screening', 'active'],
		['Interview', 'active'],
		['Offer', 'active'],
		['Hired', 'hired'],
		['Rejected', 'rejected']
	]);
	await saveOpening(ctx, { ...opening, openingId: id, title: 'Senior backend engineer', status: 'on_hold' });
	expect((await withTenant(ctx, (tx) => openingView(tx, id))).opening.title).toBe('Senior backend engineer');
	expect(await code(saveOpening(ctx, { ...opening, openingId: crypto.randomUUID() }))).toBe('not_found');
	expect(await code(withTenant(other, (tx) => openingView(tx, id)))).toBe('not_found');
});

it('adds candidates with a resume, moves them through stages and counts the funnel', async () => {
	const id = await saveOpening(ctx, { ...opening, title: 'QA engineer' });
	const add = (raw: Record<string, string>, file: File | null = null) =>
		addCandidate(ctx, { openingId: id, fullName: 'Rafi', ...raw }, file);
	expect(await code(add({ fullName: '' }))).toBe('invalid: Enter the candidate name.');
	expect(await code(add({ email: 'nope' }))).toBe('invalid: Enter a valid email.');
	expect(await code(add({ phone: 'call me' }))).toBe('invalid: Enter a valid phone number.');
	expect(await code(add({ tags: 'a,b,c,d,e,f,g,h,i,j,k' }))).toBe(
		'invalid: Use up to 10 tags, each under 30 characters.'
	);
	expect(await code(add({}, new File(['MZ'], 'cv.pdf')))).toBe('unsupported_file');
	expect(await code(add({}, new File(['\x89PNG\r\n\x1a\n'], 'cv.png')))).toBe('unsupported_file');
	expect(await code(add({}, new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'cv.pdf')))).toBe('too_large');

	const rafi = await add({ email: 'rafi@example.com', source: 'referral', tags: 'go, sql, go' }, pdf());
	expect(await code(add({ fullName: 'Rafi again', email: 'RAFI@example.com' }))).toBe('duplicate');
	const mina = await add({ fullName: 'Mina' });

	const view = await withTenant(ctx, (tx) => openingView(tx, id));
	const stage = Object.fromEntries(view.stages.map((s) => [s.name, s.id]));
	expect(view.candidates.find((c) => c.id === rafi)!.tags).toEqual(['go', 'sql']);
	expect(view.funnel.map((f) => f.count)).toEqual([2, 0, 0, 0, 0, 0]);

	const move = (candidateId: string, to: string, note = '') =>
		moveCandidate(ctx, { candidateId, stageId: stage[to], note });
	await move(rafi, 'Screening', 'Strong CV');
	await move(rafi, 'Interview');
	expect(await code(move(rafi, 'Interview'))).toBe('same_stage');
	expect(await code(move(rafi, 'Hired'))).toBe('use_hire');
	const qa2 = await saveOpening(ctx, { ...opening, title: 'Another' });
	const otherStage = (await withTenant(ctx, (tx) => openingView(tx, qa2))).stages[1].id;
	expect(await code(moveCandidate(ctx, { candidateId: rafi, stageId: otherStage }))).toBe('invalid_stage');

	await saveOpening(ctx, { ...opening, openingId: id, title: 'QA engineer', status: 'closed' });
	expect(await code(add({ fullName: 'Late' }))).toBe('not_open');
	expect(await code(move(mina, 'Screening'))).toBe('closed');
	await move(mina, 'Rejected', 'Position closed');

	const after = await withTenant(ctx, (tx) => openingView(tx, id));
	expect(after.funnel.map((f) => [f.stageName, f.count])).toEqual([
		['Applied', 0],
		['Screening', 0],
		['Interview', 1],
		['Offer', 0],
		['Hired', 0],
		['Rejected', 1]
	]);
	const detail = await withTenant(ctx, (tx) => candidateView(tx, rafi));
	expect(detail.candidate).not.toHaveProperty('resumeKey');
	expect([detail.candidate.hasResume, detail.candidate.email, detail.opening.title]).toEqual([
		true,
		'rafi@example.com',
		'QA engineer'
	]);
	expect(detail.history.map((h) => [h.from, h.to, h.note])).toEqual([
		['Screening', 'Interview', ''],
		['Applied', 'Screening', 'Strong CV'],
		[null, 'Applied', '']
	]);

	const file = await openResume(ctx, rafi);
	expect([file.fileName, file.contentType, new TextDecoder().decode(file.body)]).toEqual([
		'cv.pdf',
		'application/pdf',
		'%PDF-1.7 resume'
	]);
	expect(await code(openResume(ctx, mina))).toBe('not_found');
	expect(await code(openResume(other, rafi))).toBe('not_found');
	const [row] = await withTenant(ctx, (tx) => tx.select().from(candidates).where(eq(candidates.id, rafi)));
	expect(new TextDecoder().decode(await getObject(row.resumeKey!))).toBe('%PDF-1.7 resume');
	expect(
		(await withTenant(ctx, (tx) => tx.select().from(auditLog).where(eq(auditLog.rowId, rafi)))).some(
			(a) => a.event === 'candidate.resume.download'
		)
	).toBe(true);

	const board = await withTenant(ctx, recruitmentBoard);
	expect(board.openings.find((o) => o.id === id)).toMatchObject({ status: 'closed', total: 2, active: 1 });
	expect(board.openings.at(-1)!.status).toBe('closed');
	expect(board.departments.map((d) => d.name)).toEqual(['Engineering']);
});
