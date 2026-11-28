import { sql } from 'drizzle-orm';
import {
	boolean,
	check,
	date,
	foreignKey,
	index,
	integer,
	pgTable,
	smallint,
	text,
	unique,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import { tenantBase, tenantId, tenantKey, tfk, tstz } from './_helpers';
import { memberships } from './core';
import { branches, departments } from './org';

export const SURVEY_KINDS = ['pulse', 'suggestion'] as const;
export const SURVEY_STATUSES = ['draft', 'open', 'closed'] as const;
export const QUESTION_KINDS = ['scale', 'enps', 'choice', 'text'] as const;

export const surveys = pgTable(
	'surveys',
	{
		...tenantBase(),
		kind: text().$type<(typeof SURVEY_KINDS)[number]>().notNull().default('pulse'),
		title: text().notNull(),
		intro: text().notNull().default(''),
		anonymous: boolean().notNull().default(true),
		audience: text().notNull().default('all'),
		departmentId: uuid(),
		branchId: uuid(),
		status: text().$type<(typeof SURVEY_STATUSES)[number]>().notNull().default('draft'),
		closesOn: date({ mode: 'string' }),
		openedAt: tstz(),
		closedAt: tstz(),
		minGroupSize: smallint().notNull().default(5),
		remindersSent: smallint().notNull().default(0),
		releasedBatches: integer().notNull().default(0),
		createdByUserId: uuid()
	},
	(t) => [
		tenantKey('surveys', t),
		unique('surveys_anonymous_uq').on(t.tenantId, t.id, t.anonymous),
		tfk('surveys_department_fk', t, t.departmentId, departments, 'cascade'),
		tfk('surveys_branch_fk', t, t.branchId, branches, 'cascade'),
		uniqueIndex('surveys_suggestion_uq')
			.on(t.tenantId)
			.where(sql`${t.kind} = 'suggestion'`),
		check('surveys_kind_ck', sql`${t.kind} in ('pulse', 'suggestion')`),
		check('surveys_status_ck', sql`${t.status} in ('draft', 'open', 'closed')`),
		check('surveys_title_ck', sql`length(trim(${t.title})) between 1 and 160`),
		check('surveys_intro_ck', sql`length(${t.intro}) <= 2000`),
		check('surveys_min_group_ck', sql`${t.minGroupSize} between 5 and 50`),
		check('surveys_reminders_ck', sql`${t.remindersSent} between 0 and 2`),
		check(
			'surveys_suggestion_ck',
			sql`${t.kind} = 'pulse' or (${t.anonymous} and ${t.audience} = 'all' and ${t.closesOn} is null)`
		),
		check('surveys_closes_ck', sql`${t.kind} = 'suggestion' or ${t.status} = 'draft' or ${t.closesOn} is not null`),
		check(
			'surveys_audience_ck',
			sql`(${t.audience} = 'all' and ${t.departmentId} is null and ${t.branchId} is null) or (${t.audience} = 'department' and ${t.departmentId} is not null and ${t.branchId} is null) or (${t.audience} = 'branch' and ${t.branchId} is not null and ${t.departmentId} is null)`
		)
	]
);

export const surveyQuestions = pgTable(
	'survey_questions',
	{
		...tenantBase(),
		surveyId: uuid().notNull(),
		position: smallint().notNull(),
		kind: text().$type<(typeof QUESTION_KINDS)[number]>().notNull(),
		prompt: text().notNull(),
		options: text()
			.array()
			.notNull()
			.default(sql`'{}'::text[]`),
		required: boolean().notNull().default(true)
	},
	(t) => [
		tenantKey('survey_questions', t),
		unique('survey_questions_survey_uq').on(t.tenantId, t.surveyId, t.id),
		tfk('survey_questions_survey_fk', t, t.surveyId, surveys, 'cascade'),
		uniqueIndex('survey_questions_position_uq').on(t.tenantId, t.surveyId, t.position),
		check('survey_questions_kind_ck', sql`${t.kind} in ('scale', 'enps', 'choice', 'text')`),
		check('survey_questions_prompt_ck', sql`length(trim(${t.prompt})) between 1 and 300`),
		check('survey_questions_position_ck', sql`${t.position} between 0 and 19`),
		check(
			'survey_questions_options_ck',
			sql`(${t.kind} = 'choice' and cardinality(${t.options}) between 2 and 10) or (${t.kind} <> 'choice' and cardinality(${t.options}) = 0)`
		)
	]
);

export const surveyParticipation = pgTable(
	'survey_participation',
	{
		id: uuid().primaryKey().defaultRandom(),
		tenantId: tenantId(),
		surveyId: uuid().notNull(),
		membershipId: uuid().notNull()
	},
	(t) => [
		tenantKey('survey_participation', t),
		tfk('survey_participation_survey_fk', t, t.surveyId, surveys, 'cascade'),
		tfk('survey_participation_membership_fk', t, t.membershipId, memberships, 'cascade'),
		uniqueIndex('survey_participation_member_uq').on(t.tenantId, t.surveyId, t.membershipId)
	]
);

export const surveyAnswers = pgTable(
	'survey_answers',
	{
		id: uuid().primaryKey().defaultRandom(),
		tenantId: tenantId(),
		surveyId: uuid().notNull(),
		anonymous: boolean().notNull(),
		questionId: uuid().notNull(),
		valueNum: smallint(),
		valueText: text(),
		sliceDepartmentId: uuid(),
		sliceBranchId: uuid(),
		membershipId: uuid(),
		batch: integer()
	},
	(t) => [
		tenantKey('survey_answers', t),
		foreignKey({
			name: 'survey_answers_survey_fk',
			columns: [t.tenantId, t.surveyId, t.anonymous],
			foreignColumns: [surveys.tenantId, surveys.id, surveys.anonymous]
		}).onDelete('cascade'),
		foreignKey({
			name: 'survey_answers_question_fk',
			columns: [t.tenantId, t.surveyId, t.questionId],
			foreignColumns: [surveyQuestions.tenantId, surveyQuestions.surveyId, surveyQuestions.id]
		}).onDelete('cascade'),
		tfk('survey_answers_membership_fk', t, t.membershipId, memberships, 'cascade'),
		index('survey_answers_survey_idx').on(t.tenantId, t.surveyId, t.questionId),
		check('survey_answers_person_ck', sql`${t.anonymous} = (${t.membershipId} is null)`),
		check(
			'survey_answers_value_ck',
			sql`(${t.valueNum} is not null) <> (${t.valueText} is not null) and (${t.valueText} is null or length(${t.valueText}) between 1 and 2000)`
		)
	]
);
