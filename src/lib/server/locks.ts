import { sql } from 'drizzle-orm';
import type { Tx } from './tenancy';

export const LOCK = {
	payroll: 1,
	mealBilling: 2,
	leaveBalance: 3,
	attendance: 5,
	orgTree: 6,
	helpdesk: 7,
	letters: 8,
	calendarFeed: 9
} as const;

export const advisoryLock = (tx: Tx, ns: (typeof LOCK)[keyof typeof LOCK], key: string) =>
	tx.execute(sql`select pg_advisory_xact_lock(${ns}, hashtext(${key}))`);
