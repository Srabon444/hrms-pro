import { asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { poishaOf } from '../money';
import { pgCode, UNIQUE_VIOLATION } from './db/errors';
import { MEAL_BILLING_MODES, MEAL_MODES, mealTypePrices, mealTypes, mealVendors, tenantSettings } from './db/schema';
import { AppError } from './errors';
import { LIMITS } from '../settings-sections';
import { tenantToday } from './lifecycle';
import { intSchema } from './settings';
import { withTenant, type TenantCtx, type Tx } from './tenancy';

const checkbox = z.preprocess((v) => v === 'on' || v === true, z.boolean());
const id = (message: string) => z.uuid({ error: message });

const vendorSchema = z.object({
	name: z.string().trim().min(1, 'Enter the caterer name.').max(100, 'Keep the name under 100 characters.'),
	contact: z.string().trim().max(200, 'Keep the contact under 200 characters.'),
	active: checkbox
});

const typeSchema = z.object({
	name: z.string().trim().min(1, 'Enter the meal name.').max(60, 'Keep the name under 60 characters.'),
	vendorId: id('Choose a caterer.'),
	active: checkbox
});

const priceSchema = z.object({
	mealTypeId: id('Choose a meal.'),
	effectiveFrom: z.iso.date('Enter the date the price starts.'),
	unitCost: z
		.string()
		.trim()
		.regex(/^\d{1,5}(\.\d{1,2})?$/, 'Enter the price, up to 2 decimals.')
		.transform(poishaOf)
		.refine((p) => p >= 1, 'The price must be more than zero.'),
	subsidyPct: z.coerce
		.number('Company share must be 0 to 100 percent.')
		.int('Company share must be 0 to 100 percent.')
		.min(0, 'Company share must be 0 to 100 percent.')
		.max(100, 'Company share must be 0 to 100 percent.')
});

const settingsSchema = z.object({
	mealCutoffTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:00)?$/, 'Enter the daily cutoff time.'),
	mealMode: z.enum(MEAL_MODES, 'Choose how meals are ordered.'),
	mealWorkingDaysOnly: checkbox,
	mealBillingMode: z.enum(MEAL_BILLING_MODES, 'Choose how bills are paid.'),
	mealOrderDaysAhead: intSchema(LIMITS.mealOrderDaysAhead)
});

const duplicate = (message: string) => (err: unknown) => {
	if (pgCode(err) === UNIQUE_VIOLATION) throw new AppError('duplicate', message, 409);
	throw err;
};

export async function mealSetup(tx: Tx) {
	const [settings] = await tx
		.select({
			mealCutoffTime: tenantSettings.mealCutoffTime,
			mealMode: tenantSettings.mealMode,
			mealWorkingDaysOnly: tenantSettings.mealWorkingDaysOnly,
			mealBillingMode: tenantSettings.mealBillingMode,
			mealOrderDaysAhead: tenantSettings.mealOrderDaysAhead
		})
		.from(tenantSettings);
	const vendors = await tx.select().from(mealVendors).orderBy(asc(mealVendors.name));
	const types = await tx.select().from(mealTypes).orderBy(asc(mealTypes.name));
	const prices = await tx.select().from(mealTypePrices).orderBy(desc(mealTypePrices.effectiveFrom));
	const today = await tenantToday(tx);
	return {
		settings,
		today,
		vendors,
		types: types.map((t) => {
			const own = prices.filter((p) => p.mealTypeId === t.id);
			return {
				...t,
				vendor: vendors.find((v) => v.id === t.vendorId)!.name,
				current: own.find((p) => p.effectiveFrom <= today) ?? null,
				prices: own
			};
		})
	};
}

async function activeVendor(tx: Tx, vendorId: string) {
	const [v] = await tx.select().from(mealVendors).where(eq(mealVendors.id, vendorId));
	if (!v?.active) throw new AppError('unknown_vendor', 'Choose an active caterer.', 400);
}

export async function saveVendor(ctx: TenantCtx, vendorId: string, raw: Record<string, string>) {
	const input = vendorSchema.parse(raw);
	const values = { ...input, contact: input.contact || null };
	const taken = duplicate('A caterer with that name already exists.');
	await withTenant(ctx, async (tx) => {
		if (!vendorId)
			return void (await tx
				.insert(mealVendors)
				.values({ tenantId: ctx.tenantId, ...values })
				.catch(taken));
		const target = id('That caterer does not exist.').parse(vendorId);
		const saved = await tx
			.update(mealVendors)
			.set(values)
			.where(eq(mealVendors.id, target))
			.returning({ id: mealVendors.id })
			.catch(taken);
		if (!saved.length) throw new AppError('not_found', 'That caterer does not exist.', 404);
	});
}

export async function saveMealType(ctx: TenantCtx, typeId: string, raw: Record<string, string>) {
	const input = typeSchema.parse(raw);
	const taken = duplicate('A meal with that name already exists.');
	await withTenant(ctx, async (tx) => {
		const [current] = typeId
			? await tx
					.select()
					.from(mealTypes)
					.where(eq(mealTypes.id, id('That meal does not exist.').parse(typeId)))
			: [];
		if (typeId && !current) throw new AppError('not_found', 'That meal does not exist.', 404);
		if (current?.vendorId !== input.vendorId) await activeVendor(tx, input.vendorId);
		if (!current)
			return void (await tx
				.insert(mealTypes)
				.values({ tenantId: ctx.tenantId, ...input })
				.catch(taken));
		await tx.update(mealTypes).set(input).where(eq(mealTypes.id, current.id)).catch(taken);
	});
}

export async function setMealPrice(ctx: TenantCtx, raw: Record<string, string>) {
	const input = priceSchema.parse(raw);
	await withTenant(ctx, async (tx) => {
		const [t] = await tx.select({ id: mealTypes.id }).from(mealTypes).where(eq(mealTypes.id, input.mealTypeId));
		if (!t) throw new AppError('not_found', 'That meal does not exist.', 404);
		if (input.effectiveFrom < (await tenantToday(tx)))
			throw new AppError('past_price', 'A new price can start today at the earliest.', 400);
		await tx
			.insert(mealTypePrices)
			.values({ tenantId: ctx.tenantId, ...input })
			.onConflictDoUpdate({
				target: [mealTypePrices.tenantId, mealTypePrices.mealTypeId, mealTypePrices.effectiveFrom],
				set: { unitCost: input.unitCost, subsidyPct: input.subsidyPct }
			});
	});
}

export async function saveMealSettings(ctx: TenantCtx, canBill: boolean, raw: Record<string, string>) {
	const input = settingsSchema.parse(raw);
	await withTenant(ctx, async (tx) => {
		const [s] = await tx.select({ mode: tenantSettings.mealBillingMode }).from(tenantSettings);
		if (s.mode !== input.mealBillingMode && !canBill)
			throw new AppError('forbidden', 'Only meal billing can change how bills are paid.', 403);
		await tx.update(tenantSettings).set(input);
	});
}
