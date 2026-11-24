import type { Permission } from './rbac/permissions';
import { SETTING_SECTIONS } from './settings-sections';

export type SettingsPage = {
	href: string;
	label: string;
	group: string;
	perm: Permission | Permission[];
	about: string;
};

export const SETTINGS_PAGES: SettingsPage[] = [
	{
		href: 'organisation',
		label: 'General',
		group: 'Organisation',
		perm: 'settings.manage',
		about: 'Name, address, time zone, fiscal year and weekend days.'
	},
	{
		href: 'people',
		label: 'People',
		group: 'Organisation',
		perm: 'settings.manage',
		about: SETTING_SECTIONS.people.intro
	},
	{
		href: 'users',
		label: 'Users',
		group: 'Access',
		perm: 'user.manage',
		about: 'Invite people, set their roles, disable access.'
	},
	{
		href: 'roles',
		label: 'Roles',
		group: 'Access',
		perm: 'role.manage',
		about: 'What each role can see and do, and for whom.'
	},
	{
		href: 'security',
		label: 'Security and retention',
		group: 'Access',
		perm: 'settings.manage',
		about: SETTING_SECTIONS.security.intro
	},
	{ href: 'audit', label: 'Audit log', group: 'Access', perm: 'audit.read', about: 'Who changed what, and when.' },
	{
		href: 'attendance',
		label: 'Attendance rules',
		group: 'Time',
		perm: 'settings.manage',
		about: SETTING_SECTIONS.attendance.intro
	},
	{
		href: 'shifts',
		label: 'Shifts',
		group: 'Time',
		perm: 'attendance.manage',
		about: 'Working hours, late grace and day lengths.'
	},
	{
		href: 'leave-types',
		label: 'Leave types',
		group: 'Time',
		perm: 'leave.manage',
		about: 'Quotas, accrual, carry-over and notice rules.'
	},
	{
		href: 'payroll',
		label: 'Payroll settings',
		group: 'Money',
		perm: 'settings.manage',
		about: 'Part months, provident fund, overtime, bonus and gratuity.'
	},
	{
		href: 'tax',
		label: 'Income tax',
		group: 'Money',
		perm: ['settings.manage', 'payroll.run'],
		about: 'Tax years, rules, rebates and employee tax profiles.'
	},
	{ href: 'loans', label: 'Loan rules', group: 'Money', perm: 'settings.manage', about: SETTING_SECTIONS.loans.intro },
	{
		href: 'meals',
		label: 'Meal setup',
		group: 'Money',
		perm: 'meal.manage',
		about: 'Vendors, meal types, prices and ordering rules.'
	},
	{
		href: 'checklists',
		label: 'Checklists',
		group: 'Workflows',
		perm: 'settings.manage',
		about: 'Onboarding and exit task lists.'
	},
	{
		href: 'helpdesk',
		label: 'Helpdesk setup',
		group: 'Workflows',
		perm: 'helpdesk.manage',
		about: 'Ticket categories, response times and confidentiality.'
	},
	{
		href: 'letters',
		label: 'Letter templates',
		group: 'Workflows',
		perm: 'letter.issue',
		about: 'Wording of offer, appointment and other letters.'
	},
	{
		href: 'reports',
		label: 'Report sharing',
		group: 'Workflows',
		perm: 'settings.manage',
		about: SETTING_SECTIONS.reports.intro
	}
];

export type NavItem = { href: string; label: string; perm?: Permission | Permission[]; self?: true; active?: true };

export const NAV: NavItem[] = [
	{ href: '', label: 'Home' },
	{ href: 'notifications', label: 'Notifications' },
	{ href: 'announcements', label: 'Announcements', active: true },
	{ href: 'policies', label: 'Policies', active: true },
	{ href: 'letters', label: 'Letters' },
	{
		href: 'reports',
		label: 'Reports',
		perm: [
			'report.headcount',
			'report.attendance',
			'report.leave',
			'report.payroll',
			'report.meal',
			'report.expense',
			'report.recruitment',
			'report.utilisation',
			'report.weekly'
		]
	},
	{ href: 'approvals', label: 'Approvals' },
	{ href: 'tasks', label: 'Tasks' },
	{ href: 'leave', label: 'Leave', perm: 'leave.request' },
	{ href: 'attendance', label: 'Attendance', perm: 'attendance.read' },
	{ href: 'meals', label: 'Meals', perm: 'meal.order' },
	{ href: 'payslips', label: 'My payslips', self: true },
	{ href: 'meals/bills', label: 'Meal bills', perm: 'meal.billing' },
	{ href: 'employees', label: 'Employees', perm: 'employee.read' },
	{ href: 'expenses', label: 'Expenses', perm: ['expense.submit', 'expense.approve', 'expense.pay'] },
	{ href: 'loans', label: 'Loans', perm: ['loan.request', 'loan.approve'] },
	{ href: 'payroll', label: 'Payroll', perm: ['payroll.run', 'payroll.approve'] },
	{ href: 'payroll/salaries', label: 'Salaries', perm: 'salary.read' },
	{ href: 'lifecycle', label: 'Lifecycle', perm: 'employee.update' },
	{ href: 'recruitment', label: 'Recruitment', perm: 'recruitment.read' },
	{ href: 'recruitment/interviews', label: 'My interviews', perm: 'interview.feedback' },
	{ href: 'performance', label: 'Performance', perm: 'performance.read' },
	{ href: 'projects', label: 'Projects', perm: 'project.read' },
	{ href: 'timesheets', label: 'Timesheets', perm: ['timesheet.submit', 'timesheet.approve'] },
	{ href: 'assets', label: 'Assets', perm: 'asset.read' },
	{ href: 'helpdesk', label: 'Helpdesk', perm: ['helpdesk.submit', 'helpdesk.manage', 'helpdesk.confidential'] },
	{ href: 'work-plan', label: 'Work plan', perm: 'workplan.edit' },
	{ href: 'org', label: 'Organisation', perm: 'org.manage' },
	{ href: 'settings', label: 'Settings', perm: [...new Set(SETTINGS_PAGES.flatMap((p) => [p.perm].flat()))] }
];
