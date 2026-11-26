import { sql } from 'drizzle-orm';
import { check, date, index, integer, pgTable, smallint, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { citext, tfk, tenantBase, tenantKey, trigramIndex, tstz } from './_helpers';
import { memberships } from './core';
import { departments, designations, employees } from './org';

export const OPENING_STATUSES = ['open', 'on_hold', 'closed'] as const;
export const STAGE_KINDS = ['active', 'hired', 'rejected'] as const;
export const CANDIDATE_SOURCES = ['referral', 'job_board', 'website', 'agency', 'walk_in', 'other'] as const;
export const RECOMMENDATIONS = ['strong_no', 'no', 'yes', 'strong_yes'] as const;
export const OFFER_DECISIONS = ['accepted', 'declined', 'withdrawn'] as const;
export const DEFAULT_STAGES: { name: string; kind: (typeof STAGE_KINDS)[number] }[] = [
	{ name: 'Applied', kind: 'active' },
	{ name: 'Screening', kind: 'active' },
	{ name: 'Interview', kind: 'active' },
	{ name: 'Offer', kind: 'active' },
	{ name: 'Hired', kind: 'hired' },
	{ name: 'Rejected', kind: 'rejected' }
];

export const jobOpenings = pgTable(
	'job_openings',
	{
		...tenantBase(),
		title: text().notNull(),
		departmentId: uuid(),
		designationId: uuid(),
		headcount: smallint().notNull().default(1),
		status: text().notNull().default('open'),
		description: text().notNull().default(''),
		createdByUserId: uuid()
	},
	(t) => [
		tenantKey('job_openings', t),
		tfk('job_openings_department_fk', t, t.departmentId, departments, 'restrict'),
		tfk('job_openings_designation_fk', t, t.designationId, designations, 'restrict'),
		index('job_openings_status_idx').on(t.tenantId, t.status),
		check('job_openings_title_ck', sql`length(trim(${t.title})) between 1 and 120`),
		check('job_openings_headcount_ck', sql`${t.headcount} between 1 and 500`),
		check('job_openings_status_ck', sql`${t.status} in ('open','on_hold','closed')`),
		check('job_openings_description_ck', sql`length(${t.description}) <= 5000`)
	]
);

export const pipelineStages = pgTable(
	'pipeline_stages',
	{
		...tenantBase(),
		openingId: uuid().notNull(),
		name: text().notNull(),
		sortOrder: smallint().notNull(),
		kind: text().notNull().default('active')
	},
	(t) => [
		tenantKey('pipeline_stages', t),
		tfk('pipeline_stages_opening_fk', t, t.openingId, jobOpenings, 'cascade'),
		unique('pipeline_stages_name_uq').on(t.tenantId, t.openingId, t.name),
		unique('pipeline_stages_order_uq').on(t.tenantId, t.openingId, t.sortOrder),
		check('pipeline_stages_name_ck', sql`length(trim(${t.name})) between 1 and 40`),
		check('pipeline_stages_kind_ck', sql`${t.kind} in ('active','hired','rejected')`)
	]
);

export const candidates = pgTable(
	'candidates',
	{
		...tenantBase(),
		openingId: uuid().notNull(),
		stageId: uuid().notNull(),
		fullName: text().notNull(),
		email: citext(),
		phone: text(),
		source: text().notNull().default('other'),
		tags: text()
			.array()
			.notNull()
			.default(sql`'{}'::text[]`),
		notes: text().notNull().default(''),
		resumeKey: text(),
		resumeName: text(),
		resumeType: text(),
		resumeSize: integer(),
		employeeId: uuid(),
		createdByUserId: uuid()
	},
	(t) => [
		tenantKey('candidates', t),
		tfk('candidates_opening_fk', t, t.openingId, jobOpenings, 'restrict'),
		tfk('candidates_stage_fk', t, t.stageId, pipelineStages, 'restrict'),
		tfk('candidates_employee_fk', t, t.employeeId, employees, 'restrict'),
		index('candidates_opening_idx').on(t.tenantId, t.openingId, t.stageId),
		trigramIndex('candidates_search_idx', t, t.fullName, t.email),
		uniqueIndex('candidates_email_uq')
			.on(t.tenantId, t.openingId, t.email)
			.where(sql`${t.email} is not null`),
		uniqueIndex('candidates_employee_uq')
			.on(t.tenantId, t.employeeId)
			.where(sql`${t.employeeId} is not null`),
		check('candidates_name_ck', sql`length(trim(${t.fullName})) between 1 and 120`),
		check('candidates_phone_ck', sql`${t.phone} is null or length(${t.phone}) <= 40`),
		check('candidates_source_ck', sql`${t.source} in ('referral','job_board','website','agency','walk_in','other')`),
		check('candidates_tags_ck', sql`cardinality(${t.tags}) <= 10`),
		check('candidates_notes_ck', sql`length(${t.notes}) <= 2000`),
		check(
			'candidates_resume_ck',
			sql`(${t.resumeKey} is null) = (${t.resumeName} is null) and (${t.resumeKey} is null) = (${t.resumeSize} is null)`
		)
	]
);

export const candidateStageHistory = pgTable(
	'candidate_stage_history',
	{
		...tenantBase(),
		candidateId: uuid().notNull(),
		fromStageId: uuid(),
		toStageId: uuid().notNull(),
		movedByUserId: uuid(),
		note: text().notNull().default('')
	},
	(t) => [
		tenantKey('candidate_stage_history', t),
		tfk('candidate_stage_history_candidate_fk', t, t.candidateId, candidates, 'cascade'),
		tfk('candidate_stage_history_from_fk', t, t.fromStageId, pipelineStages, 'restrict'),
		tfk('candidate_stage_history_to_fk', t, t.toStageId, pipelineStages, 'restrict'),
		index('candidate_stage_history_candidate_idx').on(t.tenantId, t.candidateId),
		check('candidate_stage_history_note_ck', sql`length(${t.note}) <= 300`)
	]
);

export const interviews = pgTable(
	'interviews',
	{
		...tenantBase(),
		candidateId: uuid().notNull(),
		title: text().notNull(),
		scheduledAt: tstz().notNull(),
		durationMinutes: smallint().notNull(),
		location: text().notNull().default(''),
		status: text().notNull().default('scheduled'),
		createdByUserId: uuid()
	},
	(t) => [
		tenantKey('interviews', t),
		tfk('interviews_candidate_fk', t, t.candidateId, candidates, 'cascade'),
		index('interviews_candidate_idx').on(t.tenantId, t.candidateId),
		check('interviews_title_ck', sql`length(trim(${t.title})) between 1 and 80`),
		check('interviews_duration_ck', sql`${t.durationMinutes} between 15 and 480`),
		check('interviews_location_ck', sql`length(${t.location}) <= 300`),
		check('interviews_status_ck', sql`${t.status} in ('scheduled','cancelled')`)
	]
);

export const interviewFeedback = pgTable(
	'interview_feedback',
	{
		...tenantBase(),
		interviewId: uuid().notNull(),
		membershipId: uuid().notNull(),
		rating: smallint(),
		recommendation: text(),
		comments: text().notNull().default(''),
		submittedAt: tstz()
	},
	(t) => [
		tenantKey('interview_feedback', t),
		tfk('interview_feedback_interview_fk', t, t.interviewId, interviews, 'cascade'),
		tfk('interview_feedback_membership_fk', t, t.membershipId, memberships, 'cascade'),
		unique('interview_feedback_uq').on(t.tenantId, t.interviewId, t.membershipId),
		index('interview_feedback_member_idx').on(t.tenantId, t.membershipId),
		check('interview_feedback_rating_ck', sql`${t.rating} is null or ${t.rating} between 1 and 5`),
		check(
			'interview_feedback_recommendation_ck',
			sql`${t.recommendation} is null or ${t.recommendation} in ('strong_no','no','yes','strong_yes')`
		),
		check('interview_feedback_comments_ck', sql`length(${t.comments}) <= 2000`),
		check(
			'interview_feedback_submitted_ck',
			sql`(${t.submittedAt} is null) = (${t.rating} is null) and (${t.submittedAt} is null) = (${t.recommendation} is null)`
		)
	]
);

export const offers = pgTable(
	'offers',
	{
		...tenantBase(),
		candidateId: uuid().notNull(),
		monthlyGross: integer().notNull(),
		joinDate: date().notNull(),
		expiresOn: date(),
		status: text().notNull().default('pending'),
		note: text().notNull().default(''),
		createdByUserId: uuid(),
		decidedAt: tstz()
	},
	(t) => [
		tenantKey('offers', t),
		tfk('offers_candidate_fk', t, t.candidateId, candidates, 'cascade'),
		uniqueIndex('offers_live_uq')
			.on(t.tenantId, t.candidateId)
			.where(sql`${t.status} in ('pending','accepted')`),
		check('offers_gross_ck', sql`${t.monthlyGross} > 0`),
		check('offers_status_ck', sql`${t.status} in ('pending','accepted','declined','withdrawn')`),
		check('offers_note_ck', sql`length(${t.note}) <= 500`),
		check('offers_expiry_ck', sql`${t.expiresOn} is null or ${t.expiresOn} <= ${t.joinDate}`),
		check('offers_decided_ck', sql`(${t.status} = 'pending') = (${t.decidedAt} is null)`)
	]
);
