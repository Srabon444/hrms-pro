import { and, asc, desc, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import { poishaOf } from '../money';
import {
	DEFAULT_TAX_YEAR,
	fiscalYearOf,
	formatBands,
	parseBands,
	TAX_CATEGORIES,
	type Band,
	type TaxCategory,
	type TaxRule
} from '../tax';
import { employees, employeeTaxProfiles, taxSlabs, taxYears } from './db/schema';
import { AppError } from './errors';
import { tenantToday } from './lifecycle';
import { advisoryLock, LOCK } from './locks';
import { can, userCtx, type requireMember } from './rbac/access';
import { inScope, resolveScope, scopeWhere } from './rbac/scope';
import { withTenant, type Tx } from './tenancy';

type Member = ReturnType<typeof requireMember>;

const amount = (label: string) =>
	z
		.string()
		.trim()
		.regex(/^\d{1,9}(\.\d{1,2})?$/, `Enter ${label} in taka, up to 2 decimals.`)
		.transform(poishaOf);

const yearSchema = z.object({
	taxYearId: z.uuid({ error: 'Choose a tax year.' }),
	minimumTax: amount('the minimum tax'),
	exemptionCap: amount('the exemption cap'),
	exemptionDivisor: z.coerce
		.number('Enter the exemption divisor.')
		.int('The exemption divisor is a whole number.')
		.min(1, 'The exemption divisor is between 1 and 10.')
		.max(10, 'The exemption divisor is between 1 and 10.')
});

const startSchema = z.object({ fy: z.string().regex(/^\d{4}-\d{2}$/, 'Enter the fiscal year like 2026-27.') });

const profileSchema = z.object({
	taxYearId: z.uuid({ error: 'Choose a tax year.' }),
	employeeId: z.uuid({ error: 'Choose an employee.' }),
	category: z.enum(TAX_CATEGORIES, 'Choose a tax category.'),
	prevEmployerIncome: amount('income from a previous employer'),
	prevTaxPaid: amount('tax paid at a previous employer'),
	rebate: amount('the investment rebate')
});

const yearNotFound = () => new AppError('not_found', 'That tax year does not exist.', 404);

export const taxCtx = (m: Member) => userCtx(m, { payrollAll: can(m.access, 'payroll.run') });

const slabRows = (tenantId: string, taxYearId: string, bands: Record<TaxCategory, Band[]>) =>
	TAX_CATEGORIES.flatMap((category) =>
		bands[category].map((b, seq) => ({ tenantId, taxYearId, category, seq, width: b.width, rateBp: b.rateBp }))
	);

async function loadBands(tx: Tx, taxYearId: string) {
	const rows = await tx
		.select()
		.from(taxSlabs)
		.where(eq(taxSlabs.taxYearId, taxYearId))
		.orderBy(asc(taxSlabs.category), asc(taxSlabs.seq));
	return Object.fromEntries(
		TAX_CATEGORIES.map((c) => [
			c,
			rows.filter((r) => r.category === c).map((r) => ({ width: r.width, rateBp: r.rateBp }))
		])
	) as Record<TaxCategory, Band[]>;
}

export async function startTaxYear(m: Member, form: Record<string, string>) {
	const { fy } = startSchema.parse(form);
	if (Number(fy.slice(5)) !== (Number(fy.slice(0, 4)) + 1) % 100)
		throw new AppError('bad_fy', 'A fiscal year runs over two calendar years, like 2026-27.', 400);
	return withTenant(userCtx(m), async (tx) => {
		const [source] = await tx.select().from(taxYears).orderBy(desc(taxYears.fy)).limit(1);
		const settings = source ?? DEFAULT_TAX_YEAR;
		const [year] = await tx
			.insert(taxYears)
			.values({
				tenantId: m.tenant.id,
				fy,
				minimumTax: settings.minimumTax,
				exemptionCap: settings.exemptionCap,
				exemptionDivisor: settings.exemptionDivisor
			})
			.onConflictDoNothing()
			.returning({ id: taxYears.id });
		if (!year) throw new AppError('exists', `Tax year ${fy} is already set up.`, 409);
		const bands = source
			? await loadBands(tx, source.id)
			: (Object.fromEntries(TAX_CATEGORIES.map((c) => [c, parseBands(DEFAULT_TAX_YEAR.bands[c]) as Band[]])) as Record<
					TaxCategory,
					Band[]
				>);
		await tx.insert(taxSlabs).values(slabRows(m.tenant.id, year.id, bands));
		return year.id;
	});
}

export async function saveTaxYear(m: Member, form: Record<string, string>) {
	const input = yearSchema.parse(form);
	const bands = {} as Record<TaxCategory, Band[]>;
	for (const c of TAX_CATEGORIES) {
		const parsed = parseBands(form[`bands_${c}`] ?? '');
		if (typeof parsed === 'string') throw new AppError('bad_bands', parsed, 400);
		bands[c] = parsed;
	}
	await withTenant(userCtx(m), async (tx) => {
		await advisoryLock(tx, LOCK.payroll, m.tenant.id);
		const updated = await tx
			.update(taxYears)
			.set({
				minimumTax: input.minimumTax,
				exemptionCap: input.exemptionCap,
				exemptionDivisor: input.exemptionDivisor,
				confirmedByUserId: null,
				confirmedAt: null
			})
			.where(eq(taxYears.id, input.taxYearId))
			.returning({ id: taxYears.id });
		if (!updated.length) throw yearNotFound();
		await tx.delete(taxSlabs).where(eq(taxSlabs.taxYearId, input.taxYearId));
		await tx.insert(taxSlabs).values(slabRows(m.tenant.id, input.taxYearId, bands));
	});
}

export async function confirmTaxYear(m: Member, form: Record<string, string>) {
	const { taxYearId } = yearSchema.pick({ taxYearId: true }).parse(form);
	await withTenant(userCtx(m), async (tx) => {
		const updated = await tx
			.update(taxYears)
			.set({ confirmedByUserId: m.user.userId, confirmedAt: new Date() })
			.where(eq(taxYears.id, taxYearId))
			.returning({ id: taxYears.id });
		if (!updated.length) throw yearNotFound();
	});
}

export async function saveTaxProfile(m: Member, form: Record<string, string>) {
	const input = profileSchema.parse(form);
	await withTenant(taxCtx(m), async (tx) => {
		const [year] = await tx.select({ id: taxYears.id }).from(taxYears).where(eq(taxYears.id, input.taxYearId));
		if (!year) throw yearNotFound();
		const [e] = await tx.select({ id: employees.id }).from(employees).where(eq(employees.id, input.employeeId));
		if (!e || !inScope(await resolveScope(tx, m.access, 'payroll.run'), e.id))
			throw new AppError('not_found', 'That employee does not exist.', 404);
		const values = {
			category: input.category,
			prevEmployerIncome: input.prevEmployerIncome,
			prevTaxPaid: input.prevTaxPaid,
			rebate: input.rebate
		};
		await tx
			.insert(employeeTaxProfiles)
			.values({ tenantId: m.tenant.id, taxYearId: year.id, employeeId: e.id, ...values })
			.onConflictDoUpdate({
				target: [employeeTaxProfiles.tenantId, employeeTaxProfiles.taxYearId, employeeTaxProfiles.employeeId],
				set: values
			});
	});
}

export async function taxRule(tx: Tx, fy: string, category: TaxCategory): Promise<TaxRule | null> {
	const [year] = await tx.select().from(taxYears).where(eq(taxYears.fy, fy));
	if (!year?.confirmedAt) return null;
	return { ...year, bands: (await loadBands(tx, year.id))[category] };
}

export async function taxBoard(tx: Tx, m: Member, fy?: string) {
	const today = await tenantToday(tx);
	const years = await tx.select().from(taxYears).orderBy(desc(taxYears.fy));
	const current = fiscalYearOf(today);
	const year = years.find((y) => y.fy === (fy ?? current)) ?? years[0];
	const bands = year ? await loadBands(tx, year.id) : null;
	const canProfiles = can(m.access, 'payroll.run');
	const people =
		year && canProfiles
			? await tx
					.select({
						id: employees.id,
						name: employees.fullName,
						code: employees.code,
						category: employeeTaxProfiles.category,
						prevEmployerIncome: employeeTaxProfiles.prevEmployerIncome,
						prevTaxPaid: employeeTaxProfiles.prevTaxPaid,
						rebate: employeeTaxProfiles.rebate
					})
					.from(employees)
					.leftJoin(
						employeeTaxProfiles,
						and(eq(employeeTaxProfiles.employeeId, employees.id), eq(employeeTaxProfiles.taxYearId, year.id))
					)
					.where(
						and(
							ne(employees.status, 'exited'),
							scopeWhere(await resolveScope(tx, m.access, 'payroll.run'), employees.id)
						)
					)
					.orderBy(asc(employees.fullName))
			: [];
	return {
		current,
		canConfigure: can(m.access, 'settings.manage'),
		canProfiles,
		years: years.map((y) => ({ fy: y.fy, confirmed: !!y.confirmedAt })),
		year: year && {
			...year,
			bands: Object.fromEntries(TAX_CATEGORIES.map((c) => [c, formatBands(bands![c])])) as Record<TaxCategory, string>
		},
		people
	};
}
