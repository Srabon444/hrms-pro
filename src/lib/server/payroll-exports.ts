import { asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { PAYROLL_EXPORTS, payrollCsv } from '../payroll-csv';
import { auditEvent } from './audit';
import { employees, payrollRuns } from './db/schema';
import { AppError } from './errors';
import { canSeePayroll, storedSlips } from './payroll';
import { scopesOf, userCtx, type requireMember } from './rbac/access';
import { withTenant } from './tenancy';

const schema = z.object({
	runId: z.uuid('Choose a payroll run.'),
	kind: z.enum(PAYROLL_EXPORTS, 'Choose a payroll report.')
});

export async function exportPayroll(m: ReturnType<typeof requireMember>, params: Record<string, string>) {
	const { runId, kind } = schema.parse(params);
	if (!canSeePayroll(m.access)) throw new AppError('forbidden', 'Payroll needs access to everyone.', 403);
	if (kind === 'bank' && !scopesOf(m.access, 'payroll.approve').includes('all'))
		throw new AppError('forbidden', 'Only finance can download the bank sheet.', 403);
	const ctx = userCtx(m, { payrollAll: true });
	return withTenant(ctx, async (tx) => {
		const [run] = await tx.select().from(payrollRuns).where(eq(payrollRuns.id, runId));
		if (!run || run.status === 'void') throw new AppError('not_found', 'That payroll run does not exist.', 404);
		if (kind === 'bank' && run.status !== 'approved' && run.status !== 'paid')
			throw new AppError('not_approved', 'Approve the payroll before downloading the bank sheet.', 409);
		const stored = await storedSlips(tx, run.id);
		if (stored.some((s) => s.error))
			throw new AppError('has_errors', 'Fix the payslips with problems before downloading reports.', 409);
		const people = stored.length
			? await tx
					.select({
						id: employees.id,
						code: employees.code,
						name: employees.fullName,
						bankName: employees.bankName,
						bankAccountName: employees.bankAccountName,
						bankAccountNumber: employees.bankAccountNumber,
						taxId: employees.taxId
					})
					.from(employees)
					.where(
						inArray(
							employees.id,
							stored.map((s) => s.employeeId)
						)
					)
					.orderBy(asc(employees.code))
			: [];
		const slips = people.map((p) => stored.find((s) => s.employeeId === p.id)!);
		const showTin = scopesOf(m.access, 'employee.sensitive.read').includes('all');
		await auditEvent(tx, ctx, 'payroll_runs', run.id, `payroll.export.${kind}`);
		return { fileName: `${run.runType}-${run.period}-${kind}.csv`, rows: payrollCsv(kind, people, slips, showTin) };
	});
}
