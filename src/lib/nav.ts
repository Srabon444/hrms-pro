import type { Permission } from './rbac/permissions';

export type NavItem = { href: string; label: string; perm?: Permission };

export const NAV: NavItem[] = [
	{ href: '', label: 'Home' },
	{ href: 'notifications', label: 'Notifications' },
	{ href: 'approvals', label: 'Approvals' },
	{ href: 'tasks', label: 'Tasks' },
	{ href: 'leave', label: 'Leave', perm: 'leave.request' },
	{ href: 'attendance', label: 'Attendance', perm: 'attendance.read' },
	{ href: 'employees', label: 'Employees', perm: 'employee.read' },
	{ href: 'lifecycle', label: 'Lifecycle', perm: 'employee.update' },
	{ href: 'org', label: 'Organisation', perm: 'org.manage' },
	{ href: 'settings/users', label: 'Users', perm: 'user.manage' },
	{ href: 'settings/roles', label: 'Roles', perm: 'role.manage' },
	{ href: 'settings/checklists', label: 'Checklists', perm: 'settings.manage' },
	{ href: 'settings/leave-types', label: 'Leave types', perm: 'leave.manage' },
	{ href: 'settings/shifts', label: 'Shifts', perm: 'attendance.manage' },
	{ href: 'settings/audit', label: 'Audit log', perm: 'audit.read' },
	{ href: 'settings/organisation', label: 'Settings', perm: 'settings.manage' }
];
