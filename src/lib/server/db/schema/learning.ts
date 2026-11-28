import { sql } from 'drizzle-orm';
import { boolean, check, date, index, jsonb, pgTable, smallint, text, unique, uuid } from 'drizzle-orm/pg-core';
import { tenantBase, tenantKey, tfk, tstz } from './_helpers';
import { branches, departments, employees } from './org';

export const COURSE_STATUSES = ['draft', 'published', 'archived'] as const;
export const LESSON_KINDS = ['text', 'link', 'file', 'quiz'] as const;
export const ENROLMENT_STATUSES = ['assigned', 'passed', 'failed'] as const;
export const COURSE_AUDIENCES = ['all', 'department', 'branch', 'employee'] as const;
export type QuizOption = { id: string; text: string };

const inList = (column: unknown, values: readonly string[]) =>
	sql`${column} in (${sql.raw(values.map((v) => `'${v}'`).join(','))})`;

export const courses = pgTable(
	'courses',
	{
		...tenantBase(),
		title: text().notNull(),
		description: text().notNull().default(''),
		passMark: smallint().notNull().default(70),
		maxAttempts: smallint().notNull().default(3),
		status: text({ enum: COURSE_STATUSES }).notNull().default('draft'),
		createdByUserId: uuid()
	},
	(t) => [
		tenantKey('courses', t),
		index('courses_status_idx').on(t.tenantId, t.status),
		check('courses_title_ck', sql`length(trim(${t.title})) between 1 and 160`),
		check('courses_description_ck', sql`length(${t.description}) <= 5000`),
		check('courses_pass_mark_ck', sql`${t.passMark} between 1 and 100`),
		check('courses_max_attempts_ck', sql`${t.maxAttempts} between 1 and 10`),
		check('courses_status_ck', inList(t.status, COURSE_STATUSES))
	]
);

export const courseLessons = pgTable(
	'course_lessons',
	{
		...tenantBase(),
		courseId: uuid().notNull(),
		sortOrder: smallint().notNull(),
		kind: text({ enum: LESSON_KINDS }).notNull(),
		title: text().notNull(),
		body: text().notNull().default(''),
		url: text()
	},
	(t) => [
		tenantKey('course_lessons', t),
		tfk('course_lessons_course_fk', t, t.courseId, courses, 'cascade'),
		index('course_lessons_course_idx').on(t.tenantId, t.courseId, t.sortOrder),
		check('course_lessons_kind_ck', inList(t.kind, LESSON_KINDS)),
		check('course_lessons_title_ck', sql`length(trim(${t.title})) between 1 and 160`),
		check('course_lessons_body_ck', sql`length(${t.body}) <= 20000`),
		check(
			'course_lessons_url_ck',
			sql`(${t.kind} = 'link') = (${t.url} is not null) and (${t.url} is null or (${t.url} ~ '^https?://' and length(${t.url}) <= 2000))`
		)
	]
);

export const quizQuestions = pgTable(
	'quiz_questions',
	{
		...tenantBase(),
		lessonId: uuid().notNull(),
		sortOrder: smallint().notNull(),
		prompt: text().notNull(),
		options: jsonb().$type<QuizOption[]>().notNull(),
		answerIds: text().array().notNull()
	},
	(t) => [
		tenantKey('quiz_questions', t),
		tfk('quiz_questions_lesson_fk', t, t.lessonId, courseLessons, 'cascade'),
		index('quiz_questions_lesson_idx').on(t.tenantId, t.lessonId, t.sortOrder),
		check('quiz_questions_prompt_ck', sql`length(trim(${t.prompt})) between 1 and 500`),
		check('quiz_questions_options_ck', sql`jsonb_array_length(${t.options}) between 2 and 8`),
		check('quiz_questions_answers_ck', sql`cardinality(${t.answerIds}) >= 1`)
	]
);

export const courseAssignments = pgTable(
	'course_assignments',
	{
		...tenantBase(),
		courseId: uuid().notNull(),
		audience: text({ enum: COURSE_AUDIENCES }).notNull(),
		departmentId: uuid(),
		branchId: uuid(),
		employeeId: uuid(),
		dueInDays: smallint().notNull(),
		mandatory: boolean().notNull().default(true),
		renewEveryMonths: smallint(),
		createdByUserId: uuid()
	},
	(t) => [
		tenantKey('course_assignments', t),
		tfk('course_assignments_course_fk', t, t.courseId, courses, 'cascade'),
		tfk('course_assignments_department_fk', t, t.departmentId, departments, 'cascade'),
		tfk('course_assignments_branch_fk', t, t.branchId, branches, 'cascade'),
		tfk('course_assignments_employee_fk', t, t.employeeId, employees, 'cascade'),
		index('course_assignments_course_idx').on(t.tenantId, t.courseId),
		check('course_assignments_audience_ck', inList(t.audience, COURSE_AUDIENCES)),
		check(
			'course_assignments_target_ck',
			sql`(${t.departmentId} is not null) = (${t.audience} = 'department') and (${t.branchId} is not null) = (${t.audience} = 'branch') and (${t.employeeId} is not null) = (${t.audience} = 'employee')`
		),
		check('course_assignments_due_ck', sql`${t.dueInDays} between 1 and 365`),
		check('course_assignments_renew_ck', sql`${t.renewEveryMonths} is null or ${t.renewEveryMonths} between 1 and 120`)
	]
);

export const courseEnrolments = pgTable(
	'course_enrolments',
	{
		...tenantBase(),
		courseId: uuid().notNull(),
		employeeId: uuid().notNull(),
		assignmentId: uuid(),
		cycle: smallint().notNull().default(1),
		dueOn: date(),
		mandatory: boolean().notNull().default(false),
		status: text({ enum: ENROLMENT_STATUSES }).notNull().default('assigned'),
		score: smallint(),
		completedAt: tstz(),
		expiresOn: date(),
		certificateCode: text()
	},
	(t) => [
		tenantKey('course_enrolments', t),
		tfk('course_enrolments_course_fk', t, t.courseId, courses, 'cascade'),
		tfk('course_enrolments_employee_fk', t, t.employeeId, employees, 'cascade'),
		tfk('course_enrolments_assignment_fk', t, t.assignmentId, courseAssignments),
		unique('course_enrolments_uq').on(t.tenantId, t.courseId, t.employeeId, t.cycle),
		index('course_enrolments_employee_idx').on(t.tenantId, t.employeeId),
		index('course_enrolments_due_idx').on(t.tenantId, t.status, t.dueOn),
		index('course_enrolments_assignment_idx').on(t.tenantId, t.assignmentId),
		unique('course_enrolments_code_uq').on(t.tenantId, t.certificateCode),
		check('course_enrolments_status_ck', inList(t.status, ENROLMENT_STATUSES)),
		check('course_enrolments_score_ck', sql`${t.score} is null or ${t.score} between 0 and 100`),
		check('course_enrolments_cycle_ck', sql`${t.cycle} between 1 and 1000`),
		check(
			'course_enrolments_passed_ck',
			sql`(${t.status} = 'passed') = (${t.completedAt} is not null and ${t.certificateCode} is not null)`
		)
	]
);

export const lessonProgress = pgTable(
	'lesson_progress',
	{
		...tenantBase(),
		enrolmentId: uuid().notNull(),
		lessonId: uuid().notNull(),
		attempts: smallint().notNull().default(0),
		score: smallint(),
		completedAt: tstz()
	},
	(t) => [
		tenantKey('lesson_progress', t),
		tfk('lesson_progress_enrolment_fk', t, t.enrolmentId, courseEnrolments, 'cascade'),
		tfk('lesson_progress_lesson_fk', t, t.lessonId, courseLessons, 'cascade'),
		unique('lesson_progress_uq').on(t.tenantId, t.enrolmentId, t.lessonId),
		check('lesson_progress_attempts_ck', sql`${t.attempts} between 0 and 100`),
		check('lesson_progress_score_ck', sql`${t.score} is null or ${t.score} between 0 and 100`)
	]
);

export const certifications = pgTable(
	'certifications',
	{
		...tenantBase(),
		employeeId: uuid().notNull(),
		name: text().notNull(),
		issuer: text().notNull().default(''),
		issuedOn: date().notNull(),
		expiresOn: date(),
		addedByUserId: uuid()
	},
	(t) => [
		tenantKey('certifications', t),
		tfk('certifications_employee_fk', t, t.employeeId, employees, 'cascade'),
		index('certifications_employee_idx').on(t.tenantId, t.employeeId),
		index('certifications_expiry_idx').on(t.tenantId, t.expiresOn),
		check('certifications_name_ck', sql`length(trim(${t.name})) between 1 and 160`),
		check('certifications_issuer_ck', sql`length(${t.issuer}) <= 160`),
		check('certifications_dates_ck', sql`${t.expiresOn} is null or ${t.expiresOn} >= ${t.issuedOn}`)
	]
);
