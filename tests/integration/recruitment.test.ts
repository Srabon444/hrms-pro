import { and, eq } from 'drizzle-orm';
import { addFiles, listFiles, openFile, removeFile } from '../../src/lib/server/attachments';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTestNow } from '../../src/lib/server/clock';
import { closePools } from '../../src/lib/server/db';
import { processors } from '../../src/lib/server/jobs';
import { closeQueues, startWorker } from '../../src/lib/server/queue';
import { closeRedis } from '../../src/lib/server/redis';
import {
	auditLog,
	candidates,
	departments,
	designations,
	employees,
	files,
	invitations,
	memberships,
	notifications,
	offers,
	tenantSettings
} from '../../src/lib/server/db/schema';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess, userCtx, type requireMember } from '../../src/lib/server/rbac/access';
import {
	addCandidate,
	cancelInterview,
	candidateView,
	decideOffer,
	hireCandidate,
	hiringFiles,
	interviewerChoices,
	makeOffer,
	moveCandidate,
	myInterviews,
	openingView,
	openResume,
	purgeTenantCandidates,
	recruitmentBoard,
	saveOpening,
	scheduleInterview,
	submitFeedback
} from '../../src/lib/server/recruitment';
import { getObject } from '../../src/lib/server/storage';
import { systemCtx, withTenant, type TenantCtx } from '../../src/lib/server/tenancy';
import { waitForMail } from '../mailpit';
import { createTenant, createUser, TEST_LOCALE } from './helpers';

type Member = ReturnType<typeof requireMember>;
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
async function reader(tenantId: string, grants: Record<string, string[]> = { 'recruitment.read': ['all'] }) {
	const u = await createUser();
	return {
		user: { userId: u.id },
		tenant: { id: tenantId, slug: 'x', name: 'x' },
		access: {
			membershipId: crypto.randomUUID(),
			employeeId: null,
			grants,
			roleKeys: [],
			isOwner: false
		}
	} as unknown as Member;
}
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
const mailer = startWorker('mail', processors.mail);
afterAll(async () => {
	await mailer.close();
	await Promise.all([closeQueues(), closePools(), closeRedis()]);
});

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
	const noor = await add({ fullName: 'Noor' });
	const noEmail = await withTenant(ctx, (tx) => tx.select().from(candidates).where(eq(candidates.id, noor)));
	expect([noEmail[0].email, noEmail[0].phone]).toEqual([null, null]);

	const view = await withTenant(ctx, (tx) => openingView(tx, id));
	const stage = Object.fromEntries(view.stages.map((s) => [s.name, s.id]));
	expect(view.candidates.find((c) => c.id === rafi)!.tags).toEqual(['go', 'sql']);
	expect(view.funnel.map((f) => f.count)).toEqual([3, 0, 0, 0, 0, 0]);

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
		['Applied', 1],
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

	const file = await openResume(await reader(ctx.tenantId), rafi);
	expect([file.fileName, file.contentType, new TextDecoder().decode(file.body)]).toEqual([
		'cv.pdf',
		'application/pdf',
		'%PDF-1.7 resume'
	]);
	expect(await code(openResume(await reader(ctx.tenantId), mina))).toBe('not_found');
	expect(await code(openResume(await reader(other.tenantId), rafi))).toBe('not_found');
	const [row] = await withTenant(ctx, (tx) => tx.select().from(candidates).where(eq(candidates.id, rafi)));
	expect(new TextDecoder().decode(await getObject(row.resumeKey!))).toBe('%PDF-1.7 resume');
	expect(
		(await withTenant(ctx, (tx) => tx.select().from(auditLog).where(eq(auditLog.rowId, rafi)))).some(
			(a) => a.event === 'candidate.resume.download'
		)
	).toBe(true);

	const board = await withTenant(ctx, recruitmentBoard);
	expect(board.openings.find((o) => o.id === id)).toMatchObject({ status: 'closed', total: 3, active: 2 });
	expect(board.openings.at(-1)!.status).toBe('closed');
	expect(board.departments.map((d) => d.name)).toEqual(['Engineering']);
});

describe('interviews, offers and hiring', () => {
	let tenant: { id: string; slug: string };
	const who: Record<string, Member> = {};
	const email: Record<string, string> = {};
	let openingId: string;
	let stages: Record<string, string>;
	const as = (k: string) => userCtx(who[k]);
	const view = (k: string, id: string) => withTenant(as(k), (tx) => candidateView(tx, id, who[k].access.membershipId));

	async function member(key: string, roleKeys: string[]) {
		const u = await createUser();
		email[key] = u.email;
		const id = await withTenant(systemCtx(tenant.id), (tx) => addMember(tx, tenant.id, u.id, roleKeys));
		const access = await loadAccess(tenant.id, { id, status: 'active', employeeId: null });
		who[key] = {
			user: { userId: u.id },
			tenant: { id: tenant.id, slug: tenant.slug, name: tenant.slug },
			access
		} as unknown as Member;
	}

	beforeAll(async () => {
		tenant = await createTenant('ats-hire');
		await withTenant(systemCtx(tenant.id), (tx) => seedTenant(tx, tenant.id, TEST_LOCALE));
		await member('rec', ['recruiter']);
		await member('ivA', ['hr_officer']);
		await member('ivB', ['hr_officer']);
		await member('emp', []);
		await member('adm', ['hr_admin']);
		const dept = await withTenant(
			as('adm'),
			async (tx) => (await tx.insert(departments).values({ tenantId: tenant.id, name: 'Platform' }).returning())[0].id
		);
		openingId = await saveOpening(as('rec'), {
			title: 'Site reliability engineer',
			departmentId: dept,
			designationId: '',
			headcount: '1',
			description: ''
		});
		stages = Object.fromEntries(
			(await withTenant(as('rec'), (tx) => openingView(tx, openingId))).stages.map((s) => [s.name, s.id])
		);
	});

	it('keeps interview feedback blind until every interviewer has sent theirs', async () => {
		const sara = await addCandidate(as('rec'), { openingId, fullName: 'Sara' }, null);
		const slot = { candidateId: sara, title: 'Technical', scheduledAt: '2030-01-10T10:00', durationMinutes: '60' };
		const [a, b, e] = [who.ivA, who.ivB, who.emp].map((m) => m.access.membershipId);
		const schedule = (raw: Record<string, string>, panel = [a, b]) =>
			scheduleInterview(as('rec'), tenant.slug, { ...slot, ...raw }, panel);

		expect(await code(schedule({ scheduledAt: '2020-01-10T10:00' }))).toBe('past');
		expect(await code(schedule({ scheduledAt: '2030-02-30T10:00' }))).toBe(
			'invalid: Pick the interview date and time.'
		);
		expect(await code(schedule({ durationMinutes: '10' }))).toBe('invalid: Interviews last 15 to 480 minutes.');
		expect(await code(schedule({}, []))).toBe('invalid: Choose at least one interviewer.');
		expect(await code(schedule({}, [a, e]))).toBe('invalid_interviewer');
		expect((await withTenant(as('rec'), interviewerChoices)).map((c) => c.id)).not.toContain(e);

		await schedule({}, [a, b, a]);
		const notes = await withTenant(as('rec'), (tx) =>
			tx.select().from(notifications).where(eq(notifications.category, 'recruitment'))
		);
		expect(notes.map((n) => n.membershipId).sort()).toEqual([a, b].sort());
		expect((await waitForMail(email.ivA)).subject).toBe('Interview: Sara · Technical');

		const [interview] = (await view('rec', sara)).interviews;
		const id = interview.id;
		const feedback = { interviewId: id, rating: '4', recommendation: 'yes', comments: 'Solid on Linux' };
		expect(await code(submitFeedback(as('emp'), e, feedback))).toBe('not_found');
		expect(await code(submitFeedback(as('ivA'), a, { ...feedback, rating: '6' }))).toBe(
			'invalid: Rate the candidate from 1 to 5.'
		);
		await submitFeedback(as('ivA'), a, feedback);
		expect(await code(submitFeedback(as('ivA'), a, feedback))).toBe('already_submitted');

		const seen = async (k: string) =>
			Object.fromEntries(
				(await view(k, sara)).interviews[0].panel.map((p) => [p.membershipId, [p.submitted, p.rating, p.comments]])
			);
		expect(await seen('rec')).toEqual({ [a]: [true, null, null], [b]: [false, null, null] });
		expect(await seen('ivA')).toEqual({ [a]: [true, 4, 'Solid on Linux'], [b]: [false, null, null] });
		expect((await withTenant(as('ivB'), (tx) => myInterviews(tx, b))).map((i) => [i.candidateName, i.rating])).toEqual([
			['Sara', null]
		]);
		expect(await code(cancelInterview(as('rec'), id))).toBe('has_feedback');

		await submitFeedback(as('ivB'), b, { ...feedback, rating: '2', recommendation: 'no', comments: '' });
		const after = (await view('rec', sara)).interviews[0];
		expect(after.allIn).toBe(true);
		expect(Object.fromEntries(after.panel.map((p) => [p.membershipId, [p.rating, p.recommendation]]))).toEqual({
			[a]: [4, 'yes'],
			[b]: [2, 'no']
		});

		await schedule({ title: 'Culture' }, [b]);
		const culture = (await view('rec', sara)).interviews.find((i) => i.title === 'Culture')!;
		await cancelInterview(as('rec'), culture.id);
		expect(await code(cancelInterview(as('rec'), culture.id))).toBe('cancelled');
		expect(await code(submitFeedback(as('ivB'), b, { ...feedback, interviewId: culture.id }))).toBe('cancelled');
		expect((await withTenant(as('ivB'), (tx) => myInterviews(tx, b))).map((i) => i.title)).toEqual(['Technical']);

		await moveCandidate(as('rec'), { candidateId: sara, stageId: stages.Rejected });
		expect(await code(schedule({ title: 'Again' }))).toBe('not_active');
	});

	it('hires a candidate with an accepted offer into an onboarding employee and invites them', async () => {
		const add = (fullName: string, mail: string) =>
			addCandidate(as('rec'), { openingId, fullName, email: mail, phone: '+8801700000000' }, null);
		const nadia = await add('Nadia', `nadia-${tenant.slug}@example.com`);
		const omar = await add('Omar', '');
		const offer = { candidateId: nadia, monthlyGross: '85000.50', joinDate: '2030-03-01', expiresOn: '2030-02-01' };

		expect(await code(makeOffer(as('rec'), { ...offer, monthlyGross: '0' }))).toBe(
			'invalid: Enter the monthly gross, up to 2 decimals.'
		);
		expect(await code(makeOffer(as('rec'), { ...offer, joinDate: '2020-03-01', expiresOn: '' }))).toBe('past_join');
		expect(await code(makeOffer(as('rec'), { ...offer, expiresOn: '2020-02-01' }))).toBe('past_expiry');
		expect(await code(makeOffer(as('rec'), { ...offer, expiresOn: '2030-03-02' }))).toBe('expiry_after_join');
		await makeOffer(as('rec'), offer);
		expect(await code(makeOffer(as('rec'), offer))).toBe('offer_exists');
		expect(await code(hireCandidate(who.adm, { candidateId: nadia }))).toBe('no_offer');

		const [o] = (await view('rec', nadia)).offers;
		expect([o.monthlyGross, o.status]).toEqual([8_500_050, 'pending']);
		await withTenant(as('rec'), (tx) => tx.update(offers).set({ expiresOn: '2020-01-01' }).where(eq(offers.id, o.id)));
		expect(await code(decideOffer(as('rec'), { offerId: o.id, decision: 'accepted' }))).toBe('expired');
		await withTenant(as('rec'), (tx) => tx.update(offers).set({ expiresOn: null }).where(eq(offers.id, o.id)));
		await decideOffer(as('rec'), { offerId: o.id, decision: 'accepted' });
		expect(await code(decideOffer(as('rec'), { offerId: o.id, decision: 'withdrawn' }))).toBe('decided');

		expect(await code(hireCandidate(who.rec, { candidateId: nadia }))).toBe('forbidden');
		const hired = await hireCandidate(who.adm, { candidateId: nadia, invite: 'on' });
		expect(hired.invite).toBeNull();
		const [e] = await withTenant(as('adm'), (tx) =>
			tx.select().from(employees).where(eq(employees.id, hired.employeeId))
		);
		const opening = (await withTenant(as('rec'), (tx) => openingView(tx, openingId))).opening;
		expect([e.fullName, e.status, e.joinDate, e.personalEmail, e.departmentId, e.employmentType]).toEqual([
			'Nadia',
			'onboarding',
			'2030-03-01',
			`nadia-${tenant.slug}@example.com`,
			opening.departmentId,
			'full_time'
		]);
		const detail = await view('rec', nadia);
		expect([detail.candidate.employeeId, detail.candidate.stageId, detail.history[0].note]).toEqual([
			hired.employeeId,
			stages.Hired,
			'Hired'
		]);
		const [inv] = await withTenant(as('adm'), (tx) =>
			tx.select().from(invitations).where(eq(invitations.employeeId, hired.employeeId))
		);
		expect(inv.email).toBe(`nadia-${tenant.slug}@example.com`);
		expect(await code(hireCandidate(who.adm, { candidateId: nadia }))).toBe('hired');
		expect(await code(moveCandidate(as('rec'), { candidateId: nadia, stageId: stages.Offer }))).toBe('hired');

		await makeOffer(as('rec'), { candidateId: omar, monthlyGross: '50000', joinDate: '2030-03-01' });
		const [o2] = (await view('rec', omar)).offers;
		await decideOffer(as('rec'), { offerId: o2.id, decision: 'accepted' });
		expect(await code(hireCandidate(who.adm, { candidateId: omar }))).toBe('headcount_full');
		await saveOpening(as('rec'), {
			openingId,
			title: opening.title,
			description: '',
			headcount: '2',
			departmentId: opening.departmentId ?? '',
			designationId: '',
			status: 'open'
		});
		const second = await hireCandidate(who.adm, { candidateId: omar, invite: 'on' });
		expect(second.invite).toBe('Hired. Add their email, then invite them from Users.');
		expect(
			await withTenant(as('adm'), (tx) =>
				tx
					.select()
					.from(memberships)
					.where(and(eq(memberships.employeeId, second.employeeId)))
			)
		).toEqual([]);

		const lina = await add('Lina', `lina-${tenant.slug}@example.com`);
		await makeOffer(as('rec'), { candidateId: lina, monthlyGross: '60000', joinDate: '2030-04-01' });
		const [o3] = (await view('rec', lina)).offers;
		await moveCandidate(as('rec'), { candidateId: lina, stageId: stages.Rejected });
		expect(await code(decideOffer(as('rec'), { offerId: o3.id, decision: 'accepted' }))).toBe('not_active');
		await moveCandidate(as('rec'), { candidateId: lina, stageId: stages.Screening });
		await decideOffer(as('rec'), { offerId: o3.id, decision: 'accepted' });
		await saveOpening(as('rec'), {
			openingId,
			title: opening.title,
			description: '',
			headcount: '3',
			departmentId: opening.departmentId ?? '',
			designationId: '',
			status: 'open'
		});
		expect((await hireCandidate(who.adm, { candidateId: lina })).invite).toBeNull();
		expect(
			await withTenant(as('adm'), (tx) =>
				tx
					.select()
					.from(invitations)
					.where(eq(invitations.email, `lina-${tenant.slug}@example.com`))
			)
		).toEqual([]);
	});
	it('keeps candidate and offer files with the candidate and shows them on the hired employee', async () => {
		const zara = await addCandidate(as('rec'), { openingId, fullName: 'Zara' }, pdf('zara-cv.pdf'));
		const [nid] = await addFiles(who.rec, 'candidate', zara, [pdf('nid.pdf')]);
		expect(await code(addFiles(who.ivA, 'candidate', zara, [pdf()]))).toBe('forbidden');
		expect(await code(addFiles(who.emp, 'candidate', zara, [pdf()]))).toBe('not_found');
		expect(await code(openFile(who.emp, nid))).toBe('not_found');
		expect((await openFile(who.ivA, nid)).fileName).toBe('nid.pdf');

		await makeOffer(as('rec'), { candidateId: zara, monthlyGross: '70000', joinDate: '2030-05-01' });
		const [o] = (await view('rec', zara)).offers;
		const [signed] = await addFiles(who.rec, 'offer', o.id, [pdf('signed.pdf')]);
		expect(await code(addFiles(who.ivA, 'offer', o.id, [pdf()]))).toBe('forbidden');
		expect(await code(openFile(who.emp, signed))).toBe('not_found');
		await decideOffer(as('rec'), { offerId: o.id, decision: 'accepted' });
		const current = (await withTenant(as('rec'), (tx) => openingView(tx, openingId))).opening;
		await saveOpening(as('rec'), {
			openingId,
			title: current.title,
			description: '',
			headcount: '10',
			departmentId: current.departmentId ?? '',
			designationId: '',
			status: 'open'
		});
		const { employeeId } = await hireCandidate(who.adm, { candidateId: zara });

		const docs = await reader(tenant.id, { 'document.read': ['all'] });
		const seen = await withTenant(userCtx(docs), (tx) => hiringFiles(tx, docs.access, employeeId));
		expect([seen?.hasResume, seen?.files.map((f) => f.filename)]).toEqual([true, ['nid.pdf']]);
		expect((await openFile(docs, nid)).fileName).toBe('nid.pdf');
		expect((await openResume(docs, zara)).fileName).toBe('zara-cv.pdf');
		expect(await code(openFile(docs, signed))).toBe('not_found');
		expect(await code(addFiles(docs, 'candidate', zara, [pdf()]))).toBe('forbidden');
		expect(await withTenant(as('emp'), (tx) => hiringFiles(tx, who.emp.access, employeeId))).toBeNull();
		expect(await code(openResume(who.emp, zara))).toBe('not_found');
	});

	it('lets each interviewer attach files to their own feedback until they send it', async () => {
		const kai = await addCandidate(as('rec'), { openingId, fullName: 'Kai' }, null);
		const [a, b] = [who.ivA, who.ivB].map((m) => m.access.membershipId);
		await scheduleInterview(
			as('rec'),
			tenant.slug,
			{ candidateId: kai, title: 'Design', scheduledAt: '2030-01-11T10:00', durationMinutes: '60' },
			[a, b]
		);
		const slot = async (k: string, ms: string) =>
			(await withTenant(as(k), (tx) => myInterviews(tx, ms))).find((i) => i.candidateName === 'Kai')!;
		const fa = (await slot('ivA', a)).feedbackId;
		const [notes] = await addFiles(who.ivA, 'interview_feedback', fa, [pdf('notes.pdf')]);
		expect(await code(addFiles(who.ivB, 'interview_feedback', fa, [pdf()]))).toBe('not_found');
		expect(await code(openFile(who.rec, notes))).toBe('not_found');
		expect(await code(openFile(who.ivB, notes))).toBe('not_found');

		const feedback = { interviewId: (await slot('ivA', a)).interviewId, rating: '5', recommendation: 'yes' };
		await submitFeedback(as('ivA'), a, feedback);
		expect(await code(addFiles(who.ivA, 'interview_feedback', fa, [pdf()]))).toBe('forbidden');
		expect(await code(removeFile(who.ivA, { type: 'interview_feedback', id: fa }, notes))).toBe('forbidden');
		expect((await openFile(who.ivA, notes)).fileName).toBe('notes.pdf');

		await submitFeedback(as('ivB'), b, feedback);
		expect((await openFile(who.rec, notes)).fileName).toBe('notes.pdf');
		const listed = await withTenant(as('rec'), (tx) => listFiles(tx, who.rec.access, 'interview_feedback', fa));
		expect([listed?.files.map((f) => f.filename), listed?.canEdit]).toEqual([['notes.pdf'], false]);
	});
});

it('purges rejected candidates and those of long-closed openings after the retention period', async () => {
	const t = await createTenant('ats-purge');
	const sys = systemCtx(t.id);
	const pause = () => new Promise((r) => setTimeout(r, 20));
	await withTenant(sys, (tx) => tx.update(tenantSettings).set({ retentionCandidatesDays: 30 }));
	const live = await saveOpening(sys, { ...opening, title: 'Live' });
	const ended = await saveOpening(sys, { ...opening, title: 'Ended' });
	const stageOf = async (id: string, name: string) =>
		(await withTenant(sys, (tx) => openingView(tx, id))).stages.find((s) => s.name === name)!.id;
	const add = (openingId: string, fullName: string, file: File | null = null) =>
		addCandidate(sys, { openingId, fullName }, file);
	const reject = async (openingId: string, candidateId: string) =>
		moveCandidate(sys, { candidateId, stageId: await stageOf(openingId, 'Rejected') });

	const oldReject = await add(live, 'Old reject', pdf());
	const recruiter = await reader(t.id, { 'recruitment.read': ['all'], 'recruitment.manage': ['all'] });
	await addFiles(recruiter, 'candidate', oldReject, [pdf('nid.pdf')]);
	await makeOffer(sys, { candidateId: oldReject, monthlyGross: '50000', joinDate: '2030-01-01' });
	const [offer] = await withTenant(sys, (tx) => tx.select().from(offers).where(eq(offers.candidateId, oldReject)));
	await addFiles(recruiter, 'offer', offer.id, [pdf('offer.pdf')]);
	const attached = await withTenant(sys, (tx) => tx.select({ key: files.key }).from(files));
	await reject(live, oldReject);
	await add(live, 'Still waiting');
	await add(ended, 'Leftover');
	const hiredOne = await add(ended, 'Hired one');
	await withTenant(sys, async (tx) => {
		const [e] = await tx
			.insert(employees)
			.values({ tenantId: t.id, code: 'P-1', fullName: 'Hired one', joinDate: '2026-01-01' })
			.returning();
		await tx.update(candidates).set({ employeeId: e.id }).where(eq(candidates.id, hiredOne));
	});
	await pause();
	await saveOpening(sys, { ...opening, openingId: ended, title: 'Ended', status: 'closed' });
	await pause();
	const newReject = await add(live, 'New reject');
	await reject(live, newReject);

	const [{ resumeKey }] = await withTenant(sys, (tx) =>
		tx.select().from(candidates).where(eq(candidates.id, oldReject))
	);
	const [last] = await withTenant(sys, (tx) => tx.select().from(candidates).where(eq(candidates.id, hiredOne)));
	const closedAt = (await withTenant(sys, (tx) => openingView(tx, ended))).opening.updatedAt;
	const between = (last.updatedAt.getTime() + closedAt.getTime()) / 2 + 30 * 86_400_000;
	const left = async () =>
		(await withTenant(sys, (tx) => tx.select({ name: candidates.fullName }).from(candidates)))
			.map((c) => c.name)
			.sort();

	expect(await withTestNow(new Date(between).toISOString(), () => purgeTenantCandidates(t.id))).toBe(1);
	expect(await left()).toEqual(['Hired one', 'Leftover', 'New reject', 'Still waiting']);
	expect(await code(getObject(resumeKey!))).not.toBe('ok');
	expect(attached).toHaveLength(2);
	for (const { key } of attached) expect(await code(getObject(key))).not.toBe('ok');
	expect(await withTenant(sys, (tx) => tx.select().from(files))).toEqual([]);

	expect(
		await withTestNow(new Date(Date.now() + 31 * 86_400_000).toISOString(), () => purgeTenantCandidates(t.id))
	).toBe(2);
	expect(await left()).toEqual(['Hired one', 'Still waiting']);
});
