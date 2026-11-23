import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { poishaOf } from '../money';
import { tenantSettings } from './db/schema';
import { AppError } from './errors';
import { advisoryLock, LOCK } from './locks';
import { withTenant, type TenantCtx, type Tx } from './tenancy';

const TIMEZONES = new Set(Intl.supportedValuesOf('timeZone'));
const checkbox = z.preprocess((v) => v === 'on' || v === true, z.boolean());
const days = (min: number, message: string) => z.coerce.number().int().min(min, message).max(3650, message);

export const settingsSchema = z.object({
	legalName: z.string().trim().max(200),
	address: z.string().trim().max(500),
	timezone: z.string().refine((tz) => TIMEZONES.has(tz), 'Pick a valid time zone.'),
	fiscalYearStartMonth: z.coerce.number().int().min(1).max(12),
	weekendDays: z
		.array(z.coerce.number().int().min(0).max(6))
		.max(6, 'At least one working day is needed.')
		.transform((d) => [...new Set(d)].sort()),
	employeeCodePrefix: z
		.string()
		.trim()
		.regex(/^[A-Za-z0-9-]{1,10}$/, 'Use up to 10 letters, digits or dashes.'),
	require2faForSensitive: checkbox,
	allowSingleAdminApproval: checkbox,
	exEmployeeAccessDays: days(0, 'Former employee access must be 0 to 3650 days.'),
	noticePeriodDays: z.coerce
		.number()
		.int()
		.min(0, 'Notice period must be 0 to 365 days.')
		.max(365, 'Notice period must be 0 to 365 days.'),
	retentionAuditDays: days(365, 'Keep audit history for 365 to 3650 days.'),
	overtimeDailyCapMinutes: z.coerce
		.number()
		.int()
		.min(15, 'Daily overtime cap must be 15 to 720 minutes.')
		.max(720, 'Daily overtime cap must be 15 to 720 minutes.'),
	compOffExpiryDays: z.coerce
		.number()
		.int()
		.min(1, 'Compensatory leave must expire after 1 to 365 days.')
		.max(365, 'Compensatory leave must expire after 1 to 365 days.')
});

export type SettingsInput = z.input<typeof settingsSchema>;

export async function readSettings(tx: Tx) {
	const [row] = await tx.select().from(tenantSettings);
	if (!row) throw new AppError('settings_missing', 'Organisation settings are missing.', 500);
	return row;
}

export async function saveSettings(ctx: TenantCtx, isOwner: boolean, raw: SettingsInput): Promise<void> {
	const input = settingsSchema.parse(raw);
	await withTenant(ctx, async (tx) => {
		const current = await readSettings(tx);
		if (input.allowSingleAdminApproval !== current.allowSingleAdminApproval && !isOwner)
			throw new AppError('owner_only', 'Only an owner can change single-admin approval.', 403);
		await tx
			.update(tenantSettings)
			.set({ ...input, legalName: input.legalName || null, address: input.address || null })
			.where(eq(tenantSettings.id, current.id));
	});
}

const percent = (max: number, message: string) =>
	z
		.string()
		.trim()
		.regex(/^\d{1,3}(\.\d{1,2})?$/, message)
		.transform(poishaOf)
		.refine((bp) => bp <= max, message);

export const payrollSettingsSchema = z.object({
	payrollProrationBasis: z.enum(['calendar', 'working'], 'Choose how a part month is paid.'),
	latePolicyCount: z.coerce
		.number()
		.int('Enter a whole number of late days.')
		.min(0, 'Late days per unpaid day must be 0 to 31.')
		.max(31, 'Late days per unpaid day must be 0 to 31.'),
	mealPayrollLagMonths: z.coerce
		.number()
		.int('Enter a whole number of months.')
		.min(0, 'Meal bills are deducted 0 to 3 months later.')
		.max(3, 'Meal bills are deducted 0 to 3 months later.'),
	pfEmployeeRateBp: percent(5000, 'The employee provident fund rate is 0 to 50%, up to 2 decimals.'),
	pfEmployerRateBp: percent(5000, 'The employer provident fund rate is 0 to 50%, up to 2 decimals.'),
	overtimeRateBp: percent(50000, 'The overtime rate is 0 to 500% of the hourly basic, up to 2 decimals.'),
	overtimeMonthlyHours: z.coerce
		.number()
		.int('Enter whole hours.')
		.min(1, 'Hours in a month must be 1 to 744.')
		.max(744, 'Hours in a month must be 1 to 744.'),
	bonusRateBp: percent(50000, 'The festival bonus is 0 to 500% of basic, up to 2 decimals.'),
	bonusMinServiceMonths: z.coerce
		.number()
		.int('Enter whole months.')
		.min(0, 'Months of service for a bonus must be 0 to 120.')
		.max(120, 'Months of service for a bonus must be 0 to 120.')
});

export async function savePayrollSettings(ctx: TenantCtx, raw: Record<string, string>) {
	const input = payrollSettingsSchema.parse(raw);
	await withTenant(ctx, async (tx) => {
		await advisoryLock(tx, LOCK.payroll, ctx.tenantId);
		await tx.update(tenantSettings).set(input);
	});
}
