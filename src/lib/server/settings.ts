import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { CURRENCIES, poishaOf } from '../money';
import { tenantSettings } from './db/schema';
import { rangeMessage, SETTING_SECTIONS, type IntField, type SectionId, type SettingField } from '../settings-sections';
import { AppError } from './errors';
import { advisoryLock, LOCK } from './locks';
import { withTenant, type TenantCtx, type Tx } from './tenancy';

export const TIMEZONES = ['UTC', ...Intl.supportedValuesOf('timeZone')];
const ZONES = new Set(TIMEZONES);
export const timeZoneSchema = z.string().refine((tz) => ZONES.has(tz), 'Pick a valid time zone.');
const checkbox = z.preprocess((v) => v === 'on' || v === true, z.boolean());

export const localeSchema = z.object({
	timezone: timeZoneSchema,
	currency: z.string().refine((c) => Object.hasOwn(CURRENCIES, c), 'Pick a currency from the list.'),
	fiscalYearStartMonth: z.coerce.number().int().min(1, 'Pick a month.').max(12, 'Pick a month.'),
	weekendDays: z
		.array(z.coerce.number().int().min(0).max(6))
		.max(6, 'At least one working day is needed.')
		.transform((d) => [...new Set(d)].sort())
});

export type Locale = z.output<typeof localeSchema>;

export const NEUTRAL_LOCALE: Locale = {
	timezone: 'UTC',
	currency: 'USD',
	fiscalYearStartMonth: 1,
	weekendDays: [0, 6]
};

export const settingsSchema = localeSchema.extend({
	legalName: z.string().trim().max(200),
	address: z.string().trim().max(500),
	employeeCodePrefix: z
		.string()
		.trim()
		.regex(/^[A-Za-z0-9-]{1,10}$/, 'Use up to 10 letters, digits or dashes.')
});

export type SettingsInput = z.input<typeof settingsSchema>;

export async function readSettings(tx: Tx) {
	const [row] = await tx.select().from(tenantSettings);
	if (!row) throw new AppError('settings_missing', 'Organisation settings are missing.', 500);
	return row;
}

export const tenantCurrency = async (tx: Tx) =>
	(await tx.select({ currency: tenantSettings.currency }).from(tenantSettings))[0]?.currency ?? NEUTRAL_LOCALE.currency;

export async function saveSettings(ctx: TenantCtx, raw: SettingsInput): Promise<void> {
	const input = settingsSchema.parse(raw);
	await withTenant(ctx, (tx) =>
		tx.update(tenantSettings).set({ ...input, legalName: input.legalName || null, address: input.address || null })
	);
}

export const intSchema = (f: IntField) =>
	z.preprocess(
		(v) => (v === '' ? undefined : v),
		z.coerce.number(rangeMessage(f)).int(rangeMessage(f)).min(f.min, rangeMessage(f)).max(f.max, rangeMessage(f))
	);

const fieldSchema = (f: SettingField) => (f.kind === 'bool' ? checkbox : intSchema(f));

export const sectionSchema = (id: SectionId) =>
	z.object(Object.fromEntries(SETTING_SECTIONS[id].fields.map((f) => [f.key, fieldSchema(f)])));

export async function saveSection(ctx: TenantCtx, isOwner: boolean, id: SectionId, raw: Record<string, string>) {
	const input = sectionSchema(id).parse(raw) as Partial<typeof tenantSettings.$inferInsert>;
	await withTenant(ctx, async (tx) => {
		const current = await readSettings(tx);
		for (const f of SETTING_SECTIONS[id].fields)
			if ('ownerOnly' in f && !isOwner && input[f.key as keyof typeof input] !== current[f.key as keyof typeof current])
				throw new AppError('owner_only', `Only an owner can change "${f.label}".`, 403);
		await tx.update(tenantSettings).set(input).where(eq(tenantSettings.id, current.id));
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
		.max(120, 'Months of service for a bonus must be 0 to 120.'),
	arrearsLookbackMonths: z.coerce
		.number()
		.int('Enter whole months.')
		.min(1, 'Arrears look back 1 to 24 months.')
		.max(24, 'Arrears look back 1 to 24 months.'),
	gratuityDaysPerYear: z.coerce
		.number()
		.int('Enter whole days.')
		.min(0, 'Gratuity is 0 to 90 days of basic per year.')
		.max(90, 'Gratuity is 0 to 90 days of basic per year.'),
	gratuityMinYears: z.coerce
		.number()
		.int('Enter whole years.')
		.min(0, 'Years before gratuity must be 0 to 40.')
		.max(40, 'Years before gratuity must be 0 to 40.'),
	pfVestingMonths: z.coerce
		.number()
		.int('Enter whole months.')
		.min(0, 'Provident fund vesting must be 0 to 120 months.')
		.max(120, 'Provident fund vesting must be 0 to 120 months.'),
	payslipEmailPdf: checkbox
});

export async function savePayrollSettings(ctx: TenantCtx, raw: Record<string, string>) {
	const input = payrollSettingsSchema.parse(raw);
	await withTenant(ctx, async (tx) => {
		await advisoryLock(tx, LOCK.payroll, ctx.tenantId);
		await tx.update(tenantSettings).set(input);
	});
}
