import { sql } from 'drizzle-orm';
import { check, index, pgTable, smallint, text, unique, uniqueIndex, uuid, integer } from 'drizzle-orm/pg-core';
import { citext, tenantBase, tenantKey, tfk } from './_helpers';
import { departments, designations, employees } from './org';

export const OPENING_STATUSES = ['open', 'on_hold', 'closed'] as const;
export const STAGE_KINDS = ['active', 'hired', 'rejected'] as const;
export const CANDIDATE_SOURCES = ['referral', 'job_board', 'website', 'agency', 'walk_in', 'other'] as const;
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
