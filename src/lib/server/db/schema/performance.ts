import { sql } from 'drizzle-orm';
import { boolean, check, date, index, pgTable, smallint, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { tenantBase, tenantKey, tfk, tstz } from './_helpers';
import { employees } from './org';

export const CYCLE_STATUSES = ['open', 'closed'] as const;
export const REVIEW_STAGES = ['self', 'manager', 'hr', 'done'] as const;
export const MAX_GOALS = 10;

export const reviewCycles = pgTable(
	'review_cycles',
	{
		...tenantBase(),
		name: text().notNull(),
		periodStart: date().notNull(),
		periodEnd: date().notNull(),
		status: text().notNull().default('open'),
		createdByUserId: uuid()
	},
	(t) => [
		tenantKey('review_cycles', t),
		unique('review_cycles_name_uq').on(t.tenantId, t.name),
		check('review_cycles_name_ck', sql`length(trim(${t.name})) between 1 and 80`),
		check('review_cycles_period_ck', sql`${t.periodEnd} >= ${t.periodStart}`),
		check('review_cycles_status_ck', sql`${t.status} in ('open','closed')`)
	]
);

export const reviews = pgTable(
	'reviews',
	{
		...tenantBase(),
		cycleId: uuid().notNull(),
		employeeId: uuid().notNull(),
		stage: text().notNull().default('self'),
		selfComments: text().notNull().default(''),
		managerComments: text().notNull().default(''),
		score: smallint(),
		shared: boolean().notNull().default(false),
		selfSubmittedAt: tstz(),
		managerSubmittedAt: tstz(),
		managerUserId: uuid(),
		finalisedAt: tstz(),
		finalisedByUserId: uuid()
	},
	(t) => [
		tenantKey('reviews', t),
		tfk('reviews_cycle_fk', t, t.cycleId, reviewCycles, 'cascade'),
		tfk('reviews_employee_fk', t, t.employeeId, employees, 'cascade'),
		unique('reviews_cycle_employee_uq').on(t.tenantId, t.cycleId, t.employeeId),
		index('reviews_employee_idx').on(t.tenantId, t.employeeId),
		index('reviews_stage_idx').on(t.tenantId, t.stage),
		check('reviews_stage_ck', sql`${t.stage} in ('self','manager','hr','done')`),
		check('reviews_comments_ck', sql`length(${t.selfComments}) <= 4000 and length(${t.managerComments}) <= 4000`),
		check('reviews_score_ck', sql`${t.score} between 100 and 500`),
		check('reviews_self_ck', sql`(${t.stage} = 'self') = (${t.selfSubmittedAt} is null)`),
		check('reviews_manager_ck', sql`(${t.stage} in ('hr','done')) = (${t.managerSubmittedAt} is not null)`),
		check('reviews_score_set_ck', sql`(${t.stage} in ('hr','done')) = (${t.score} is not null)`),
		check('reviews_final_ck', sql`(${t.stage} = 'done') = (${t.finalisedAt} is not null)`),
		check('reviews_shared_ck', sql`not ${t.shared} or ${t.stage} = 'done'`)
	]
);

export const goals = pgTable(
	'goals',
	{
		...tenantBase(),
		reviewId: uuid().notNull(),
		title: text().notNull(),
		target: text().notNull().default(''),
		weight: smallint().notNull(),
		actual: text().notNull().default(''),
		selfRating: smallint(),
		managerRating: smallint()
	},
	(t) => [
		tenantKey('goals', t),
		tfk('goals_review_fk', t, t.reviewId, reviews, 'cascade'),
		index('goals_review_idx').on(t.tenantId, t.reviewId),
		check('goals_title_ck', sql`length(trim(${t.title})) between 1 and 120`),
		check('goals_text_ck', sql`length(${t.target}) <= 200 and length(${t.actual}) <= 200`),
		check('goals_weight_ck', sql`${t.weight} between 1 and 100`),
		check('goals_rating_ck', sql`${t.selfRating} between 1 and 5 and ${t.managerRating} between 1 and 5`)
	]
);

export const WORK_PLAN_STATUSES = ['pending', 'in_progress', 'done'] as const;

export const workPlanItems = pgTable(
	'work_plan_items',
	{
		...tenantBase(),
		employeeId: uuid().notNull(),
		weekStart: date().notNull(),
		description: text().notNull(),
		target: text().notNull().default(''),
		status: text().notNull().default('pending'),
		carriedOverFromId: uuid(),
		createdByUserId: uuid()
	},
	(t) => [
		tenantKey('work_plan_items', t),
		tfk('work_plan_items_employee_fk', t, t.employeeId, employees, 'cascade'),
		index('work_plan_items_week_idx').on(t.tenantId, t.weekStart, t.employeeId),
		uniqueIndex('work_plan_items_carried_uq')
			.on(t.tenantId, t.carriedOverFromId)
			.where(sql`${t.carriedOverFromId} is not null`),
		check('work_plan_items_description_ck', sql`length(trim(${t.description})) between 1 and 300`),
		check('work_plan_items_target_ck', sql`length(${t.target}) <= 120`),
		check('work_plan_items_status_ck', sql`${t.status} in ('pending','in_progress','done')`)
	]
);
