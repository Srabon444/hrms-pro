export type IntField = {
	key: string;
	label: string;
	help: string;
	kind: 'int';
	min: number;
	max: number;
	unit: string;
};
export type BoolField = { key: string; label: string; help: string; kind: 'bool'; ownerOnly?: true };
export type SettingField = IntField | BoolField;
export type SettingSection = { title: string; intro: string; fields: readonly SettingField[] };

const int = (key: string, label: string, min: number, max: number, unit: string, help: string): IntField => ({
	key,
	label,
	help,
	kind: 'int',
	min,
	max,
	unit
});

export const LIMITS = {
	noticePeriodDays: int(
		'noticePeriodDays',
		'Resignation notice period',
		0,
		365,
		'days',
		'Default notice an employee serves after resigning.'
	),
	exEmployeeAccessDays: int(
		'exEmployeeAccessDays',
		'Former employee access',
		0,
		3650,
		'days',
		'How long people who left can still sign in after their last day.'
	),
	probationAlertDays: int(
		'probationAlertDays',
		'Probation ending alert',
		1,
		180,
		'days',
		'Lifecycle lists probations that end within this many days.'
	),
	documentExpiryAlertDays: int(
		'documentExpiryAlertDays',
		'Document expiry alert',
		1,
		180,
		'days',
		'The dashboard flags documents expiring within this many days, and those expired as long ago.'
	),
	overtimeDailyCapMinutes: int(
		'overtimeDailyCapMinutes',
		'Overtime cap per working day',
		15,
		720,
		'minutes',
		'Overtime above this on one day is not counted.'
	),
	compOffExpiryDays: int(
		'compOffExpiryDays',
		'Compensatory leave expires after',
		1,
		365,
		'days',
		'Leave earned by working on a day off lapses after this.'
	),
	invitationValidDays: int(
		'invitationValidDays',
		'Invitation link valid for',
		1,
		30,
		'days',
		'New invitations stop working after this.'
	),
	retentionAuditDays: int(
		'retentionAuditDays',
		'Keep audit history',
		365,
		3650,
		'days',
		'Older audit entries are deleted.'
	),
	referralQualifyDays: int(
		'referralQualifyDays',
		'Referral bonus qualifying period',
		1,
		730,
		'days',
		'A referral bonus becomes due this long after the hire starts, if they are still employed.'
	),
	retentionCandidatesDays: int(
		'retentionCandidatesDays',
		'Keep rejected candidates',
		30,
		3650,
		'days',
		'Personal data of rejected candidates is erased after this.'
	),
	loanMaxInstalments: int(
		'loanMaxInstalments',
		'Most instalments for a loan',
		1,
		60,
		'months',
		'Employees cannot ask to repay over more months than this.'
	),
	reportShareDays: int(
		'reportShareDays',
		'Shared report link valid for',
		1,
		90,
		'days',
		'People you share a report with can open it for this long.'
	),
	upcomingHireDays: int(
		'upcomingHireDays',
		'Upcoming joiners in the weekly report',
		0,
		90,
		'days',
		'The weekly report lists people joining within this many days after the week.'
	),
	mealOrderDaysAhead: int(
		'mealOrderDaysAhead',
		'Meal plan days shown ahead',
		1,
		60,
		'days',
		"Employees' meal plan shows this many days ahead."
	)
} as const;

export const SETTING_SECTIONS = {
	people: {
		title: 'People',
		intro: 'Notice, former employee access and lifecycle alerts.',
		fields: [
			LIMITS.noticePeriodDays,
			LIMITS.exEmployeeAccessDays,
			LIMITS.probationAlertDays,
			LIMITS.documentExpiryAlertDays,
			LIMITS.referralQualifyDays
		]
	},
	attendance: {
		title: 'Attendance',
		intro: 'Overtime and compensatory leave rules.',
		fields: [LIMITS.overtimeDailyCapMinutes, LIMITS.compOffExpiryDays]
	},
	security: {
		title: 'Security',
		intro: 'Sign-in rules, invitations and data retention.',
		fields: [
			{
				key: 'require2faForSensitive',
				label: 'Require two-step sign-in for members with sensitive permissions',
				help: 'Members with payroll, salary, audit, user, role or settings access must set up an authenticator.',
				kind: 'bool'
			},
			{
				key: 'allowSingleAdminApproval',
				label: 'Let one admin both request and approve (small teams only)',
				help: 'Only an owner can change this.',
				kind: 'bool',
				ownerOnly: true
			},
			LIMITS.invitationValidDays,
			LIMITS.retentionAuditDays,
			LIMITS.retentionCandidatesDays
		]
	},
	loans: {
		title: 'Loans',
		intro: 'Limits on loans and salary advances.',
		fields: [LIMITS.loanMaxInstalments]
	},
	reports: {
		title: 'Reports',
		intro: 'Sharing and the weekly report.',
		fields: [LIMITS.reportShareDays, LIMITS.upcomingHireDays]
	}
} as const satisfies Record<string, SettingSection>;

export type SectionId = keyof typeof SETTING_SECTIONS;

export const rangeMessage = (f: IntField) => `${f.label}: enter ${f.min} to ${f.max} ${f.unit}.`;
