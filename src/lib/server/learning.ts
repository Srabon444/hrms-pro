import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AttachmentRules } from './attachments';
import { activeMembershipsOf } from './approval-chain';
import { requireActiveMember } from './audience';
import { keyedMac } from './auth/crypto';
import { now } from './clock';
import { addDays } from './dates';
import { authPool } from './db';
import {
	branches,
	certifications,
	COURSE_AUDIENCES,
	COURSE_STATUSES,
	courseAssignments,
	courseEnrolments,
	courseLessons,
	courses,
	departments,
	employees,
	files,
	LESSON_KINDS,
	lessonProgress,
	quizQuestions,
	tenants,
	tenantSettings,
	type QuizOption
} from './db/schema';
import { AppError } from './errors';
import { dropFiles, discardFiles, filesFor } from './file-store';
import { claimDay, tenantToday } from './lifecycle';
import { log } from './log';
import type { Mail } from './mail';
import { moduleOverrides } from './modules';
import { moduleOn } from '../modules';
import { notify, sendAll } from './notifications';
import { centred, pdfDoc } from './pdf';
import { can, userCtx, type Access, type requireMember } from './rbac/access';
import { inScope, resolveScope, scopeWhere } from './rbac/scope';
import { systemCtx, withTenant, type Tx } from './tenancy';

type Member = ReturnType<typeof requireMember>;

export const LEARNING_LIMITS = {
	courses: 500,
	lessons: 50,
	questions: 50,
	assignments: 50,
	certifications: 50,
	list: 500
} as const;
const REMIND_DAYS = [7, 1];
const NUL = 'Remove unsupported characters.';
const noNul = (s: z.ZodString) => s.refine((v) => !v.includes('\0'), NUL);
const checkbox = z.preprocess((v) => v === 'on' || v === true, z.boolean());
const isoDate = (message: string) => z.iso.date(message).refine((v) => v >= '1900-01-01' && v <= '2999-12-31', message);
const optionalDate = (message: string) =>
	z
		.union([z.literal(''), isoDate(message)])
		.transform((v) => v || null)
		.prefault('');
const id = (message: string) => z.uuid({ error: message });
const optionalId = (message: string) =>
	z
		.union([z.literal(''), z.uuid({ error: message })])
		.transform((v) => v || null)
		.prefault('');
const int = (min: number, max: number, message: string) =>
	z.coerce.number(message).int(message).min(min, message).max(max, message);

const forbidden = () => new AppError('forbidden', 'You do not have permission to do that.', 403);
const courseMissing = () => new AppError('not_found', 'That course does not exist.', 404);

const requireManage = (m: Member) => {
	if (!can(m.access, 'course.manage')) throw forbidden();
};

const courseSchema = z.object({
	courseId: optionalId('Choose a course.'),
	title: noNul(z.string().trim().min(1, 'Name the course.').max(160, 'Keep the title under 160 characters.')),
	description: noNul(z.string().max(5000, 'Keep the description under 5000 characters.')).prefault(''),
	passMark: int(1, 100, 'The pass mark is 1 to 100 percent.').prefault('70'),
	maxAttempts: int(1, 10, 'Allow 1 to 10 attempts.').prefault('3')
});

const lessonSchema = z
	.object({
		courseId: id('Choose a course.'),
		kind: z.enum(LESSON_KINDS, 'Choose a lesson type.'),
		title: noNul(z.string().trim().min(1, 'Name the lesson.').max(160, 'Keep the lesson title under 160 characters.')),
		body: noNul(z.string().max(20000, 'Keep the lesson text under 20000 characters.')).prefault(''),
		url: noNul(z.string().trim()).prefault('')
	})
	.transform((v, ctx) => {
		if (v.kind !== 'link') return { ...v, url: null };
		if (!/^https?:\/\/\S{1,1990}$/i.test(v.url) || !URL.canParse(v.url)) {
			ctx.addIssue({ code: 'custom', message: 'Enter a link starting with http:// or https://.' });
			return z.NEVER;
		}
		return v;
	});

const OPTION_ERROR = 'Write 2 to 8 options, one per line, and start each correct one with *.';
const questionSchema = z.object({
	lessonId: id('Choose a quiz.'),
	prompt: noNul(z.string().trim().min(1, 'Write the question.').max(500, 'Keep the question under 500 characters.')),
	options: noNul(z.string())
		.transform((v) =>
			v
				.split(/\r?\n/)
				.map((l) => l.trim())
				.filter(Boolean)
				.map((l) => ({ correct: l.startsWith('*'), text: l.replace(/^\*\s*/, '') }))
		)
		.pipe(
			z
				.array(z.object({ correct: z.boolean(), text: z.string().min(1, OPTION_ERROR).max(200, OPTION_ERROR) }))
				.min(2, OPTION_ERROR)
				.max(8, OPTION_ERROR)
				.refine((list) => list.some((o) => o.correct), OPTION_ERROR)
		)
});

const assignSchema = z
	.object({
		courseId: id('Choose a course.'),
		audience: z.enum(COURSE_AUDIENCES, 'Choose who takes the course.'),
		departmentId: optionalId('Choose a department.'),
		branchId: optionalId('Choose a branch.'),
		employeeId: optionalId('Choose an employee.'),
		dueInDays: int(1, 365, 'Give 1 to 365 days to finish.'),
		mandatory: checkbox,
		renewEveryMonths: z
			.union([z.literal(''), int(1, 120, 'Renew every 1 to 120 months, or leave it blank.')])
			.transform((v) => (v === '' ? null : v))
			.prefault('')
	})
	.transform((v, ctx) => {
		const target = { department: v.departmentId, branch: v.branchId, employee: v.employeeId } as const;
		if (v.audience !== 'all' && !target[v.audience]) {
			ctx.addIssue({ code: 'custom', message: `Choose the ${v.audience}.` });
			return z.NEVER;
		}
		if (v.renewEveryMonths && v.dueInDays >= v.renewEveryMonths * 28) {
			ctx.addIssue({ code: 'custom', message: 'Give fewer days to finish than the renewal period.' });
			return z.NEVER;
		}
		return {
			...v,
			departmentId: v.audience === 'department' ? v.departmentId : null,
			branchId: v.audience === 'branch' ? v.branchId : null,
			employeeId: v.audience === 'employee' ? v.employeeId : null
		};
	});

const certificationSchema = z
	.object({
		name: noNul(z.string().trim().min(1, 'Name the certification.').max(160, 'Keep the name under 160 characters.')),
		issuer: noNul(z.string().trim().max(160, 'Keep the issuer under 160 characters.')).prefault(''),
		issuedOn: isoDate('Enter the issue date.'),
		expiresOn: optionalDate('Enter the expiry as a date.')
	})
	.refine((v) => !v.expiresOn || v.expiresOn >= v.issuedOn, 'The expiry cannot be before the issue date.');

const addMonthsTo = (iso: string, months: number) => {
	const [y, m, d] = iso.split('-').map(Number);
	const last = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
	return new Date(Date.UTC(y, m - 1 + months, Math.min(d, last))).toISOString().slice(0, 10);
};

async function lockedCourse(tx: Tx, courseId: string) {
	const [c] = await tx.select().from(courses).where(eq(courses.id, courseId)).for('update');
	if (!c) throw courseMissing();
	return c;
}

export async function saveCourse(m: Member, raw: Record<string, string>): Promise<string> {
	requireManage(m);
	const { courseId, ...input } = courseSchema.parse(raw);
	return withTenant(userCtx(m), async (tx) => {
		if (courseId) {
			const [row] = await tx.update(courses).set(input).where(eq(courses.id, courseId)).returning({ id: courses.id });
			if (!row) throw courseMissing();
			await tx.execute(sql`
				update course_enrolments ce set status = 'failed'
				where ce.course_id = ${row.id} and ce.status = 'assigned' and exists (select 1 from lesson_progress p
					where p.enrolment_id = ce.id and p.completed_at is null and p.attempts >= ${input.maxAttempts})`);
			return row.id;
		}
		const [{ n }] = await tx.select({ n: count() }).from(courses);
		if (n >= LEARNING_LIMITS.courses)
			throw new AppError('too_many', `You can keep up to ${LEARNING_LIMITS.courses} courses.`, 409);
		const [row] = await tx
			.insert(courses)
			.values({ tenantId: m.tenant.id, ...input, createdByUserId: m.user.userId })
			.returning({ id: courses.id });
		return row.id;
	});
}

const statusSchema = z.object({
	courseId: id('Choose a course.'),
	status: z.enum(COURSE_STATUSES, 'Choose a status.')
});

export async function setCourseStatus(m: Member, raw: Record<string, string>) {
	requireManage(m);
	const input = statusSchema.parse(raw);
	await withTenant(userCtx(m), async (tx) => {
		await lockedCourse(tx, input.courseId);
		if (input.status === 'published') await assertPublishable(tx, input.courseId);
		await tx.update(courses).set({ status: input.status }).where(eq(courses.id, input.courseId));
	});
}

async function assertPublishable(tx: Tx, courseId: string) {
	const lessons = await tx
		.select({
			kind: courseLessons.kind,
			title: courseLessons.title,
			questions: sql<number>`(select count(*)::int from ${quizQuestions} q where q.lesson_id = course_lessons.id)`,
			files: sql<number>`(select count(*)::int from ${files} f where f.owner_type = 'course_lesson' and f.owner_id = course_lessons.id)`
		})
		.from(courseLessons)
		.where(eq(courseLessons.courseId, courseId));
	if (!lessons.length) throw new AppError('empty', 'Add at least one lesson before publishing.', 409);
	const quiz = lessons.find((l) => l.kind === 'quiz' && !l.questions);
	if (quiz) throw new AppError('empty_quiz', `Add questions to "${quiz.title}" before publishing.`, 409);
	const file = lessons.find((l) => l.kind === 'file' && !l.files);
	if (file) throw new AppError('empty_file', `Attach a file to "${file.title}" before publishing.`, 409);
}

export async function addLesson(m: Member, raw: Record<string, string>) {
	requireManage(m);
	const input = lessonSchema.parse(raw);
	await withTenant(userCtx(m), async (tx) => {
		const c = await lockedCourse(tx, input.courseId);
		if (c.status === 'published' && (input.kind === 'quiz' || input.kind === 'file'))
			throw new AppError('published', 'Move the course back to draft to add a quiz or file lesson.', 409);
		const [{ n, last }] = await tx
			.select({ n: count(), last: sql<number>`coalesce(max(${courseLessons.sortOrder}), 0)::int` })
			.from(courseLessons)
			.where(eq(courseLessons.courseId, input.courseId));
		if (n >= LEARNING_LIMITS.lessons)
			throw new AppError('too_many', `A course holds up to ${LEARNING_LIMITS.lessons} lessons.`, 409);
		await tx.insert(courseLessons).values({ tenantId: m.tenant.id, ...input, sortOrder: last + 1 });
	});
}

export async function removeLesson(m: Member, rawId: string) {
	requireManage(m);
	const lessonId = id('Choose a lesson.').parse(rawId);
	const keys = await withTenant(userCtx(m), async (tx) => {
		const [l] = await tx
			.select({ courseId: courseLessons.courseId })
			.from(courseLessons)
			.where(eq(courseLessons.id, lessonId));
		if (!l) throw new AppError('not_found', 'That lesson does not exist.', 404);
		const [c] = await tx
			.select({ status: courses.status })
			.from(courses)
			.where(eq(courses.id, l.courseId))
			.for('update');
		const stored = await dropFiles(tx, 'course_lesson', [lessonId]);
		await tx.delete(courseLessons).where(eq(courseLessons.id, lessonId));
		if (c?.status === 'published') {
			await assertPublishable(tx, l.courseId);
			await finishCompleted(tx, l.courseId);
		}
		return stored;
	});
	await discardFiles(keys);
}

async function finishCompleted(tx: Tx, courseId: string) {
	const ready = await tx
		.select()
		.from(courseEnrolments)
		.where(
			and(
				eq(courseEnrolments.courseId, courseId),
				eq(courseEnrolments.status, 'assigned'),
				sql`not exists (select 1 from course_lessons l where l.course_id = course_enrolments.course_id and not exists (
					select 1 from lesson_progress p where p.enrolment_id = course_enrolments.id and p.lesson_id = l.id and p.completed_at is not null))`
			)
		);
	await ready.reduce<Promise<unknown>>((prior, e) => prior.then(() => finishIfDone(tx, e)), Promise.resolve());
}

export async function addQuestion(m: Member, raw: Record<string, string>) {
	requireManage(m);
	const input = questionSchema.parse(raw);
	await withTenant(userCtx(m), async (tx) => {
		const [l] = await tx
			.select({ kind: courseLessons.kind, courseId: courseLessons.courseId })
			.from(courseLessons)
			.where(eq(courseLessons.id, input.lessonId));
		if (!l) throw new AppError('not_found', 'That lesson does not exist.', 404);
		if (l.kind !== 'quiz') throw new AppError('not_quiz', 'Questions go on quiz lessons only.', 400);
		await lockedCourse(tx, l.courseId);
		const [{ n, last }] = await tx
			.select({ n: count(), last: sql<number>`coalesce(max(${quizQuestions.sortOrder}), 0)::int` })
			.from(quizQuestions)
			.where(eq(quizQuestions.lessonId, input.lessonId));
		if (n >= LEARNING_LIMITS.questions)
			throw new AppError('too_many', `A quiz holds up to ${LEARNING_LIMITS.questions} questions.`, 409);
		const options = input.options.map((o) => ({ ...o, id: randomUUID().slice(0, 8) }));
		await tx.insert(quizQuestions).values({
			tenantId: m.tenant.id,
			lessonId: input.lessonId,
			sortOrder: last + 1,
			prompt: input.prompt,
			options: options.map(({ id: optionId, text }) => ({ id: optionId, text })),
			answerIds: options.filter((o) => o.correct).map((o) => o.id)
		});
	});
}

export async function removeQuestion(m: Member, rawId: string) {
	requireManage(m);
	const questionId = id('Choose a question.').parse(rawId);
	await withTenant(userCtx(m), async (tx) => {
		const [q] = await tx
			.select({ courseId: courseLessons.courseId })
			.from(quizQuestions)
			.innerJoin(courseLessons, eq(courseLessons.id, quizQuestions.lessonId))
			.where(eq(quizQuestions.id, questionId));
		if (!q) throw new AppError('not_found', 'That question does not exist.', 404);
		const c = await lockedCourse(tx, q.courseId);
		await tx.delete(quizQuestions).where(eq(quizQuestions.id, questionId));
		if (c.status === 'published') await assertPublishable(tx, q.courseId);
	});
}

type Target = Pick<typeof courseAssignments.$inferSelect, 'audience' | 'departmentId' | 'branchId' | 'employeeId'>;

const targetEmployees = (a: Target) => sql`
	with recursive down(id, depth) as (
		select id, 0 from departments where id = ${a.departmentId}::uuid
		union all
		select d.id, down.depth + 1 from departments d join down on d.parent_id = down.id where down.depth < 20
	)
	select e.id from employees e
	where e.status <> 'exited' and (
		${a.audience} = 'all'
		or (${a.audience} = 'department' and e.department_id in (select id from down))
		or (${a.audience} = 'branch' and e.branch_id = ${a.branchId}::uuid)
		or (${a.audience} = 'employee' and e.id = ${a.employeeId}::uuid))`;

async function enrolAssignment(tx: Tx, a: typeof courseAssignments.$inferSelect, today: string): Promise<string[]> {
	const due = addDays(today, a.dueInDays);
	const claimed = await tx.execute<{ employee_id: string; status: string }>(sql`
		update course_enrolments ce set assignment_id = ${a.id}, mandatory = ${a.mandatory},
			due_on = case when ce.status = 'passed' then ce.due_on else ${due}::date end,
			expires_on = case when ce.status = 'passed' and ${a.renewEveryMonths}::int is not null
				then ((ce.completed_at at time zone (select timezone from tenant_settings limit 1))::date
					+ make_interval(months => ${a.renewEveryMonths}::int))::date
				else ce.expires_on end
		where ce.course_id = ${a.courseId} and ce.assignment_id is null
			and ce.employee_id in (${targetEmployees(a)})
			and ce.cycle = (select max(x.cycle) from course_enrolments x where x.course_id = ce.course_id and x.employee_id = ce.employee_id)
		returning ce.employee_id, ce.status`);
	const added = await tx.execute<{ employee_id: string }>(sql`
		insert into course_enrolments (tenant_id, course_id, employee_id, assignment_id, cycle, due_on, mandatory)
		select ${a.tenantId}, ${a.courseId}, t.id, ${a.id}, 1, ${due}, ${a.mandatory}
		from (${targetEmployees(a)}) t
		where not exists (select 1 from course_enrolments x where x.course_id = ${a.courseId} and x.employee_id = t.id)
		on conflict do nothing
		returning employee_id`);
	return [...claimed.filter((r) => r.status !== 'passed'), ...added].map((r) => r.employee_id);
}

async function tellEnrolled(
	tx: Tx,
	tenantId: string,
	slug: string,
	employeeIds: string[],
	title: string,
	courseId: string
) {
	return notify(
		tx,
		tenantId,
		await activeMembershipsOf(tx, employeeIds),
		{ category: 'learning', title: `New course for you: ${title}`, link: `learning/${courseId}` },
		slug
	);
}

async function assertTarget(tx: Tx, a: Target) {
	const found = a.departmentId
		? await tx.select({ id: departments.id }).from(departments).where(eq(departments.id, a.departmentId))
		: a.branchId
			? await tx.select({ id: branches.id }).from(branches).where(eq(branches.id, a.branchId))
			: a.employeeId
				? await tx
						.select({ id: employees.id })
						.from(employees)
						.where(and(eq(employees.id, a.employeeId), ne(employees.status, 'exited')))
				: [{ id: 'all' }];
	if (!found.length) throw new AppError('invalid_target', `Choose a ${a.audience} from the list.`, 400);
}

export async function assignCourse(m: Member, raw: Record<string, string>): Promise<number> {
	requireManage(m);
	const input = assignSchema.parse(raw);
	const { mails, enrolled } = await withTenant(userCtx(m), async (tx) => {
		const c = await lockedCourse(tx, input.courseId);
		if (c.status !== 'published') throw new AppError('not_published', 'Publish the course before assigning it.', 409);
		await assertTarget(tx, input);
		const [{ n }] = await tx.select({ n: count() }).from(courseAssignments).where(eq(courseAssignments.courseId, c.id));
		if (n >= LEARNING_LIMITS.assignments)
			throw new AppError('too_many', `A course holds up to ${LEARNING_LIMITS.assignments} assignments.`, 409);
		const [a] = await tx
			.insert(courseAssignments)
			.values({ tenantId: m.tenant.id, ...input, createdByUserId: m.user.userId })
			.returning();
		const ids = await enrolAssignment(tx, a, await tenantToday(tx));
		return { mails: await tellEnrolled(tx, m.tenant.id, m.tenant.slug, ids, c.title, c.id), enrolled: ids.length };
	});
	await sendAll(mails);
	return enrolled;
}

export async function removeAssignment(m: Member, rawId: string) {
	requireManage(m);
	const assignmentId = id('Choose an assignment.').parse(rawId);
	await withTenant(userCtx(m), async (tx) => {
		const [a] = await tx
			.select({ courseId: courseAssignments.courseId })
			.from(courseAssignments)
			.where(eq(courseAssignments.id, assignmentId));
		if (!a) throw new AppError('not_found', 'That assignment does not exist.', 404);
		await lockedCourse(tx, a.courseId);
		await tx.execute(sql`
			delete from course_enrolments ce where ce.assignment_id = ${assignmentId} and ce.status = 'assigned'
				and not exists (select 1 from lesson_progress lp where lp.enrolment_id = ce.id)`);
		await tx
			.update(courseEnrolments)
			.set({ assignmentId: null, mandatory: false })
			.where(eq(courseEnrolments.assignmentId, assignmentId));
		await tx.delete(courseAssignments).where(eq(courseAssignments.id, assignmentId));
	});
}

const notStaff = () => new AppError('forbidden', 'Only employees can take courses.', 403);

async function requireLearner(tx: Tx, m: Member) {
	const employeeId = m.access.employeeId;
	if (!employeeId) throw notStaff();
	await requireActiveMember(tx, m.access.membershipId);
	const [e] = await tx.select({ status: employees.status }).from(employees).where(eq(employees.id, employeeId));
	if (!e || e.status === 'exited') throw notStaff();
	return employeeId;
}

export async function selfEnrol(m: Member, rawId: string) {
	const courseId = id('Choose a course.').parse(rawId);
	await withTenant(userCtx(m), async (tx) => {
		const employeeId = await requireLearner(tx, m);
		const [c] = await tx.select({ status: courses.status }).from(courses).where(eq(courses.id, courseId));
		if (c?.status !== 'published') throw courseMissing();
		const added = await tx
			.insert(courseEnrolments)
			.values({ tenantId: m.tenant.id, courseId, employeeId })
			.onConflictDoNothing()
			.returning({ id: courseEnrolments.id });
		if (!added.length) throw new AppError('enrolled', 'You are already on this course.', 409);
	});
}

async function currentEnrolment(tx: Tx, courseId: string, employeeId: string, lock = false) {
	const q = tx
		.select()
		.from(courseEnrolments)
		.where(and(eq(courseEnrolments.courseId, courseId), eq(courseEnrolments.employeeId, employeeId)))
		.orderBy(desc(courseEnrolments.cycle))
		.limit(1);
	const [e] = await (lock ? q.for('update') : q);
	return e ?? null;
}

async function openEnrolment(tx: Tx, m: Member, courseId: string) {
	const employeeId = await requireLearner(tx, m);
	const [c] = await tx.select().from(courses).where(eq(courses.id, courseId)).for('share');
	if (!c || c.status === 'draft') throw courseMissing();
	const e = await currentEnrolment(tx, courseId, employeeId, true);
	if (!e) throw new AppError('not_enrolled', 'Start the course first.', 409);
	if (e.status === 'passed') throw new AppError('done', 'You have already finished this course.', 409);
	if (e.status === 'failed')
		throw new AppError('no_attempts', 'You have used all your attempts. Ask HR for another try.', 409);
	if (c.status !== 'published') throw new AppError('archived', 'This course is no longer running.', 409);
	return { course: c, enrolment: e };
}

async function lessonOf(tx: Tx, courseId: string, lessonId: string) {
	const [l] = await tx
		.select()
		.from(courseLessons)
		.where(and(eq(courseLessons.id, lessonId), eq(courseLessons.courseId, courseId)));
	if (!l) throw new AppError('not_found', 'That lesson does not exist.', 404);
	return l;
}

const certificatePayload = (e: { id: string; employeeId: string; courseId: string; cycle: number }, at: Date) =>
	`${e.id}:${e.employeeId}:${e.courseId}:${e.cycle}:${at.toISOString()}`;

export const certificateCode = (payload: string) =>
	createHash('sha256')
		.update(keyedMac('course-certificate', payload))
		.digest('hex')
		.slice(0, 20)
		.toUpperCase()
		.replace(/(.{5})(?!$)/g, '$1-');

async function finishIfDone(tx: Tx, e: typeof courseEnrolments.$inferSelect) {
	const [r] = await tx
		.select({
			total: sql<number>`(select count(*)::int from ${courseLessons} l where l.course_id = ${e.courseId})`,
			done: sql<number>`(select count(*)::int from ${lessonProgress} p join ${courseLessons} l on l.id = p.lesson_id where p.enrolment_id = ${e.id} and p.completed_at is not null)`,
			score: sql<
				number | null
			>`(select round(avg(p.score))::int from ${lessonProgress} p join ${courseLessons} l on l.id = p.lesson_id where p.enrolment_id = ${e.id} and l.kind = 'quiz')`
		})
		.from(sql`(select 1) one`);
	if (!r.total || r.done < r.total) return false;
	const at = now();
	const [renew] = e.assignmentId
		? await tx
				.select({ months: courseAssignments.renewEveryMonths })
				.from(courseAssignments)
				.where(eq(courseAssignments.id, e.assignmentId))
		: [];
	const today = await tenantToday(tx);
	await tx
		.update(courseEnrolments)
		.set({
			status: 'passed',
			completedAt: at,
			score: r.score,
			expiresOn: renew?.months ? addMonthsTo(today, renew.months) : null,
			certificateCode: certificateCode(certificatePayload(e, at))
		})
		.where(eq(courseEnrolments.id, e.id));
	return true;
}

const lessonIds = z.object({ courseId: id('Choose a course.'), lessonId: id('Choose a lesson.') });

export async function completeLesson(m: Member, raw: Record<string, string>) {
	const input = lessonIds.parse(raw);
	return withTenant(userCtx(m), async (tx) => {
		const { enrolment } = await openEnrolment(tx, m, input.courseId);
		const lesson = await lessonOf(tx, input.courseId, input.lessonId);
		if (lesson.kind === 'quiz') throw new AppError('quiz', 'Answer the quiz to finish this lesson.', 400);
		await tx
			.insert(lessonProgress)
			.values({ tenantId: m.tenant.id, enrolmentId: enrolment.id, lessonId: lesson.id, completedAt: now() })
			.onConflictDoUpdate({
				target: [lessonProgress.tenantId, lessonProgress.enrolmentId, lessonProgress.lessonId],
				set: { completedAt: sql`coalesce(${lessonProgress.completedAt}, excluded.completed_at)` }
			});
		return { finished: await finishIfDone(tx, enrolment) };
	});
}

export const gradeQuiz = (questions: { id: string; answerIds: string[] }[], picked: Map<string, string[]>): number => {
	if (!questions.length) return 0;
	const right = questions.filter((q) => {
		const mine = new Set(picked.get(q.id) ?? []);
		return mine.size === q.answerIds.length && q.answerIds.every((a) => mine.has(a));
	}).length;
	return Math.floor((right * 100) / questions.length);
};

export type QuizResult = { score: number; passed: boolean; attemptsLeft: number; finished: boolean };

export async function submitQuiz(m: Member, raw: Record<string, string>, picked: Map<string, string[]>) {
	const input = lessonIds.parse(raw);
	return withTenant(userCtx(m), async (tx): Promise<QuizResult> => {
		const { course, enrolment } = await openEnrolment(tx, m, input.courseId);
		const lesson = await lessonOf(tx, input.courseId, input.lessonId);
		if (lesson.kind !== 'quiz') throw new AppError('not_quiz', 'That lesson has no quiz.', 400);
		const [p] = await tx
			.insert(lessonProgress)
			.values({ tenantId: m.tenant.id, enrolmentId: enrolment.id, lessonId: lesson.id })
			.onConflictDoUpdate({
				target: [lessonProgress.tenantId, lessonProgress.enrolmentId, lessonProgress.lessonId],
				set: { attempts: sql`${lessonProgress.attempts}` }
			})
			.returning();
		if (p.completedAt) throw new AppError('done', 'You have already passed this quiz.', 409);
		if (p.attempts >= course.maxAttempts)
			throw new AppError('no_attempts', 'You have used all your attempts. Ask HR for another try.', 409);
		const questions = await tx
			.select({ id: quizQuestions.id, answerIds: quizQuestions.answerIds })
			.from(quizQuestions)
			.where(eq(quizQuestions.lessonId, lesson.id));
		if (!questions.length) throw new AppError('empty_quiz', 'This quiz has no questions yet.', 409);
		const score = gradeQuiz(questions, picked);
		const passed = score >= course.passMark;
		const attempts = p.attempts + 1;
		await tx
			.update(lessonProgress)
			.set({
				attempts,
				score: Math.max(score, p.score ?? 0),
				completedAt: passed ? now() : null
			})
			.where(eq(lessonProgress.id, p.id));
		if (!passed && attempts >= course.maxAttempts)
			await tx.update(courseEnrolments).set({ status: 'failed' }).where(eq(courseEnrolments.id, enrolment.id));
		const finished = passed ? await finishIfDone(tx, enrolment) : false;
		return { score, passed, attemptsLeft: Math.max(course.maxAttempts - attempts, 0), finished };
	});
}

export async function allowRetry(m: Member, rawId: string) {
	requireManage(m);
	const enrolmentId = id('Choose a person.').parse(rawId);
	await withTenant(userCtx(m), async (tx) => {
		const [e] = await tx
			.select({ status: courseEnrolments.status })
			.from(courseEnrolments)
			.where(eq(courseEnrolments.id, enrolmentId))
			.for('update');
		if (!e) throw new AppError('not_found', 'That enrolment does not exist.', 404);
		if (e.status !== 'failed') throw new AppError('not_failed', 'Only a failed course can be tried again.', 409);
		await tx
			.update(lessonProgress)
			.set({ attempts: 0 })
			.where(and(eq(lessonProgress.enrolmentId, enrolmentId), isNull(lessonProgress.completedAt)));
		await tx.update(courseEnrolments).set({ status: 'assigned' }).where(eq(courseEnrolments.id, enrolmentId));
	});
}

const latestCycle = sql`${courseEnrolments.cycle} = (select max(x.cycle) from course_enrolments x where x.course_id = course_enrolments.course_id and x.employee_id = course_enrolments.employee_id)`;

const lastPassed = sql<
	string | null
>`(select x.id from course_enrolments x where x.course_id = course_enrolments.course_id
	and x.employee_id = course_enrolments.employee_id and x.status = 'passed' order by x.cycle desc limit 1)`;

const progressCounts = {
	lessons: sql<number>`(select count(*)::int from ${courseLessons} l where l.course_id = course_enrolments.course_id)`,
	done: sql<number>`(select count(*)::int from ${lessonProgress} p where p.enrolment_id = course_enrolments.id and p.completed_at is not null)`
};

export async function learningPage(tx: Tx, access: Access) {
	const today = await tenantToday(tx);
	const mine = access.employeeId
		? await tx
				.select({
					id: courseEnrolments.id,
					courseId: courses.id,
					title: courses.title,
					status: courseEnrolments.status,
					dueOn: courseEnrolments.dueOn,
					mandatory: courseEnrolments.mandatory,
					expiresOn: courseEnrolments.expiresOn,
					completedAt: courseEnrolments.completedAt,
					certificateId: lastPassed,
					...progressCounts
				})
				.from(courseEnrolments)
				.innerJoin(courses, eq(courses.id, courseEnrolments.courseId))
				.where(and(eq(courseEnrolments.employeeId, access.employeeId), latestCycle, ne(courses.status, 'draft')))
				.orderBy(asc(courseEnrolments.status), sql`${courseEnrolments.dueOn} nulls last`, asc(courses.title))
				.limit(LEARNING_LIMITS.list)
		: [];
	const taken = new Set(mine.map((e) => e.courseId));
	const catalogue = (
		await tx
			.select({ id: courses.id, title: courses.title, description: courses.description })
			.from(courses)
			.where(eq(courses.status, 'published'))
			.orderBy(asc(courses.title))
			.limit(LEARNING_LIMITS.list)
	).filter((c) => !taken.has(c.id));
	const manage = can(access, 'course.manage')
		? await tx
				.select({
					id: courses.id,
					title: courses.title,
					status: courses.status,
					lessons: sql<number>`(select count(*)::int from ${courseLessons} l where l.course_id = courses.id)`,
					enrolled: sql<number>`(select count(distinct e.employee_id)::int from ${courseEnrolments} e where e.course_id = courses.id)`
				})
				.from(courses)
				.orderBy(asc(courses.status), asc(courses.title))
				.limit(LEARNING_LIMITS.courses)
		: null;
	return {
		today,
		mine: mine.map((e) => ({ ...e, overdue: e.status !== 'passed' && !!e.dueOn && e.dueOn < today })),
		catalogue,
		certifications: access.employeeId ? await certificationsOf(tx, access.employeeId) : [],
		manage,
		canReport: can(access, 'course.report'),
		isEmployee: !!access.employeeId
	};
}

async function certificationsOf(tx: Tx, employeeId: string) {
	const rows = await tx
		.select({
			id: certifications.id,
			name: certifications.name,
			issuer: certifications.issuer,
			issuedOn: certifications.issuedOn,
			expiresOn: certifications.expiresOn
		})
		.from(certifications)
		.where(eq(certifications.employeeId, employeeId))
		.orderBy(sql`${certifications.expiresOn} nulls last`, asc(certifications.name));
	const attached = await filesFor(
		tx,
		'certification',
		rows.map((r) => r.id)
	);
	return rows.map((r) => ({ ...r, files: attached.get(r.id) ?? [] }));
}

export async function coursePage(tx: Tx, access: Access, courseId: string) {
	if (!z.uuid().safeParse(courseId).success) throw courseMissing();
	const [course] = await tx.select().from(courses).where(eq(courses.id, courseId));
	const manager = can(access, 'course.manage');
	if (!course || (!manager && course.status === 'draft')) throw courseMissing();
	const lessons = await tx
		.select({
			id: courseLessons.id,
			kind: courseLessons.kind,
			title: courseLessons.title,
			body: courseLessons.body,
			url: courseLessons.url
		})
		.from(courseLessons)
		.where(eq(courseLessons.courseId, courseId))
		.orderBy(asc(courseLessons.sortOrder));
	const questions = await tx
		.select({
			id: quizQuestions.id,
			lessonId: quizQuestions.lessonId,
			prompt: quizQuestions.prompt,
			options: quizQuestions.options,
			answerIds: quizQuestions.answerIds
		})
		.from(quizQuestions)
		.where(
			inArray(
				quizQuestions.lessonId,
				lessons.map((l) => l.id)
			)
		)
		.orderBy(asc(quizQuestions.sortOrder));
	const enrolment = access.employeeId ? await currentEnrolment(tx, courseId, access.employeeId) : null;
	const attached = await filesFor(
		tx,
		'course_lesson',
		manager || enrolment ? lessons.filter((l) => l.kind === 'file').map((l) => l.id) : []
	);
	const [certificate] = enrolment
		? await tx
				.select({ id: courseEnrolments.id })
				.from(courseEnrolments)
				.where(
					and(
						eq(courseEnrolments.courseId, courseId),
						eq(courseEnrolments.employeeId, enrolment.employeeId),
						eq(courseEnrolments.status, 'passed')
					)
				)
				.orderBy(desc(courseEnrolments.cycle))
				.limit(1)
		: [];
	const progress = enrolment
		? await tx
				.select({
					lessonId: lessonProgress.lessonId,
					attempts: lessonProgress.attempts,
					score: lessonProgress.score,
					completedAt: lessonProgress.completedAt
				})
				.from(lessonProgress)
				.where(eq(lessonProgress.enrolmentId, enrolment.id))
		: [];
	const forLearner = (q: (typeof questions)[number]) => ({
		id: q.id,
		prompt: q.prompt,
		multiple: q.answerIds.length > 1,
		options: q.options.map((o: QuizOption) => ({ id: o.id, text: o.text }))
	});
	return {
		course: {
			id: course.id,
			title: course.title,
			description: course.description,
			passMark: course.passMark,
			maxAttempts: course.maxAttempts,
			status: course.status
		},
		lessons: lessons.map((l) => ({
			...l,
			files: attached.get(l.id) ?? [],
			questions: questions.filter((q) => q.lessonId === l.id).map(forLearner),
			progress: progress.find((p) => p.lessonId === l.id) ?? null
		})),
		certificateId: certificate?.id ?? null,
		enrolment: enrolment && {
			id: enrolment.id,
			status: enrolment.status,
			dueOn: enrolment.dueOn,
			score: enrolment.score,
			completedAt: enrolment.completedAt,
			expiresOn: enrolment.expiresOn
		},
		manage: manager ? await manageView(tx, course.id, questions) : null
	};
}

async function manageView(
	tx: Tx,
	courseId: string,
	questions: { id: string; lessonId: string; options: QuizOption[]; answerIds: string[] }[]
) {
	const assignments = await tx
		.select({
			id: courseAssignments.id,
			audience: courseAssignments.audience,
			department: departments.name,
			branch: branches.name,
			employee: employees.fullName,
			dueInDays: courseAssignments.dueInDays,
			mandatory: courseAssignments.mandatory,
			renewEveryMonths: courseAssignments.renewEveryMonths,
			enrolled: sql<number>`(select count(*)::int from ${courseEnrolments} e where e.assignment_id = course_assignments.id)`
		})
		.from(courseAssignments)
		.leftJoin(departments, eq(departments.id, courseAssignments.departmentId))
		.leftJoin(branches, eq(branches.id, courseAssignments.branchId))
		.leftJoin(employees, eq(employees.id, courseAssignments.employeeId))
		.where(eq(courseAssignments.courseId, courseId))
		.orderBy(asc(courseAssignments.createdAt));
	const failed = await tx
		.select({ id: courseEnrolments.id, name: employees.fullName })
		.from(courseEnrolments)
		.innerJoin(employees, eq(employees.id, courseEnrolments.employeeId))
		.where(and(eq(courseEnrolments.courseId, courseId), eq(courseEnrolments.status, 'failed')))
		.orderBy(asc(employees.fullName))
		.limit(LEARNING_LIMITS.list);
	return {
		assignments,
		failed,
		answers: Object.fromEntries(
			questions.map((q) => [
				q.id,
				q.options.map((o) => `${q.answerIds.includes(o.id) ? '* ' : ''}${o.text}`).join('\n')
			])
		),
		departments: await tx
			.select({ id: departments.id, name: departments.name })
			.from(departments)
			.orderBy(asc(departments.name)),
		branches: await tx.select({ id: branches.id, name: branches.name }).from(branches).orderBy(asc(branches.name)),
		employees: await tx
			.select({ id: employees.id, name: employees.fullName, code: employees.code })
			.from(employees)
			.where(ne(employees.status, 'exited'))
			.orderBy(asc(employees.fullName))
			.limit(2000)
	};
}

export async function addCertification(m: Member, raw: Record<string, string>) {
	const input = certificationSchema.parse(raw);
	await withTenant(userCtx(m), async (tx) => {
		const employeeId = await requireLearner(tx, m);
		const [{ n }] = await tx
			.select({ n: count() })
			.from(certifications)
			.where(eq(certifications.employeeId, employeeId));
		if (n >= LEARNING_LIMITS.certifications)
			throw new AppError('too_many', `Keep up to ${LEARNING_LIMITS.certifications} certifications.`, 409);
		await tx
			.insert(certifications)
			.values({ tenantId: m.tenant.id, employeeId, ...input, addedByUserId: m.user.userId });
	});
}

export async function removeCertification(m: Member, rawId: string) {
	const certificationId = id('Choose a certification.').parse(rawId);
	const keys = await withTenant(userCtx(m), async (tx) => {
		const employeeId = await requireLearner(tx, m);
		const [c] = await tx
			.select({ id: certifications.id })
			.from(certifications)
			.where(and(eq(certifications.id, certificationId), eq(certifications.employeeId, employeeId)));
		if (!c) throw new AppError('not_found', 'That certification does not exist.', 404);
		const stored = await dropFiles(tx, 'certification', [c.id]);
		await tx.delete(certifications).where(eq(certifications.id, c.id));
		return stored;
	});
	await discardFiles(keys);
}

const learningOn = async (tx: Tx) => moduleOn(await moduleOverrides(tx), 'learning');

export const lessonAttachments: AttachmentRules = {
	async canRead(tx, access, lessonId) {
		if (!(await learningOn(tx))) return false;
		const [l] = await tx
			.select({ courseId: courseLessons.courseId, status: courses.status })
			.from(courseLessons)
			.innerJoin(courses, eq(courses.id, courseLessons.courseId))
			.where(eq(courseLessons.id, lessonId));
		if (!l) return false;
		if (can(access, 'course.manage')) return true;
		return l.status !== 'draft' && !!access.employeeId && !!(await currentEnrolment(tx, l.courseId, access.employeeId));
	},
	async canEdit(tx, access, lessonId) {
		const [l] = await tx.select({ kind: courseLessons.kind }).from(courseLessons).where(eq(courseLessons.id, lessonId));
		return l?.kind === 'file' && can(access, 'course.manage') && (await learningOn(tx));
	}
};

export const certificationAttachments: AttachmentRules = {
	async canRead(tx, access, certificationId) {
		if (!(await learningOn(tx))) return false;
		const [c] = await tx
			.select({ employeeId: certifications.employeeId })
			.from(certifications)
			.where(eq(certifications.id, certificationId));
		if (!c) return false;
		return c.employeeId === access.employeeId || inScope(await resolveScope(tx, access, 'course.report'), c.employeeId);
	},
	async canEdit(tx, access, certificationId) {
		const [c] = await tx
			.select({ employeeId: certifications.employeeId })
			.from(certifications)
			.where(eq(certifications.id, certificationId));
		return !!c && !!access.employeeId && c.employeeId === access.employeeId && (await learningOn(tx));
	}
};

async function passedEnrolment(tx: Tx, access: Access, enrolmentId: string) {
	if (!z.uuid().safeParse(enrolmentId).success) return null;
	const [e] = await tx
		.select({
			employeeId: courseEnrolments.employeeId,
			name: employees.fullName,
			course: courses.title,
			completedAt: courseEnrolments.completedAt,
			code: courseEnrolments.certificateCode,
			expiresOn: courseEnrolments.expiresOn,
			score: courseEnrolments.score
		})
		.from(courseEnrolments)
		.innerJoin(courses, eq(courses.id, courseEnrolments.courseId))
		.innerJoin(employees, eq(employees.id, courseEnrolments.employeeId))
		.where(and(eq(courseEnrolments.id, enrolmentId), eq(courseEnrolments.status, 'passed')));
	if (!e) return null;
	if (e.employeeId !== access.employeeId && !inScope(await resolveScope(tx, access, 'course.report'), e.employeeId))
		return null;
	return e;
}

export async function certificatePdf(m: Member, enrolmentId: string) {
	const { e, company, tz } = await withTenant(userCtx(m), async (tx) => {
		const found = await passedEnrolment(tx, m.access, enrolmentId);
		if (!found) throw new AppError('not_found', 'That certificate does not exist.', 404);
		const [s] = await tx
			.select({ legalName: tenantSettings.legalName, tz: tenantSettings.timezone })
			.from(tenantSettings);
		return { e: found, company: s?.legalName || m.tenant.name, tz: s?.tz ?? 'UTC' };
	});
	const completed = e.completedAt!.toLocaleDateString('en-GB', {
		day: 'numeric',
		month: 'long',
		year: 'numeric',
		timeZone: tz
	});
	return {
		fileName: `certificate-${e.course.replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 60)}.pdf`,
		body: await renderCertificatePdf({
			company,
			name: e.name,
			course: e.course,
			completed,
			validUntil: e.expiresOn,
			code: e.code!
		})
	};
}

export function renderCertificatePdf(c: {
	company: string;
	name: string;
	course: string;
	completed: string;
	validUntil: string | null;
	code: string;
}) {
	const { doc, done } = pdfDoc(`Certificate: ${c.course}`);
	const line = (text: string, size: number, y: number) => centred(doc.fontSize(size), text, 48, y, 499);
	let y = line(c.company, 12, 96);
	y = line('Certificate of completion', 26, y + 40);
	y = line('This certifies that', 12, y + 40);
	y = line(c.name, 22, y + 12);
	y = line('has completed the course', 12, y + 20);
	y = line(c.course, 18, y + 12);
	y = line(`on ${c.completed}`, 12, y + 20);
	if (c.validUntil) line(`Valid until ${c.validUntil}`, 12, y + 8);
	line(`Verification code: ${c.code}`, 9, 740);
	doc.end();
	return done;
}

const codeSchema = z
	.string()
	.trim()
	.toUpperCase()
	.regex(/^[0-9A-F]{5}(-[0-9A-F]{5}){3}$/, 'Enter the code as printed, like 1A2B3-C4D5E-F6A7B-8C9D0.');

export async function verifyCertificate(tx: Tx, access: Access, raw: string) {
	const code = codeSchema.parse(raw);
	if (!can(access, 'course.report')) throw forbidden();
	const [e] = await tx
		.select({ id: courseEnrolments.id })
		.from(courseEnrolments)
		.where(and(eq(courseEnrolments.certificateCode, code), eq(courseEnrolments.status, 'passed')));
	const found = e ? await passedEnrolment(tx, access, e.id) : null;
	if (!found) return { valid: false as const };
	const expired = !!found.expiresOn && found.expiresOn < (await tenantToday(tx));
	return {
		valid: !expired,
		expired,
		name: found.name,
		course: found.course,
		completedAt: found.completedAt,
		expiresOn: found.expiresOn
	};
}

export async function learningReport(tx: Tx, access: Access) {
	const scope = await resolveScope(tx, access, 'course.report');
	const today = await tenantToday(tx);
	const inView = and(scopeWhere(scope, courseEnrolments.employeeId), latestCycle, ne(employees.status, 'exited'));
	const overdueSql = sql`${courseEnrolments.status} <> 'passed' and ${courseEnrolments.dueOn} < ${today}`;
	const byCourse = await tx
		.select({
			id: courses.id,
			title: courses.title,
			enrolled: count(),
			passed: sql<number>`count(*) filter (where exists (select 1 from course_enrolments x where x.course_id = course_enrolments.course_id
				and x.employee_id = course_enrolments.employee_id and x.status = 'passed' and (x.expires_on is null or x.expires_on >= ${today})))::int`,
			failed: sql<number>`count(*) filter (where ${courseEnrolments.status} = 'failed')::int`,
			overdue: sql<number>`count(*) filter (where ${overdueSql})::int`
		})
		.from(courseEnrolments)
		.innerJoin(courses, eq(courses.id, courseEnrolments.courseId))
		.innerJoin(employees, eq(employees.id, courseEnrolments.employeeId))
		.where(and(inView, ne(courses.status, 'draft')))
		.groupBy(courses.id, courses.title)
		.orderBy(asc(courses.title));
	const overdue = await tx
		.select({
			id: courseEnrolments.id,
			name: employees.fullName,
			code: employees.code,
			course: courses.title,
			dueOn: courseEnrolments.dueOn,
			mandatory: courseEnrolments.mandatory
		})
		.from(courseEnrolments)
		.innerJoin(courses, eq(courses.id, courseEnrolments.courseId))
		.innerJoin(employees, eq(employees.id, courseEnrolments.employeeId))
		.where(and(inView, eq(courses.status, 'published'), overdueSql))
		.orderBy(asc(courseEnrolments.dueOn), asc(employees.fullName))
		.limit(LEARNING_LIMITS.list);
	const expiring = await tx
		.select({
			id: certifications.id,
			name: employees.fullName,
			certification: certifications.name,
			expiresOn: certifications.expiresOn
		})
		.from(certifications)
		.innerJoin(employees, eq(employees.id, certifications.employeeId))
		.where(
			and(
				scopeWhere(scope, certifications.employeeId),
				ne(employees.status, 'exited'),
				isNotNull(certifications.expiresOn),
				lt(certifications.expiresOn, addDays(today, 61))
			)
		)
		.orderBy(asc(certifications.expiresOn))
		.limit(LEARNING_LIMITS.list);
	return {
		today,
		byCourse: byCourse.map((c) => ({ ...c, rate: c.enrolled ? Math.round((c.passed * 100) / c.enrolled) : 0 })),
		overdue,
		expiring
	};
}

export async function learningDay(tenantId: string, slug: string): Promise<Mail[]> {
	return withTenant(systemCtx(tenantId), async (tx) => {
		if (!(await learningOn(tx))) return [];
		const today = await tenantToday(tx);
		if (!(await claimDay(tx, tenantId, 'learning_day', today))) return [];
		const live = await tx
			.select({ a: courseAssignments, title: courses.title })
			.from(courseAssignments)
			.innerJoin(courses, eq(courses.id, courseAssignments.courseId))
			.where(eq(courses.status, 'published'));
		const joined = await live.reduce<Promise<Mail[]>>(
			(prior, { a, title }) =>
				prior.then(async (all) => [
					...all,
					...(await tellEnrolled(tx, tenantId, slug, await enrolAssignment(tx, a, today), title, a.courseId))
				]),
			Promise.resolve([])
		);
		const renewed = await tx.execute<{ employee_id: string; course_id: string; title: string }>(sql`
			insert into course_enrolments (tenant_id, course_id, employee_id, assignment_id, cycle, due_on, mandatory)
			select ce.tenant_id, ce.course_id, ce.employee_id, ce.assignment_id, ce.cycle + 1, ce.expires_on, ca.mandatory
			from course_enrolments ce
			join course_assignments ca on ca.id = ce.assignment_id
			join courses c on c.id = ce.course_id and c.status = 'published'
			join employees e on e.id = ce.employee_id and e.status <> 'exited'
			where ce.status = 'passed' and ce.expires_on is not null
				and ce.expires_on - ca.due_in_days <= ${today}::date
				and not exists (select 1 from course_enrolments n where n.course_id = ce.course_id
					and n.employee_id = ce.employee_id and n.cycle > ce.cycle)
			on conflict do nothing
			returning employee_id, course_id, (select title from courses where id = course_id) as title`);
		const renewalMails = await renewed.reduce<Promise<Mail[]>>(
			(prior, r) =>
				prior.then(async (all) => [
					...all,
					...(await notify(
						tx,
						tenantId,
						await activeMembershipsOf(tx, [r.employee_id]),
						{ category: 'learning', title: `Time to renew: ${r.title}`, link: `learning/${r.course_id}` },
						slug
					))
				]),
			Promise.resolve([])
		);
		const days = REMIND_DAYS.map((d) => addDays(today, d));
		const dueSoon = await tx
			.select({
				employeeId: courseEnrolments.employeeId,
				courseId: courses.id,
				title: courses.title,
				dueOn: courseEnrolments.dueOn
			})
			.from(courseEnrolments)
			.innerJoin(courses, eq(courses.id, courseEnrolments.courseId))
			.where(
				and(
					eq(courseEnrolments.status, 'assigned'),
					eq(courses.status, 'published'),
					inArray(courseEnrolments.dueOn, days)
				)
			);
		const expiring = await tx
			.select({ employeeId: certifications.employeeId, name: certifications.name, expiresOn: certifications.expiresOn })
			.from(certifications)
			.where(inArray(certifications.expiresOn, days));
		const reminders = [
			...dueSoon.map((d) => ({
				employeeId: d.employeeId,
				title: `${d.title} is due on ${d.dueOn}`,
				link: `learning/${d.courseId}`
			})),
			...expiring.map((c) => ({
				employeeId: c.employeeId,
				title: `Your ${c.name} certification expires on ${c.expiresOn}`,
				link: 'learning'
			}))
		];
		const reminderMails = await reminders.reduce<Promise<Mail[]>>(
			(prior, r) =>
				prior.then(async (all) => [
					...all,
					...(await notify(
						tx,
						tenantId,
						await activeMembershipsOf(tx, [r.employeeId]),
						{ category: 'learning', title: r.title, link: r.link },
						slug
					))
				]),
			Promise.resolve([])
		);
		return [...joined, ...renewalMails, ...reminderMails];
	});
}

export async function runLearning() {
	const list = await authPool()
		.db.select({ id: tenants.id, slug: tenants.slug })
		.from(tenants)
		.where(eq(tenants.status, 'active'));
	await list.reduce<Promise<void>>(
		(prior, t) =>
			prior.then(() =>
				learningDay(t.id, t.slug)
					.then(sendAll)
					.catch((err) => log.error({ tenantId: t.id, err: (err as Error).message }, 'learning step failed'))
			),
		Promise.resolve()
	);
}
