import { asc, between, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Permission } from '../rbac/permissions';
import { auditEvent } from './audit';
import {
	assets,
	attendanceDays,
	employees,
	employeeSalaries,
	expenseClaims,
	leaveLedger,
	leaveTypes,
	payrollRuns,
	payslips,
	ticketCategories,
	tickets
} from './db/schema';
import { exportEmployees } from './employees';
import { AppError } from './errors';
import { can, scopesOf, userCtx, type Access, type requireMember } from './rbac/access';
import { withTenant, type Tx } from './tenancy';

type Member = ReturnType<typeof requireMember>;
type Cell = string | number | null;
type Range = { from: string; to: string };
type Dataset = {
	label: string;
	perm: Permission;
	dated?: true;
	rows: (tx: Tx, access: Access, range: Range) => Promise<Cell[][]>;
};

export const MAX_EXPORT_ROWS = 50_000;
const cap = MAX_EXPORT_ROWS + 1;
const amount = (poisha: number | null) => (poisha === null ? null : poisha / 100);
const stamp = (at: Date | null) => at?.toISOString() ?? null;
const person = { code: employees.code, name: employees.fullName };
const holderCode = sql<
	string | null
>`(select e.code from asset_assignments aa join employees e on e.id = aa.employee_id where aa.asset_id = assets.id and aa.returned_on is null)`;

const DATASETS = {
	employees: { label: 'Employees', perm: 'employee.read', rows: (tx, access) => exportEmployees(tx, access, {}) },
	leave: {
		label: 'Leave ledger',
		perm: 'leave.manage',
		dated: true,
		async rows(tx, _access, r) {
			const list = await tx
				.select({
					...person,
					type: leaveTypes.code,
					fy: leaveLedger.fiscalYear,
					kind: leaveLedger.kind,
					days: leaveLedger.days,
					period: leaveLedger.period,
					note: leaveLedger.note,
					at: leaveLedger.createdAt
				})
				.from(leaveLedger)
				.innerJoin(employees, eq(employees.id, leaveLedger.employeeId))
				.innerJoin(leaveTypes, eq(leaveTypes.id, leaveLedger.leaveTypeId))
				.where(
					sql`(${leaveLedger.createdAt} at time zone (select s.timezone from tenant_settings s))::date between ${r.from} and ${r.to}`
				)
				.orderBy(asc(leaveLedger.createdAt))
				.limit(cap);
			return [
				[
					'employee_code',
					'employee_name',
					'leave_type_code',
					'fiscal_year',
					'kind',
					'days',
					'period',
					'note',
					'created_at'
				],
				...list.map((x) => [x.code, x.name, x.type, x.fy, x.kind, x.days, x.period, x.note, stamp(x.at)])
			];
		}
	},
	attendance: {
		label: 'Attendance days',
		perm: 'attendance.manage',
		dated: true,
		async rows(tx, _access, r) {
			const list = await tx
				.select({ ...person, day: attendanceDays })
				.from(attendanceDays)
				.innerJoin(employees, eq(employees.id, attendanceDays.employeeId))
				.where(between(attendanceDays.date, r.from, r.to))
				.orderBy(asc(attendanceDays.date), asc(employees.code))
				.limit(cap);
			return [
				[
					'employee_code',
					'employee_name',
					'date',
					'status',
					'first_in',
					'last_out',
					'worked_minutes',
					'late_minutes',
					'time_zone'
				],
				...list.map(({ code, name, day: d }) => [
					code,
					name,
					d.date,
					d.status,
					stamp(d.firstIn),
					stamp(d.lastOut),
					d.workedMinutes,
					d.lateMinutes,
					d.timeZone
				])
			];
		}
	},
	assets: {
		label: 'Assets',
		perm: 'asset.read',
		async rows(tx) {
			const list = await tx.select({ a: assets, holder: holderCode }).from(assets).orderBy(asc(assets.tag)).limit(cap);
			return [
				['tag', 'name', 'category', 'serial', 'purchase_date', 'purchase_cost', 'status', 'holder_code'],
				...list.map(({ a, holder }) => [
					a.tag,
					a.name,
					a.category,
					a.serial,
					a.purchaseDate,
					amount(a.purchaseCost),
					a.status,
					holder
				])
			];
		}
	},
	tickets: {
		label: 'Helpdesk tickets',
		perm: 'helpdesk.manage',
		async rows(tx, access) {
			const list = await tx
				.select({ ...person, t: tickets, category: ticketCategories.name, confidential: ticketCategories.confidential })
				.from(tickets)
				.innerJoin(ticketCategories, eq(ticketCategories.id, tickets.categoryId))
				.innerJoin(employees, eq(employees.id, tickets.requesterEmployeeId))
				.where(
					scopesOf(access, 'helpdesk.confidential').includes('all')
						? undefined
						: eq(ticketCategories.confidential, false)
				)
				.orderBy(asc(tickets.number))
				.limit(cap);
			return [
				[
					'number',
					'category',
					'confidential',
					'requester_code',
					'requester_name',
					'subject',
					'description',
					'priority',
					'status',
					'created_at',
					'sla_due_at',
					'resolved_at'
				],
				...list.map(({ code, name, t, category, confidential }) => [
					t.number,
					category,
					confidential ? 'yes' : 'no',
					code,
					name,
					t.subject,
					t.description,
					t.priority,
					t.status,
					stamp(t.createdAt),
					stamp(t.slaDueAt),
					stamp(t.resolvedAt)
				])
			];
		}
	},
	expenses: {
		label: 'Expense claims',
		perm: 'expense.pay',
		async rows(tx) {
			const list = await tx
				.select({ ...person, c: expenseClaims })
				.from(expenseClaims)
				.innerJoin(employees, eq(employees.id, expenseClaims.employeeId))
				.orderBy(asc(expenseClaims.createdAt))
				.limit(cap);
			return [
				[
					'employee_code',
					'employee_name',
					'title',
					'status',
					'total',
					'pay_via',
					'submitted_at',
					'decided_at',
					'paid_at'
				],
				...list.map(({ code, name, c }) => [
					code,
					name,
					c.title,
					c.status,
					amount(c.total),
					c.payVia,
					stamp(c.createdAt),
					stamp(c.decidedAt),
					stamp(c.paidAt)
				])
			];
		}
	},
	salaries: {
		label: 'Salaries',
		perm: 'salary.read',
		async rows(tx) {
			const list = await tx
				.select({ ...person, s: employeeSalaries })
				.from(employeeSalaries)
				.innerJoin(employees, eq(employees.id, employeeSalaries.employeeId))
				.orderBy(asc(employees.code), asc(employeeSalaries.effectiveFrom))
				.limit(cap);
			return [
				['employee_code', 'employee_name', 'effective_from', 'effective_to', 'gross'],
				...list.map(({ code, name, s }) => [code, name, s.effectiveFrom, s.effectiveTo, amount(s.gross)])
			];
		}
	},
	payroll: {
		label: 'Payslips',
		perm: 'payroll.run',
		dated: true,
		async rows(tx, _access, r) {
			const list = await tx
				.select({ ...person, run: payrollRuns, p: payslips })
				.from(payslips)
				.innerJoin(payrollRuns, eq(payrollRuns.id, payslips.runId))
				.innerJoin(employees, eq(employees.id, payslips.employeeId))
				.where(between(payrollRuns.period, r.from.slice(0, 7), r.to.slice(0, 7)))
				.orderBy(asc(payrollRuns.period), asc(payrollRuns.computedAt), asc(employees.code))
				.limit(cap);
			return [
				[
					'period',
					'run_type',
					'run_status',
					'currency',
					'employee_code',
					'employee_name',
					'paid_days',
					'unpaid_days',
					'gross',
					'deductions',
					'tax',
					'net'
				],
				...list.map(({ code, name, run, p }) => [
					run.period,
					run.runType,
					run.status,
					run.currency,
					code,
					name,
					p.paidDays,
					p.unpaidDays,
					amount(p.gross),
					amount(p.deductions),
					amount(p.tax),
					amount(p.net)
				])
			];
		}
	}
} satisfies Record<string, Dataset>;

type DatasetKey = keyof typeof DATASETS;
const KEYS = Object.keys(DATASETS) as [DatasetKey, ...DatasetKey[]];
const pickSchema = z.object({ dataset: z.enum(KEYS, 'Choose what to export.') });
const rangeSchema = z
	.object({ from: z.iso.date('Enter the start date.'), to: z.iso.date('Enter the end date.') })
	.refine((r) => r.to >= r.from, 'The end date must be on or after the start date.')
	.refine((r) => Date.parse(r.to) - Date.parse(r.from) <= 365 * 86_400_000, 'Export at most 366 days at a time.');

const allowed = (access: Access, d: Dataset) => can(access, 'data.export') && scopesOf(access, d.perm).includes('all');

export const exportableDatasets = (access: Access) =>
	KEYS.filter((key) => allowed(access, DATASETS[key])).map((key) => ({
		key,
		label: DATASETS[key].label,
		dated: 'dated' in DATASETS[key]
	}));

export async function exportDataset(m: Member, raw: Record<string, string>) {
	const { dataset } = pickSchema.parse(raw);
	const d: Dataset = DATASETS[dataset];
	if (!allowed(m.access, d)) throw new AppError('forbidden', 'You cannot export this data.', 403);
	const range = d.dated ? rangeSchema.parse(raw) : { from: '', to: '' };
	const ctx = userCtx(m, { salaryAll: dataset === 'salaries', payrollAll: dataset === 'payroll' });
	const rows = await withTenant(ctx, async (tx) => {
		await auditEvent(tx, ctx, dataset, null, 'data.export');
		return d.rows(tx, m.access, range);
	});
	if (rows.length > cap)
		throw new AppError('too_many', `A file can hold at most ${MAX_EXPORT_ROWS} rows. Choose a shorter period.`, 413);
	const span = d.dated ? `${range.from}-to-${range.to}` : new Date().toISOString().slice(0, 10);
	return { fileName: `${dataset}-${span}.csv`, rows };
}
