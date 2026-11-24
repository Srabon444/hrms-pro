import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { pgCode, UNIQUE_VIOLATION } from './db/errors';
import { LEAVE_ACCRUALS, LEAVE_GENDERS, leaveTypes } from './db/schema';
import { AppError } from './errors';
import { withTenant, type TenantCtx, type Tx } from './tenancy';

type LeaveTypeInput = Omit<typeof leaveTypes.$inferInsert, 'id' | 'tenantId' | 'createdAt' | 'updatedAt'>;

export const DEFAULT_LEAVE_TYPES: LeaveTypeInput[] = [
	{ code: 'casual', name: 'Casual leave', quota: 10 },
	{ code: 'sick', name: 'Sick leave', quota: 14 },
	{
		code: 'earned',
		name: 'Earned leave',
		quota: 18,
		accrual: 'monthly',
		carryCap: 60,
		encashable: true,
		minNoticeDays: 7,
		duringProbation: false
	},
	{
		code: 'maternity',
		name: 'Maternity leave',
		quota: 112,
		proRata: false,
		halfDayAllowed: false,
		gender: 'female',
		sandwich: true
	},
	{ code: 'paternity', name: 'Paternity leave', quota: 5, proRata: false, halfDayAllowed: false, gender: 'male' },
	{ code: 'compensatory', name: 'Compensatory leave', quota: 0, accrual: 'none', proRata: false },
	{ code: 'unpaid', name: 'Unpaid leave', paid: false, quota: null, accrual: 'none', proRata: false }
];

export const seedLeaveTypes = (tx: Tx, tenantId: string) =>
	tx
		.insert(leaveTypes)
		.values(DEFAULT_LEAVE_TYPES.map((t) => ({ tenantId, ...t })))
		.onConflictDoNothing();

const checkbox = z.preprocess((v) => v === 'on' || v === true, z.boolean());
const optionalInt = (min: number, max: number, message: string) =>
	z.preprocess(
		(v) => (v === '' || v === undefined ? null : v),
		z.coerce.number().int(message).min(min, message).max(max, message).nullable()
	);
const halfDays = (message: string) =>
	z.coerce
		.number(message)
		.min(0, message)
		.max(366, message)
		.refine((n) => Number.isInteger(n * 2), 'Use whole or half days.');

const typeSchema = z.object({
	name: z.string().trim().min(1, 'Enter a name.').max(60, 'Keep the name under 60 characters.'),
	paid: checkbox,
	quota: z.preprocess(
		(v) => (v === '' || v === undefined ? null : v),
		halfDays('Quota must be 0 to 366 days.').nullable()
	),
	accrual: z.enum(LEAVE_ACCRUALS, { error: 'Choose how the leave is credited.' }),
	proRata: checkbox,
	carryCap: halfDays('Carry forward must be 0 to 366 days.'),
	encashable: checkbox,
	maxConsecutive: optionalInt(1, 366, 'Longest stretch must be 1 to 366 days.'),
	minNoticeDays: z.coerce
		.number()
		.int('Notice must be 0 to 365 days.')
		.min(0, 'Notice must be 0 to 365 days.')
		.max(365, 'Notice must be 0 to 365 days.'),
	halfDayAllowed: checkbox,
	gender: z.preprocess((v) => v || null, z.enum(LEAVE_GENDERS, { error: 'Choose who can take it.' }).nullable()),
	duringProbation: checkbox,
	sandwich: checkbox,
	active: checkbox
});
const newTypeSchema = typeSchema.extend({
	code: z
		.string()
		.trim()
		.toLowerCase()
		.regex(/^[a-z][a-z_]{1,29}$/, 'Use 2 to 30 lowercase letters or underscores for the code.')
});

const duplicate = (err: unknown) => {
	if (pgCode(err) === UNIQUE_VIOLATION)
		throw new AppError('duplicate', 'A leave type with that code or name already exists.', 409);
	throw err;
};

export const listLeaveTypes = (tx: Tx) => tx.select().from(leaveTypes).orderBy(asc(leaveTypes.name));

export async function createLeaveType(ctx: TenantCtx, raw: Record<string, string>) {
	const input = newTypeSchema.parse(raw);
	await withTenant(ctx, (tx) =>
		tx
			.insert(leaveTypes)
			.values({ tenantId: ctx.tenantId, ...input })
			.catch(duplicate)
	);
}

export async function updateLeaveType(ctx: TenantCtx, typeId: string, raw: Record<string, string>) {
	const id = z.uuid().safeParse(typeId);
	const input = typeSchema.parse(raw);
	await withTenant(ctx, async (tx) => {
		const done = id.success
			? await tx
					.update(leaveTypes)
					.set(input)
					.where(eq(leaveTypes.id, id.data))
					.returning({ id: leaveTypes.id })
					.catch(duplicate)
			: [];
		if (!done.length) throw new AppError('not_found', 'That leave type does not exist.', 404);
	});
}
