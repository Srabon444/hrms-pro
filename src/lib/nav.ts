import type { Permission } from './rbac/permissions';

export type NavItem = { href: string; label: string; perm?: Permission | Permission[]; self?: true };

export const NAV: NavItem[] = [
	{ href: '', label: 'Home' },
	{ href: 'notifications', label: 'Notifications' },
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
	{ href: 'work-plan', label: 'Work plan', perm: 'report.weekly' },
	{ href: 'org', label: 'Organisation', perm: 'org.manage' },
	{ href: 'settings/users', label: 'Users', perm: 'user.manage' },
	{ href: 'settings/roles', label: 'Roles', perm: 'role.manage' },
	{ href: 'settings/checklists', label: 'Checklists', perm: 'settings.manage' },
	{ href: 'settings/leave-types', label: 'Leave types', perm: 'leave.manage' },
	{ href: 'settings/shifts', label: 'Shifts', perm: 'attendance.manage' },
	{ href: 'settings/meals', label: 'Meal setup', perm: 'meal.manage' },
	{ href: 'settings/payroll', label: 'Payroll settings', perm: 'settings.manage' },
	{ href: 'settings/tax', label: 'Income tax', perm: ['settings.manage', 'payroll.run'] },
	{ href: 'settings/audit', label: 'Audit log', perm: 'audit.read' },
	{ href: 'settings/organisation', label: 'Settings', perm: 'settings.manage' }
];
