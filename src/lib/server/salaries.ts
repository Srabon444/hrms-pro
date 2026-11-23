import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { poishaOf, taka } from '../money';
import type { ApprovalItem } from './approvals';
import { singleAdmin } from './approval-chain';
import { pgCode, UNIQUE_VIOLATION } from './db/errors';
import { employeeSalaries, employeeSalaryLines, employees, payComponents, salaryChanges } from './db/schema';
import { addDays } from './dates';
import { AppError } from './errors';
import { tenantToday } from './lifecycle';
import { advisoryLock, LOCK } from './locks';
import { can, userCtx, type Access, type requireMember } from './rbac/access';
import { inScope, resolveScope, scopeWhere } from './rbac/scope';
import { withTenant, type Tx } from './tenancy';

type Member = ReturnType<typeof requireMember>;

export const PAY_COMPONENT_SEED = [
	{ code: 'BASIC', name: 'Basic', kind: 'earning', calc: 'fixed' },
	{ code: 'HOUSE_RENT', name: 'House rent', kind: 'earning', calc: 'pct_basic' },
	{ code: 'MEDICAL', name: 'Medical allowance', kind: 'earning', calc: 'fixed' },
	{ code: 'CONVEYANCE', name: 'Conveyance', kind: 'earning', calc: 'fixed' },
	{ code: 'PF', name: 'Provident fund', kind: 'deduction', calc: 'pct_basic' },
	{ code: 'TAX', name: 'Income tax', kind: 'deduction', calc: 'fixed' },
	{ code: 'MEAL', name: 'Meals', kind: 'deduction', calc: 'fixed' },
	{ code: 'LOAN', name: 'Loan instalment', kind: 'deduction', calc: 'fixed' },
	{ code: 'LOP', name: 'Unpaid days', kind: 'deduction', calc: 'fixed' },
	{ code: 'ADJ', name: 'Adjustment', kind: 'deduction', calc: 'fixed' }
] as const;

export const seedPayComponents = (tx: Tx, tenantId: string) =>
	tx
		.insert(payComponents)
		.values(PAY_COMPONENT_SEED.map((c) => ({ ...c, tenantId, system: true })))
		.onConflictDoNothing();

export const salaryCtx = (m: Member) =>
	userCtx(m, {
		salaryAll: (['salary.read', 'salary.update', 'salary.approve'] as const).some((p) => can(m.access, p))
	});

const inSalary = (c: { kind: string; system: boolean; active: boolean }) =>
	c.active && (c.kind === 'earning' || !c.system);

const salaryComponents = async (tx: Tx) =>
	(await tx.select().from(payComponents).orderBy(desc(payComponents.kind), asc(payComponents.name))).filter(inSalary);

const fixedValue = z
	.string()
	.trim()
	.regex(/^\d{1,7}(\.\d{1,2})?$/, 'Enter amounts in taka, up to 2 decimals.')
	.transform(poishaOf);
const pctValue = z
	.string()
	.trim()
	.regex(/^\d{1,3}(\.\d{1,2})?$/, 'Enter percentages with up to 2 decimals.')
	.transform(poishaOf)
	.refine((bp) => bp <= 10_000, 'A percentage cannot be over 100.');

const proposalSchema = z.object({
	employeeId: z.uuid({ error: 'Choose an employee.' }),
	effectiveFrom: z.iso.date('Enter the date the salary starts.'),
	reason: z.string().trim().min(1, 'Say why the salary changes.').max(300, 'Keep the reason under 300 characters.')
});

export function resolveLines(
	components: { id: string; code: string; calc: string; kind: string; name: string }[],
	values: Map<string, number>
) {
	const basicId = components.find((c) => c.code === 'BASIC')?.id;
	const basic = (basicId && values.get(basicId)) || 0;
	if (basic <= 0) throw new AppError('no_basic', 'Enter the basic salary.', 400);
	const lines = components
		.filter((c) => values.has(c.id))
		.map((c) => {
			const value = values.get(c.id)!;
			return {
				componentId: c.id,
				value,
				amount: c.calc === 'pct_basic' ? Math.round((basic * value) / 10_000) : value
			};
		});
	const gross = lines
		.filter((l) => components.find((c) => c.id === l.componentId)!.kind === 'earning')
		.reduce((sum, l) => sum + l.amount, 0);
	return { lines, gross };
}

const latestSalary = async (tx: Tx, employeeId: string) =>
	(
		await tx
			.select()
			.from(employeeSalaries)
			.where(eq(employeeSalaries.employeeId, employeeId))
			.orderBy(desc(employeeSalaries.effectiveFrom))
			.limit(1)
	)[0];

function assertAfter(latest: { effectiveFrom: string } | undefined, from: string) {
	if (latest && latest.effectiveFrom >= from)
		throw new AppError('not_after', `The new salary must start after ${latest.effectiveFrom}.`, 409);
}

export async function proposeSalary(m: Member, form: Record<string, string>) {
	const input = proposalSchema.parse(form);
	return withTenant(salaryCtx(m), async (tx) => {
		const [e] = await tx.select().from(employees).where(eq(employees.id, input.employeeId));
		if (!e || !inScope(await resolveScope(tx, m.access, 'salary.update'), e.id))
			throw new AppError('not_found', 'That employee does not exist.', 404);
		if (e.status === 'exited') throw new AppError('exited', `${e.fullName} has left.`, 409);
		if (input.effectiveFrom < e.joinDate)
			throw new AppError('before_join', `The salary cannot start before ${e.fullName} joined on ${e.joinDate}.`, 409);
		assertAfter(await latestSalary(tx, e.id), input.effectiveFrom);
		const components = await salaryComponents(tx);
		const values = new Map<string, number>();
		for (const c of components) {
			const raw = (form[`c_${c.id}`] ?? '').trim();
			if (!raw) continue;
			const value = (c.calc === 'pct_basic' ? pctValue : fixedValue).parse(raw);
			if (value > 0) values.set(c.id, value);
		}
		const { lines, gross } = resolveLines(components, values);
		const [change] = await tx
			.insert(salaryChanges)
			.values({
				tenantId: m.tenant.id,
				employeeId: e.id,
				effectiveFrom: input.effectiveFrom,
				reason: input.reason,
				lines,
				gross,
				requestedByUserId: m.user.userId
			})
			.returning({ id: salaryChanges.id })
			.catch((err) => {
				if (pgCode(err) === UNIQUE_VIOLATION)
					throw new AppError('pending_exists', `${e.fullName} already has a salary change waiting.`, 409);
				throw err;
			});
		return change.id;
	});
}

const decisionSchema = z.object({
	changeId: z.uuid({ error: 'Choose a salary change.' }),
	decision: z.enum(['approve', 'reject'], 'Choose approve or reject.'),
	note: z.string().trim().max(300, 'Keep the note under 300 characters.')
});

export async function decideSalary(m: Member, form: Record<string, string>) {
	const input = decisionSchema.parse(form);
	return withTenant(salaryCtx(m), async (tx) => {
		await advisoryLock(tx, LOCK.payroll, m.tenant.id);
		const [change] = await tx.select().from(salaryChanges).where(eq(salaryChanges.id, input.changeId));
		if (!change || !inScope(await resolveScope(tx, m.access, 'salary.approve'), change.employeeId))
			throw new AppError('not_found', 'That salary change does not exist.', 404);
		if (change.status !== 'pending') throw new AppError('decided', 'That salary change is already decided.', 409);
		const self = change.requestedByUserId === m.user.userId || change.employeeId === m.access.employeeId;
		if (self && !(await singleAdmin(tx)))
			throw new AppError('own_change', 'Someone else must decide a salary change you made or that is yours.', 403);
		const decided = { decidedByUserId: m.user.userId, decidedAt: new Date(), decisionNote: input.note || null };
		if (input.decision === 'reject') {
			await tx
				.update(salaryChanges)
				.set({ status: 'rejected', ...decided })
				.where(eq(salaryChanges.id, change.id));
			return 'rejected';
		}
		const components = new Set(
			(await tx.select().from(payComponents).where(eq(payComponents.active, true))).filter(inSalary).map((c) => c.id)
		);
		if (change.lines.some((l) => !components.has(l.componentId)))
			throw new AppError('component_gone', 'A pay component in this change is no longer active.', 409);
		await tx
			.update(employeeSalaries)
			.set({ effectiveTo: addDays(change.effectiveFrom, -1) })
			.where(and(eq(employeeSalaries.employeeId, change.employeeId), isNull(employeeSalaries.effectiveTo)));
		const [salary] = await tx
			.insert(employeeSalaries)
			.values({
				tenantId: m.tenant.id,
				employeeId: change.employeeId,
				effectiveFrom: change.effectiveFrom,
				gross: change.gross,
				changeId: change.id
			})
			.returning({ id: employeeSalaries.id });
		await tx.insert(employeeSalaryLines).values(
			change.lines.map((l) => ({
				tenantId: m.tenant.id,
				salaryId: salary.id,
				employeeId: change.employeeId,
				componentId: l.componentId,
				value: l.value,
				amount: l.amount
			}))
		);
		await tx
			.update(salaryChanges)
			.set({ status: 'approved', ...decided })
			.where(eq(salaryChanges.id, change.id));
		return 'approved';
	});
}

export async function salaryBoard(tx: Tx, m: Member) {
	const scope = await resolveScope(tx, m.access, 'salary.read');
	const people = await tx
		.select({ id: employees.id, name: employees.fullName, code: employees.code, joinDate: employees.joinDate })
		.from(employees)
		.where(and(ne(employees.status, 'exited'), scopeWhere(scope, employees.id)))
		.orderBy(asc(employees.fullName));
	const ids = people.map((p) => p.id);
	const salaries = ids.length
		? await tx
				.select()
				.from(employeeSalaries)
				.where(and(inArray(employeeSalaries.employeeId, ids), isNull(employeeSalaries.effectiveTo)))
		: [];
	const components = await tx.select().from(payComponents).orderBy(desc(payComponents.kind), asc(payComponents.name));
	const name = new Map(components.map((c) => [c.id, c.name]));
	const rank = new Map(components.map((c, i) => [c.id, i]));
	const lines = salaries.length
		? await tx
				.select()
				.from(employeeSalaryLines)
				.where(
					inArray(
						employeeSalaryLines.salaryId,
						salaries.map((s) => s.id)
					)
				)
		: [];
	const approveScope = await resolveScope(tx, m.access, 'salary.approve');
	const lone = await singleAdmin(tx);
	const pending = ids.length
		? await tx
				.select()
				.from(salaryChanges)
				.where(and(eq(salaryChanges.status, 'pending'), inArray(salaryChanges.employeeId, ids)))
				.orderBy(asc(salaryChanges.createdAt))
		: [];
	const describe = (l: { componentId: string; amount: number }) => `${name.get(l.componentId)} ৳${taka(l.amount)}`;
	return {
		today: await tenantToday(tx),
		components: components.filter(inSalary),
		canPropose: can(m.access, 'salary.update'),
		people: people.map((p) => {
			const s = salaries.find((x) => x.employeeId === p.id);
			return {
				...p,
				salary: s
					? {
							gross: s.gross,
							effectiveFrom: s.effectiveFrom,
							lines: lines
								.filter((l) => l.salaryId === s.id)
								.sort((x, y) => rank.get(x.componentId)! - rank.get(y.componentId)!)
								.map(describe)
						}
					: null
			};
		}),
		pending: pending.map((c) => ({
			id: c.id,
			name: people.find((p) => p.id === c.employeeId)!.name,
			effectiveFrom: c.effectiveFrom,
			reason: c.reason,
			gross: c.gross,
			lines: c.lines.map(describe),
			canDecide:
				inScope(approveScope, c.employeeId) &&
				(lone || (c.requestedByUserId !== m.user.userId && c.employeeId !== m.access.employeeId))
		}))
	};
}

export async function salaryApprovals(tx: Tx, access: Access): Promise<ApprovalItem[]> {
	const scope = await resolveScope(tx, access, 'salary.approve');
	const rows = await tx
		.select({
			id: salaryChanges.id,
			at: salaryChanges.createdAt,
			gross: salaryChanges.gross,
			from: salaryChanges.effectiveFrom,
			name: employees.fullName
		})
		.from(salaryChanges)
		.innerJoin(employees, eq(employees.id, salaryChanges.employeeId))
		.where(
			and(
				eq(salaryChanges.status, 'pending'),
				scopeWhere(scope, salaryChanges.employeeId),
				access.employeeId ? ne(salaryChanges.employeeId, access.employeeId) : sql`true`
			)
		)
		.orderBy(asc(salaryChanges.createdAt))
		.limit(200);
	return rows.map((r) => ({
		id: r.id,
		kind: 'Salary change',
		title: `${r.name}: ৳${taka(r.gross)} from ${r.from}`,
		requestedBy: r.name,
		at: r.at,
		link: 'payroll/salaries'
	}));
}
