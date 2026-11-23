import type { Permission } from './rbac/permissions';

export type NavItem = { href: string; label: string; perm?: Permission };

export const NAV: NavItem[] = [
	{ href: '', label: 'Home' },
	{ href: 'notifications', label: 'Notifications' }
];
