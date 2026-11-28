import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MODULE_IDS, MODULES } from '../../src/lib/modules';
import { withTestNow } from '../../src/lib/server/clock';
import { closePools, ownerPool } from '../../src/lib/server/db';
import { memberships } from '../../src/lib/server/db/schema';
import {
	addCertification,
	addLesson,
	addQuestion,
	allowRetry,
	assignCourse,
	certificatePdf,
	certificationAttachments,
	completeLesson,
	coursePage,
	learningDay,
	learningPage,
	learningReport,
	lessonAttachments,
	removeAssignment,
	removeCertification,
	removeLesson,
	saveCourse,
	selfEnrol,
	setCourseStatus,
	submitQuiz,
	verifyCertificate
} from '../../src/lib/server/learning';
import { saveModules } from '../../src/lib/server/modules';
import { addMember, seedTenant } from '../../src/lib/server/platform/tenants';
import { loadAccess, userCtx, type requireMember } from '../../src/lib/server/rbac/access';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { createTenant, createUser, TEST_LOCALE } from './helpers';
import { expectScoped, leakWorld, type LeakWorld } from './leak';

type Member = ReturnType<typeof requireMember>;
type Tenant = { id: string; slug: string };
let tenant: Tenant;
let other: Tenant;
const who: Record<string, Member> = {};
const emp: Record<string, string> = {};
const sql = () => ownerPool().sql;
const NOW = '2026-11-26T06:00:00Z';
const at = <T>(iso: string, fn: () => Promise<T>) => withTestNow(iso, fn);
const code = (p: Promise<unknown>) =>
	p
		.then(() => 'ok')
		.catch((e: { code?: string; issues?: { message: string }[] }) =>
			e.issues ? `invalid: ${e.issues[0].message}` : (e.code ?? String(e))
		);
const on = (t: Tenant) => saveModules(systemCtx(t.id), [...MODULE_IDS.filter((id) => MODULES[id].on), 'learning']);
const off = (t: Tenant) =>
	saveModules(
		systemCtx(t.id),
		MODULE_IDS.filter((id) => MODULES[id].on)
	);
const view = (k: string, courseId: string) =>
	at(NOW, () => withTenant(userCtx(who[k]), (tx) => coursePage(tx, who[k].access, courseId)));
const home = (k: string) => at(NOW, () => withTenant(userCtx(who[k]), (tx) => learningPage(tx, who[k].access)));
const lessonsOf = async (courseId: string) =>
	(await view('hr', courseId)).lessons.map((l) => ({ id: l.id, kind: l.kind, questions: l.questions }));
const learningMail = (membershipId: string) =>
	sql()<
		{ title: string }[]
	>`select title from notifications where membership_id = ${membershipId} and category = 'learning' order by created_at`;

async function member(t: Tenant, key: string, roleKeys: string[], manager: string | null, department?: string) {
	const u = await createUser();
	const [e] = await sql()<{ id: string }[]>`
		insert into employees (tenant_id, code, full_name, work_email, employment_type, status, join_date, manager_id, department_id)
		values (${t.id}, ${key}, ${`${key} person`}, ${`${key}-${t.slug}@example.com`}, 'full_time', 'active',
			'2024-01-01', ${manager}, ${department ?? null}) returning id`;
	emp[key] = e.id;
	const m = await withTenant(systemCtx(t.id), async (tx) => {
		const id = await addMember(tx, t.id, u.id, roleKeys);
		await tx.update(memberships).set({ employeeId: e.id }).where(eq(memberships.id, id));
		return id;
	});
	who[key] = {
		user: { userId: u.id, email: u.email },
		tenant: { id: t.id, slug: t.slug, name: t.slug },
		access: await loadAccess(t.id, { id: m, status: 'active', employeeId: e.id })
	} as unknown as Member;
}

let ops: string;

async function quizCourse(title: string, extra: Record<string, string> = {}) {
	const id = await saveCourse(who.hr, { title, passMark: '60', maxAttempts: '2', ...extra });
	await addLesson(who.hr, { courseId: id, kind: 'text', title: 'Read me', body: 'Wear a **helmet**.' });
	await addLesson(who.hr, { courseId: id, kind: 'quiz', title: 'Check' });
	const quiz = (await lessonsOf(id)).find((l) => l.kind === 'quiz')!;
	await addQuestion(who.hr, { lessonId: quiz.id, prompt: 'Wear what?', options: '*Helmet\nCap\nNothing' });
	await addQuestion(who.hr, { lessonId: quiz.id, prompt: 'Which are safe?', options: '* Boots\n*Gloves\nSandals' });
	await setCourseStatus(who.hr, { courseId: id, status: 'published' });
	return id;
}

const answers = async (courseId: string, right: boolean) => {
	const [hrView] = [await view('hr', courseId)];
	const quiz = hrView.lessons.find((l) => l.kind === 'quiz')!;
	const picked = new Map<string, string[]>();
	for (const q of quiz.questions) {
		const lines = hrView.manage!.answers[q.id].split('\n');
		const ids = q.options.filter((_, i) => lines[i].startsWith('* ') === right).map((o) => o.id);
		picked.set(q.id, right ? ids : ids.slice(0, 1));
	}
	return { lessonId: quiz.id, picked };
};

beforeAll(async () => {
	tenant = await createTenant('lms');
	other = await createTenant('lmsb');
	await withTenant(systemCtx(tenant.id), (tx) => seedTenant(tx, tenant.id, TEST_LOCALE));
	await withTenant(systemCtx(other.id), (tx) => seedTenant(tx, other.id, TEST_LOCALE));
	[{ id: ops }] = await sql()<{ id: string }[]>`
		insert into departments (tenant_id, name) values (${tenant.id}, 'Ops') returning id`;
	await member(tenant, 'hr', ['hr_admin'], null);
	await member(tenant, 'mgr', ['line_manager'], null);
	await member(tenant, 'emp', [], emp.mgr, ops);
	await member(tenant, 'peer', [], null);
	await member(other, 'stranger', ['owner'], null);
	await on(tenant);
	await on(other);
});

afterAll(closePools);

describe('course building', () => {
	it('lets only course managers build and refuses to publish an incomplete course', async () => {
		expect(await code(saveCourse(who.emp, { title: 'Nope' }))).toBe('forbidden');
		expect(await code(saveCourse(who.hr, { title: '' }))).toBe('invalid: Name the course.');
		expect(await code(saveCourse(who.hr, { title: 'x', passMark: '0' }))).toBe(
			'invalid: The pass mark is 1 to 100 percent.'
		);
		const id = await saveCourse(who.hr, { title: 'Empty one' });
		expect(await code(setCourseStatus(who.hr, { courseId: id, status: 'published' }))).toBe('empty');
		await addLesson(who.hr, { courseId: id, kind: 'quiz', title: 'Quiz' });
		expect(await code(setCourseStatus(who.hr, { courseId: id, status: 'published' }))).toBe('empty_quiz');
		await addLesson(who.hr, { courseId: id, kind: 'file', title: 'Handbook' });
		const quiz = (await lessonsOf(id)).find((l) => l.kind === 'quiz')!;
		await addQuestion(who.hr, { lessonId: quiz.id, prompt: 'Q', options: '*a\nb' });
		expect(await code(setCourseStatus(who.hr, { courseId: id, status: 'published' }))).toBe('empty_file');
		expect(
			await code(addLesson(who.hr, { courseId: id, kind: 'link', title: 'Video', url: 'javascript:alert(1)' }))
		).toBe('invalid: Enter a link starting with http:// or https://.');
		await addLesson(who.hr, { courseId: id, kind: 'text', title: 'Note', url: 'https://ignored.example' });
		expect((await lessonsOf(id)).map((l) => l.kind)).toEqual(['quiz', 'file', 'text']);
	});

	it('refuses NUL bytes in links and dates Postgres cannot store', async () => {
		const id = await saveCourse(who.hr, { title: 'Inputs' });
		expect(
			await code(addLesson(who.hr, { courseId: id, kind: 'link', title: 'Video', url: 'http://example.com/a\u0000b' }))
		).toBe('invalid: Remove unsupported characters.');
		expect(await code(addCertification(who.emp, { name: 'Old', issuedOn: '0000-01-01' }))).toBe(
			'invalid: Enter the issue date.'
		);
		expect(
			await code(addCertification(who.emp, { name: 'Old', issuedOn: '2020-01-01', expiresOn: '9999-01-01' }))
		).toBe('invalid: Enter the expiry as a date.');
	});

	it('keeps a published course finishable while HR edits it', async () => {
		const id = await quizCourse('Live edits');
		expect(await code(addLesson(who.hr, { courseId: id, kind: 'quiz', title: 'More' }))).toBe('published');
		expect(await code(addLesson(who.hr, { courseId: id, kind: 'file', title: 'Doc' }))).toBe('published');
		await addLesson(who.hr, { courseId: id, kind: 'text', title: 'Extra' });
		await selfEnrol(who.peer, id);
		const right = await answers(id, true);
		const [read, , extra] = await lessonsOf(id);
		await at(NOW, () => submitQuiz(who.peer, { courseId: id, lessonId: right.lessonId }, right.picked));
		await at(NOW, () => completeLesson(who.peer, { courseId: id, lessonId: read.id }));
		expect((await view('peer', id)).enrolment?.status).toBe('assigned');
		await removeLesson(who.hr, extra.id);
		expect((await view('peer', id)).enrolment).toMatchObject({ status: 'passed', score: 100 });
	});

	it('marks people out of attempts when HR lowers the attempt limit', async () => {
		const id = await quizCourse('Fewer tries', { maxAttempts: '3' });
		await selfEnrol(who.peer, id);
		const wrong = await answers(id, false);
		await at(NOW, () => submitQuiz(who.peer, { courseId: id, lessonId: wrong.lessonId }, wrong.picked));
		await at(NOW, () => submitQuiz(who.peer, { courseId: id, lessonId: wrong.lessonId }, wrong.picked));
		await saveCourse(who.hr, { courseId: id, title: 'Fewer tries', passMark: '60', maxAttempts: '2' });
		expect((await view('peer', id)).enrolment?.status).toBe('failed');
		expect((await view('hr', id)).manage!.failed.map((f) => f.name)).toEqual(['peer person']);
	});

	it('parses option lines and needs at least one correct answer', async () => {
		const id = await saveCourse(who.hr, { title: 'Parsing' });
		await addLesson(who.hr, { courseId: id, kind: 'quiz', title: 'Quiz' });
		await addLesson(who.hr, { courseId: id, kind: 'text', title: 'Text' });
		const [quiz, text] = await lessonsOf(id);
		const bad = 'invalid: Write 2 to 8 options, one per line, and start each correct one with *.';
		expect(await code(addQuestion(who.hr, { lessonId: quiz.id, prompt: 'Q', options: 'a\nb' }))).toBe(bad);
		expect(await code(addQuestion(who.hr, { lessonId: quiz.id, prompt: 'Q', options: '*a' }))).toBe(bad);
		expect(
			await code(addQuestion(who.hr, { lessonId: quiz.id, prompt: 'Q', options: Array(9).fill('*a').join('\n') }))
		).toBe(bad);
		expect(await code(addQuestion(who.hr, { lessonId: text.id, prompt: 'Q', options: '*a\nb' }))).toBe('not_quiz');
		await addQuestion(who.hr, { lessonId: quiz.id, prompt: 'Q', options: '\n*  a \r\nb\n\n*c' });
		const v = await view('hr', id);
		const q = v.lessons[0].questions[0];
		expect(q.options.map((o) => o.text)).toEqual(['a', 'b', 'c']);
		expect(q.multiple).toBe(true);
		expect(v.manage!.answers[q.id]).toBe('* a\nb\n* c');
	});
});

describe('taking a course', () => {
	let courseId: string;
	beforeAll(async () => {
		courseId = await quizCourse('Site safety');
	});

	it('never sends quiz answers to a learner', async () => {
		await selfEnrol(who.emp, courseId);
		const learner = await view('emp', courseId);
		const json = JSON.stringify(learner);
		expect(learner.manage).toBeNull();
		expect(json).not.toMatch(/answerIds|answer_ids|answers|correct/);
		expect(JSON.stringify(await home('emp'))).not.toMatch(/answerIds|answer_ids/);
		expect(JSON.stringify(learner.lessons.flatMap((l) => l.questions))).not.toMatch(/"answer/);
	});

	it('grades on the server, caps attempts and lets HR allow a retry', async () => {
		const wrong = await answers(courseId, false);
		expect(await at(NOW, () => submitQuiz(who.emp, { courseId, lessonId: wrong.lessonId }, wrong.picked))).toEqual({
			score: 0,
			passed: false,
			attemptsLeft: 1,
			finished: false
		});
		const right = await answers(courseId, true);
		const half = new Map(right.picked);
		half.set([...half.keys()][1], right.picked.get([...half.keys()][1])!.slice(0, 1));
		expect(await at(NOW, () => submitQuiz(who.emp, { courseId, lessonId: right.lessonId }, half))).toMatchObject({
			score: 50,
			passed: false,
			attemptsLeft: 0
		});
		expect(await code(at(NOW, () => submitQuiz(who.emp, { courseId, lessonId: right.lessonId }, right.picked)))).toBe(
			'no_attempts'
		);
		expect((await view('emp', courseId)).enrolment?.status).toBe('failed');
		const failedId = (await view('hr', courseId)).manage!.failed[0].id;
		expect(await code(allowRetry(who.emp, failedId))).toBe('forbidden');
		await allowRetry(who.hr, failedId);
		expect(await code(allowRetry(who.hr, failedId))).toBe('not_failed');
		expect(await at(NOW, () => submitQuiz(who.emp, { courseId, lessonId: right.lessonId }, right.picked))).toEqual({
			score: 100,
			passed: true,
			attemptsLeft: 1,
			finished: false
		});
		expect(await code(at(NOW, () => submitQuiz(who.emp, { courseId, lessonId: right.lessonId }, right.picked)))).toBe(
			'done'
		);
	});

	it('finishes with a certificate only HR, the learner and their manager can open', async () => {
		const text = (await lessonsOf(courseId)).find((l) => l.kind === 'text')!;
		expect(await code(completeLesson(who.peer, { courseId, lessonId: text.id }))).toBe('not_enrolled');
		expect(await at(NOW, () => completeLesson(who.emp, { courseId, lessonId: text.id }))).toEqual({ finished: true });
		const mine = await view('emp', courseId);
		expect(mine.enrolment).toMatchObject({ status: 'passed', score: 100, expiresOn: null });
		const [{ certificate_code: cert, id: enrolmentId }] = await sql()<{ certificate_code: string; id: string }[]>`
			select id, certificate_code from course_enrolments where course_id = ${courseId} and employee_id = ${emp.emp}`;
		expect(cert).toMatch(/^[0-9A-F]{5}(-[0-9A-F]{5}){3}$/);
		const pdf = await certificatePdf(who.emp, enrolmentId);
		expect(Buffer.from(pdf.body.subarray(0, 5)).toString()).toBe('%PDF-');
		expect(pdf.fileName).toBe('certificate-Site-safety.pdf');
		expect(await code(certificatePdf(who.mgr, enrolmentId))).toBe('ok');
		expect(await code(certificatePdf(who.hr, enrolmentId))).toBe('ok');
		expect(await code(certificatePdf(who.peer, enrolmentId))).toBe('not_found');
		expect(await code(certificatePdf(who.stranger, enrolmentId))).toBe('not_found');
		const check = (k: string, c: string) =>
			withTenant(userCtx(who[k]), (tx) => verifyCertificate(tx, who[k].access, c));
		expect(await check('hr', cert.toLowerCase())).toMatchObject({
			valid: true,
			name: 'emp person',
			course: 'Site safety'
		});
		expect(await check('hr', 'AAAAA-AAAAA-AAAAA-AAAAA')).toEqual({ valid: false });
		await sql()`update course_enrolments set expires_on = '2026-01-01' where id = ${enrolmentId}`;
		expect(await at(NOW, () => check('hr', cert))).toMatchObject({
			valid: false,
			expired: true,
			expiresOn: '2026-01-01'
		});
		await sql()`update course_enrolments set expires_on = null where id = ${enrolmentId}`;
		expect(await check('stranger', cert)).toEqual({ valid: false });
		expect(await code(check('peer', cert))).toBe('forbidden');
		expect(await code(check('hr', 'nonsense'))).toMatch(/^invalid/);
		expect(await code(completeLesson(who.emp, { courseId, lessonId: text.id }))).toBe('done');
	});

	it('keeps drafts and other tenants out of reach', async () => {
		const draft = await saveCourse(who.hr, { title: 'Secret draft' });
		expect(await code(view('emp', draft))).toBe('not_found');
		expect(await code(selfEnrol(who.emp, draft))).toBe('not_found');
		expect(await code(view('stranger', courseId))).toBe('not_found');
		expect(await code(selfEnrol(who.stranger, courseId))).toBe('not_found');
		expect(await code(view('emp', 'not-a-uuid'))).toBe('not_found');
		expect((await home('emp')).catalogue.map((c) => c.title)).not.toContain('Secret draft');
		expect((await home('emp')).manage).toBeNull();
	});
});

describe('assignments, renewals and reminders', () => {
	it('enrols a department, notifies them, and enrols new joiners on the daily run', async () => {
		const courseId = await quizCourse('Fire drill');
		expect(await code(assignCourse(who.hr, { courseId, audience: 'department', dueInDays: '10' }))).toBe(
			'invalid: Choose the department.'
		);
		expect(
			await code(assignCourse(who.hr, { courseId, audience: 'employee', employeeId: emp.stranger, dueInDays: '10' }))
		).toBe('invalid_target');
		expect(
			await at(NOW, () =>
				assignCourse(who.hr, { courseId, audience: 'department', departmentId: ops, dueInDays: '10', mandatory: 'on' })
			)
		).toBe(1);
		expect((await home('emp')).mine.find((e) => e.courseId === courseId)).toMatchObject({
			dueOn: '2026-12-06',
			mandatory: true,
			status: 'assigned'
		});
		expect((await learningMail(who.emp.access.membershipId)).map((n) => n.title)).toContain(
			'New course for you: Fire drill'
		);
		expect((await home('peer')).mine.map((e) => e.courseId)).not.toContain(courseId);

		await member(tenant, 'late', [], null, ops);
		await at('2026-11-27T06:00:00Z', () => learningDay(tenant.id, tenant.slug));
		expect((await home('late')).mine.find((e) => e.courseId === courseId)?.dueOn).toBe('2026-12-07');
		expect(await at('2026-11-27T06:00:00Z', () => learningDay(tenant.id, tenant.slug))).toEqual([]);
	});

	it('reminds 7 and 1 days before due and before a certification expires', async () => {
		const courseId = await quizCourse('Reminders');
		await at('2026-11-28T06:00:00Z', () =>
			assignCourse(who.hr, { courseId, audience: 'employee', employeeId: emp.peer, dueInDays: '8' })
		);
		await addCertification(who.peer, { name: 'Forklift', issuedOn: '2024-01-01', expiresOn: '2026-12-06' });
		await at('2026-11-29T06:00:00Z', () => learningDay(tenant.id, tenant.slug));
		await at('2026-11-30T06:00:00Z', () => learningDay(tenant.id, tenant.slug));
		await at('2026-12-05T06:00:00Z', () => learningDay(tenant.id, tenant.slug));
		const titles = (await learningMail(who.peer.access.membershipId)).map((n) => n.title);
		expect(titles.filter((t) => t === 'Reminders is due on 2026-12-06')).toHaveLength(2);
		expect(titles.filter((t) => t === 'Your Forklift certification expires on 2026-12-06')).toHaveLength(2);
	});

	it('opens a new cycle before a passed course with renewal expires', async () => {
		const courseId = await quizCourse('Yearly refresh');
		const assign = (renewEveryMonths: string) =>
			at('2026-12-10T06:00:00Z', () =>
				assignCourse(who.hr, { courseId, audience: 'employee', employeeId: emp.mgr, dueInDays: '30', renewEveryMonths })
			);
		expect(await code(assign('1'))).toBe('invalid: Give fewer days to finish than the renewal period.');
		await assign('2');
		const right = await answers(courseId, true);
		await at('2026-12-10T06:00:00Z', () => submitQuiz(who.mgr, { courseId, lessonId: right.lessonId }, right.picked));
		const text = (await lessonsOf(courseId)).find((l) => l.kind === 'text')!;
		await at('2026-12-10T06:00:00Z', () => completeLesson(who.mgr, { courseId, lessonId: text.id }));
		expect((await view('mgr', courseId)).enrolment).toMatchObject({ status: 'passed', expiresOn: '2027-02-10' });
		const [{ id: first }] = await sql()<{ id: string }[]>`
			select id from course_enrolments where course_id = ${courseId} and employee_id = ${emp.mgr}`;
		await at('2027-01-10T06:00:00Z', () => learningDay(tenant.id, tenant.slug));
		expect(await sql()`select 1 from course_enrolments where course_id = ${courseId}`).toHaveLength(1);
		await at('2027-01-11T06:00:00Z', () => learningDay(tenant.id, tenant.slug));
		const cycles = await sql()<{ cycle: number; due_on: string | null; status: string }[]>`
			select cycle, due_on::text, status from course_enrolments where course_id = ${courseId} and employee_id = ${emp.mgr} order by cycle`;
		expect(cycles).toEqual([
			{ cycle: 1, due_on: '2027-01-09', status: 'passed' },
			{ cycle: 2, due_on: '2027-02-10', status: 'assigned' }
		]);
		const renewing = (await home('mgr')).mine.find((e) => e.courseId === courseId)!;
		expect(renewing).toMatchObject({ status: 'assigned', certificateId: first });
		expect((await view('mgr', courseId)).certificateId).toBe(first);
		expect(await code(certificatePdf(who.mgr, first))).toBe('ok');
		expect((await learningMail(who.mgr.access.membershipId)).map((n) => n.title)).toContain(
			'Time to renew: Yearly refresh'
		);
		await at('2027-01-12T06:00:00Z', () => learningDay(tenant.id, tenant.slug));
		expect((await sql()`select 1 from course_enrolments where course_id = ${courseId}`).length).toBe(2);
	});

	it('takes over a passed self-enrolment, sets its renewal and does not tell the learner again', async () => {
		const courseId = await quizCourse('Self first');
		await selfEnrol(who.peer, courseId);
		const right = await answers(courseId, true);
		const text = (await lessonsOf(courseId)).find((l) => l.kind === 'text')!;
		await at(NOW, () => submitQuiz(who.peer, { courseId, lessonId: right.lessonId }, right.picked));
		await at(NOW, () => completeLesson(who.peer, { courseId, lessonId: text.id }));
		expect(
			await at(NOW, () =>
				assignCourse(who.hr, {
					courseId,
					audience: 'employee',
					employeeId: emp.peer,
					dueInDays: '10',
					renewEveryMonths: '12'
				})
			)
		).toBe(0);
		const [row] = await sql()<{ status: string; expires_on: string; mandatory: boolean; assigned: boolean }[]>`
			select status, expires_on::text, mandatory, assignment_id is not null as assigned
			from course_enrolments where course_id = ${courseId} and employee_id = ${emp.peer}`;
		expect(row).toEqual({ status: 'passed', expires_on: '2027-11-26', mandatory: false, assigned: true });
		expect((await learningMail(who.peer.access.membershipId)).map((n) => n.title)).not.toContain(
			'New course for you: Self first'
		);
	});

	it('removing an assignment drops untouched enrolments and keeps started ones', async () => {
		const courseId = await quizCourse('Removable');
		await at(NOW, () => assignCourse(who.hr, { courseId, audience: 'all', dueInDays: '5' }));
		const text = (await lessonsOf(courseId)).find((l) => l.kind === 'text')!;
		await at(NOW, () => completeLesson(who.emp, { courseId, lessonId: text.id }));
		const [a] = (await view('hr', courseId)).manage!.assignments;
		expect(await code(removeAssignment(who.emp, a.id))).toBe('forbidden');
		await removeAssignment(who.hr, a.id);
		const rows = await sql()<{ employee_id: string; assignment_id: string | null; mandatory: boolean }[]>`
			select employee_id, assignment_id, mandatory from course_enrolments where course_id = ${courseId}`;
		expect(rows).toEqual([{ employee_id: emp.emp, assignment_id: null, mandatory: false }]);
	});
});

describe('certifications', () => {
	it('lets an employee keep their own certifications with files only they can edit', async () => {
		expect(
			await code(addCertification(who.emp, { name: 'CPR', issuedOn: '2026-05-01', expiresOn: '2026-04-01' }))
		).toBe('invalid: The expiry cannot be before the issue date.');
		expect(await code(addCertification(who.emp, { name: 'C\u0000PR', issuedOn: '2026-05-01' }))).toBe(
			'invalid: Remove unsupported characters.'
		);
		await addCertification(who.emp, { name: 'CPR', issuer: 'Red Crescent', issuedOn: '2026-05-01' });
		const [c] = (await home('emp')).certifications;
		expect(c).toMatchObject({ name: 'CPR', issuer: 'Red Crescent', expiresOn: null, files: [] });
		const rules = (k: string) =>
			withTenant(userCtx(who[k]), async (tx) => ({
				read: await certificationAttachments.canRead(tx, who[k].access, c.id),
				edit: await certificationAttachments.canEdit(tx, who[k].access, c.id, false)
			}));
		expect(await rules('emp')).toEqual({ read: true, edit: true });
		expect(await rules('mgr')).toEqual({ read: true, edit: false });
		expect(await rules('hr')).toEqual({ read: true, edit: false });
		expect(await rules('peer')).toEqual({ read: false, edit: false });
		expect(await rules('stranger')).toEqual({ read: false, edit: false });
		expect(await code(removeCertification(who.peer, c.id))).toBe('not_found');
		await removeCertification(who.emp, c.id);
		expect((await home('emp')).certifications).toEqual([]);
	});

	it('gates lesson files on the module, enrolment and course status', async () => {
		const id = await saveCourse(who.hr, { title: 'Files' });
		await addLesson(who.hr, { courseId: id, kind: 'file', title: 'Doc' });
		const [lesson] = await lessonsOf(id);
		const can = (k: string) =>
			withTenant(userCtx(who[k]), async (tx) => ({
				read: await lessonAttachments.canRead(tx, who[k].access, lesson.id),
				edit: await lessonAttachments.canEdit(tx, who[k].access, lesson.id, false)
			}));
		expect(await can('hr')).toEqual({ read: true, edit: true });
		expect(await can('emp')).toEqual({ read: false, edit: false });
		await sql()`update courses set status = 'published' where id = ${id}`;
		expect(await can('emp')).toEqual({ read: false, edit: false });
		await selfEnrol(who.emp, id);
		expect(await can('emp')).toEqual({ read: true, edit: false });
		expect(await can('stranger')).toEqual({ read: false, edit: false });
		await off(tenant);
		expect(await can('hr')).toEqual({ read: false, edit: false });
		await on(tenant);
	});

	it('does nothing on the daily run while the module is off', async () => {
		await off(other);
		expect(await at('2026-11-27T06:00:00Z', () => learningDay(other.id, other.slug))).toEqual([]);
		expect(await sql()`select 1 from counters where tenant_id = ${other.id} and name = 'learning_day'`).toHaveLength(0);
		await on(other);
	});
});

describe('training report scope', () => {
	let w: LeakWorld;
	beforeAll(async () => {
		w = await leakWorld(['course.report']);
		await on(w.a);
		const [c] = await sql()<{ id: string }[]>`
			insert into courses (tenant_id, title, status) values (${w.a.id}, 'Leak course', 'published') returning id`;
		const [x] = await sql()<{ id: string }[]>`
			insert into courses (tenant_id, title, status) values (${w.b.id}, 'Other course', 'published') returning id`;
		for (const id of [w.emp.boss, w.emp.ana, w.emp.dee, w.emp.bob])
			await sql()`insert into course_enrolments (tenant_id, course_id, employee_id, due_on)
				values (${w.a.id}, ${c.id}, ${id}, '2026-01-01')`;
		await sql()`insert into course_enrolments (tenant_id, course_id, employee_id, due_on)
			values (${w.b.id}, ${x.id}, ${w.emp.other}, '2026-01-01')`;
		await sql()`insert into certifications ${sql()(
			[w.emp.boss, w.emp.ana, w.emp.dee, w.emp.bob].map((e) => ({
				tenant_id: w.a.id,
				employee_id: e,
				name: 'Leak cert',
				issued_on: '2025-01-01',
				expires_on: '2026-12-01'
			}))
		)}`;
		await sql()`insert into certifications (tenant_id, employee_id, name, issued_on, expires_on)
			values (${w.b.id}, ${w.emp.other}, 'Leak cert', '2025-01-01', '2026-12-01')`;
		await on(w.b);
	});

	const report = (m: LeakWorld['viewers']['own']) =>
		withTestNow(w.now, () => withTenant(userCtx(m), (tx) => learningReport(tx, m.access)));

	it('lists overdue people only inside the report scope', () =>
		expectScoped(w, async (m) => (await report(m)).overdue.map((o) => w.byName[o.name])));

	it('lists expiring certifications only inside the report scope', () =>
		expectScoped(w, async (m) => (await report(m)).expiring.map((o) => w.byName[o.name])));

	it('counts only people inside the scope', async () => {
		expect((await report(w.viewers.team)).byCourse).toEqual([
			expect.objectContaining({ title: 'Leak course', enrolled: 2, passed: 0, overdue: 2, rate: 0 })
		]);
	});
});
