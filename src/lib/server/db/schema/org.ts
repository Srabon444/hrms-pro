import { sql } from 'drizzle-orm';
import {
	boolean,
	check,
	date,
	index,
	integer,
	jsonb,
	pgTable,
	smallint,
	text,
	unique,
	uniqueIndex,
	uuid,
	type PgTableExtraConfigValue
} from 'drizzle-orm/pg-core';
import { citext, tenantBase, tenantKey, tfk, tstz } from './_helpers';

const nameCheck = (table: string, col: unknown) =>
	check(`${table}_name_ck`, sql`length(trim(${col})) between 1 and 120`);

export const branches = pgTable(
	'branches',
	{ ...tenantBase(), name: text().notNull(), address: text(), timezone: text() },
	(t) => [tenantKey('branches', t), unique('branches_name_uq').on(t.tenantId, t.name), nameCheck('branches', t.name)]
);

export const departments = pgTable(
	'departments',
	{ ...tenantBase(), name: text().notNull(), parentId: uuid(), headEmployeeId: uuid() },
	(t): PgTableExtraConfigValue[] => [
		tenantKey('departments', t),
		tfk('departments_head_fk', t, t.headEmployeeId, employees, 'restrict'),
		unique('departments_name_uq').on(t.tenantId, t.name),
		tfk('departments_parent_fk', t, t.parentId, t, 'restrict'),
		index('departments_parent_idx').on(t.tenantId, t.parentId),
		check('departments_not_own_parent_ck', sql`${t.parentId} is distinct from ${t.id}`),
		nameCheck('departments', t.name)
	]
);

export const designations = pgTable('designations', { ...tenantBase(), name: text().notNull() }, (t) => [
	tenantKey('designations', t),
	unique('designations_name_uq').on(t.tenantId, t.name),
	nameCheck('designations', t.name)
]);

export const grades = pgTable(
	'grades',
	{ ...tenantBase(), name: text().notNull(), rank: smallint().notNull().default(0) },
	(t) => [tenantKey('grades', t), unique('grades_name_uq').on(t.tenantId, t.name), nameCheck('grades', t.name)]
);

export const holidays = pgTable(
	'holidays',
	{ ...tenantBase(), date: date({ mode: 'string' }).notNull(), name: text().notNull() },
	(t) => [tenantKey('holidays', t), unique('holidays_date_uq').on(t.tenantId, t.date), nameCheck('holidays', t.name)]
);

export const EMPLOYEE_STATUSES = ['onboarding', 'probation', 'active', 'notice', 'exited'] as const;
export const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'intern'] as const;
export const GENDERS = ['female', 'male', 'other', 'undisclosed'] as const;
export const EXIT_TYPES = ['resignation', 'termination', 'retirement', 'contract_end', 'other'] as const;

const inList = (col: unknown, values: readonly string[]) =>
	sql`${col} in (${sql.raw(values.map((v) => `'${v}'`).join(','))})`;

export const employees = pgTable(
	'employees',
	{
		...tenantBase(),
		code: text().notNull(),
		fullName: text().notNull(),
		workEmail: citext(),
		personalEmail: citext(),
		phone: text(),
		dateOfBirth: date({ mode: 'string' }),
		gender: text(),
		bloodGroup: text(),
		presentAddress: text(),
		permanentAddress: text(),
		nationalId: text(),
		passportNumber: text(),
		taxId: text(),
		bankName: text(),
		bankAccountName: text(),
		bankAccountNumber: text(),
		departmentId: uuid(),
		designationId: uuid(),
		gradeId: uuid(),
		branchId: uuid(),
		managerId: uuid(),
		employmentType: text().notNull().default('full_time'),
		joinDate: date({ mode: 'string' }).notNull(),
		probationEndDate: date({ mode: 'string' }),
		confirmationDate: date({ mode: 'string' }),
		status: text().notNull().default('onboarding'),
		exitDate: date({ mode: 'string' }),
		exitReason: text(),
		exitType: text()
	},
	(t): PgTableExtraConfigValue[] => [
		tenantKey('employees', t),
		unique('employees_code_uq').on(t.tenantId, t.code),
		unique('employees_work_email_uq').on(t.tenantId, t.workEmail),
		tfk('employees_department_fk', t, t.departmentId, departments, 'restrict'),
		tfk('employees_designation_fk', t, t.designationId, designations, 'restrict'),
		tfk('employees_grade_fk', t, t.gradeId, grades, 'restrict'),
		tfk('employees_branch_fk', t, t.branchId, branches, 'restrict'),
		tfk('employees_manager_fk', t, t.managerId, t, 'restrict'),
		index('employees_department_idx').on(t.tenantId, t.departmentId),
		index('employees_manager_idx').on(t.tenantId, t.managerId),
		index('employees_status_idx').on(t.tenantId, t.status),
		check('employees_name_ck', sql`length(trim(${t.fullName})) between 1 and 160`),
		check('employees_not_own_manager_ck', sql`${t.managerId} is distinct from ${t.id}`),
		check('employees_status_ck', inList(t.status, EMPLOYEE_STATUSES)),
		check('employees_type_ck', inList(t.employmentType, EMPLOYMENT_TYPES)),
		check('employees_gender_ck', sql`${t.gender} is null or ${inList(t.gender, GENDERS)}`),
		check('employees_exit_ck', sql`${t.exitDate} is null or ${t.exitDate} >= ${t.joinDate}`),
		check('employees_exit_type_ck', sql`${t.exitType} is null or ${inList(t.exitType, EXIT_TYPES)}`)
	]
);

export const employeeHistory = pgTable(
	'employee_history',
	{
		...tenantBase(),
		employeeId: uuid().notNull(),
		field: text().notNull(),
		oldValue: text(),
		newValue: text(),
		changedByUserId: uuid()
	},
	(t) => [
		tenantKey('employee_history', t),
		tfk('employee_history_employee_fk', t, t.employeeId, employees, 'cascade'),
		index('employee_history_employee_idx').on(t.tenantId, t.employeeId, t.createdAt)
	]
);

export const DOCUMENT_CATEGORIES = ['identity', 'contract', 'certificate', 'letter', 'other'] as const;
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

export const employeeDocuments = pgTable(
	'employee_documents',
	{
		...tenantBase(),
		employeeId: uuid().notNull(),
		category: text().notNull(),
		title: text().notNull(),
		fileName: text().notNull(),
		contentType: text().notNull(),
		sizeBytes: integer().notNull(),
		sha256: text().notNull(),
		storageKey: text().notNull(),
		expiresOn: date(),
		uploadedByUserId: uuid()
	},
	(t) => [
		tenantKey('employee_documents', t),
		tfk('employee_documents_employee_fk', t, t.employeeId, employees, 'restrict'),
		unique('employee_documents_key_uq').on(t.storageKey),
		index('employee_documents_employee_idx').on(t.tenantId, t.employeeId),
		check(
			'employee_documents_category_ck',
			sql`${t.category} in ('identity','contract','certificate','letter','other')`
		),
		check('employee_documents_title_ck', sql`length(trim(${t.title})) between 1 and 160`),
		check('employee_documents_size_ck', sql`${t.sizeBytes} between 1 and ${sql.raw(String(MAX_DOCUMENT_BYTES))}`)
	]
);

const textCheck = (name: string, col: unknown, max: number) =>
	check(name, sql`length(trim(${col})) between 1 and ${sql.raw(String(max))}`);

export const employeeContacts = pgTable(
	'employee_contacts',
	{
		...tenantBase(),
		employeeId: uuid().notNull(),
		name: text().notNull(),
		relation: text().notNull(),
		phone: text().notNull()
	},
	(t) => [
		tenantKey('employee_contacts', t),
		tfk('employee_contacts_employee_fk', t, t.employeeId, employees, 'cascade'),
		index('employee_contacts_employee_idx').on(t.tenantId, t.employeeId),
		textCheck('employee_contacts_name_ck', t.name, 160),
		textCheck('employee_contacts_relation_ck', t.relation, 60),
		textCheck('employee_contacts_phone_ck', t.phone, 30)
	]
);

export const employeeEducation = pgTable(
	'employee_education',
	{
		...tenantBase(),
		employeeId: uuid().notNull(),
		degree: text().notNull(),
		institution: text().notNull(),
		passingYear: smallint()
	},
	(t) => [
		tenantKey('employee_education', t),
		tfk('employee_education_employee_fk', t, t.employeeId, employees, 'cascade'),
		index('employee_education_employee_idx').on(t.tenantId, t.employeeId),
		textCheck('employee_education_degree_ck', t.degree, 160),
		textCheck('employee_education_institution_ck', t.institution, 160),
		check('employee_education_year_ck', sql`${t.passingYear} between 1950 and 2100`)
	]
);

export const employeeExperience = pgTable(
	'employee_experience',
	{
		...tenantBase(),
		employeeId: uuid().notNull(),
		company: text().notNull(),
		title: text().notNull(),
		startDate: date().notNull(),
		endDate: date()
	},
	(t) => [
		tenantKey('employee_experience', t),
		tfk('employee_experience_employee_fk', t, t.employeeId, employees, 'cascade'),
		index('employee_experience_employee_idx').on(t.tenantId, t.employeeId),
		textCheck('employee_experience_company_ck', t.company, 160),
		textCheck('employee_experience_title_ck', t.title, 160),
		check('employee_experience_dates_ck', sql`${t.endDate} is null or ${t.endDate} >= ${t.startDate}`)
	]
);

export const CHANGE_REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;

export const changeRequests = pgTable(
	'change_requests',
	{
		...tenantBase(),
		employeeId: uuid().notNull(),
		requestedByUserId: uuid().notNull(),
		changes: jsonb().$type<Record<string, string | null>>().notNull(),
		status: text().notNull().default('pending'),
		decidedByUserId: uuid(),
		decidedAt: tstz(),
		decisionNote: text()
	},
	(t) => [
		tenantKey('change_requests', t),
		tfk('change_requests_employee_fk', t, t.employeeId, employees, 'restrict'),
		uniqueIndex('change_requests_one_pending_uq')
			.on(t.tenantId, t.employeeId)
			.where(sql`${t.status} = 'pending'`),
		index('change_requests_status_idx').on(t.tenantId, t.status),
		check('change_requests_status_ck', inList(t.status, CHANGE_REQUEST_STATUSES)),
		check('change_requests_note_ck', sql`${t.decisionNote} is null or length(${t.decisionNote}) <= 500`)
	]
);

export const RESIGNATION_STATUSES = ['pending_manager', 'pending_hr', 'approved', 'rejected', 'withdrawn'] as const;

export const resignations = pgTable(
	'resignations',
	{
		...tenantBase(),
		employeeId: uuid().notNull(),
		requestedByUserId: uuid().notNull(),
		submittedOn: date({ mode: 'string' }).notNull(),
		noticeDays: integer().notNull(),
		requestedLastDay: date({ mode: 'string' }).notNull(),
		reason: text().notNull(),
		status: text().notNull(),
		managerUserId: uuid(),
		managerAt: tstz(),
		managerNote: text(),
		decidedByUserId: uuid(),
		decidedAt: tstz(),
		decisionNote: text(),
		approvedLastDay: date({ mode: 'string' })
	},
	(t) => [
		tenantKey('resignations', t),
		tfk('resignations_employee_fk', t, t.employeeId, employees, 'restrict'),
		uniqueIndex('resignations_one_open_uq')
			.on(t.tenantId, t.employeeId)
			.where(sql`${t.status} in ('pending_manager','pending_hr')`),
		index('resignations_status_idx').on(t.tenantId, t.status),
		check('resignations_status_ck', inList(t.status, RESIGNATION_STATUSES)),
		check('resignations_reason_ck', sql`length(${t.reason}) between 1 and 500`),
		check(
			'resignations_notes_ck',
			sql`coalesce(length(${t.managerNote}), 0) <= 500 and coalesce(length(${t.decisionNote}), 0) <= 500`
		),
		check('resignations_last_day_ck', sql`${t.requestedLastDay} >= ${t.submittedOn}`)
	]
);

export const EXIT_REASONS = [
	'compensation',
	'growth',
	'management',
	'work_life',
	'relocation',
	'studies',
	'health',
	'other'
] as const;

export const exitInterviews = pgTable(
	'exit_interviews',
	{
		...tenantBase(),
		employeeId: uuid().notNull(),
		exitDate: date({ mode: 'string' }).notNull(),
		primaryReason: text().notNull(),
		rating: smallint().notNull(),
		wouldRecommend: boolean().notNull(),
		wouldRejoin: boolean().notNull(),
		comments: text(),
		submittedByUserId: uuid().notNull()
	},
	(t) => [
		tenantKey('exit_interviews', t),
		tfk('exit_interviews_employee_fk', t, t.employeeId, employees, 'restrict'),
		unique('exit_interviews_one_uq').on(t.tenantId, t.employeeId, t.exitDate),
		check('exit_interviews_reason_ck', inList(t.primaryReason, EXIT_REASONS)),
		check('exit_interviews_rating_ck', sql`${t.rating} between 1 and 5`),
		check('exit_interviews_comments_ck', sql`${t.comments} is null or length(${t.comments}) <= 2000`)
	]
);

export const CHECKLIST_KINDS = ['onboarding', 'offboarding'] as const;

export const checklistTemplates = pgTable(
	'checklist_templates',
	{
		...tenantBase(),
		kind: text().notNull(),
		name: text().notNull(),
		active: boolean().notNull().default(true)
	},
	(t) => [
		tenantKey('checklist_templates', t),
		unique('checklist_templates_name_uq').on(t.tenantId, t.kind, t.name),
		check('checklist_templates_kind_ck', inList(t.kind, CHECKLIST_KINDS)),
		check('checklist_templates_name_ck', sql`length(${t.name}) between 1 and 120`)
	]
);

export const checklistTemplateItems = pgTable(
	'checklist_template_items',
	{
		...tenantBase(),
		templateId: uuid().notNull(),
		title: text().notNull(),
		assigneeRole: text().notNull(),
		dueOffsetDays: smallint().notNull()
	},
	(t) => [
		tenantKey('checklist_template_items', t),
		tfk('checklist_template_items_template_fk', t, t.templateId, checklistTemplates, 'cascade'),
		index('checklist_template_items_template_idx').on(t.tenantId, t.templateId),
		check('checklist_template_items_title_ck', sql`length(${t.title}) between 1 and 200`),
		check('checklist_template_items_offset_ck', sql`${t.dueOffsetDays} between -90 and 365`)
	]
);

export const checklists = pgTable(
	'checklists',
	{
		...tenantBase(),
		employeeId: uuid().notNull(),
		templateId: uuid().notNull(),
		kind: text().notNull(),
		name: text().notNull(),
		anchorDate: date({ mode: 'string' }).notNull()
	},
	(t) => [
		tenantKey('checklists', t),
		tfk('checklists_employee_fk', t, t.employeeId, employees, 'restrict'),
		tfk('checklists_template_fk', t, t.templateId, checklistTemplates, 'restrict'),
		unique('checklists_once_uq').on(t.tenantId, t.employeeId, t.templateId, t.anchorDate),
		check('checklists_kind_ck', inList(t.kind, CHECKLIST_KINDS))
	]
);

export const checklistItems = pgTable(
	'checklist_items',
	{
		...tenantBase(),
		checklistId: uuid().notNull(),
		title: text().notNull(),
		assigneeRole: text().notNull(),
		dueDate: date({ mode: 'string' }).notNull(),
		doneAt: tstz(),
		doneByUserId: uuid()
	},
	(t) => [
		tenantKey('checklist_items', t),
		tfk('checklist_items_checklist_fk', t, t.checklistId, checklists, 'cascade'),
		index('checklist_items_checklist_idx').on(t.tenantId, t.checklistId),
		index('checklist_items_open_idx')
			.on(t.tenantId, t.assigneeRole, t.dueDate)
			.where(sql`${t.doneAt} is null`)
	]
);
