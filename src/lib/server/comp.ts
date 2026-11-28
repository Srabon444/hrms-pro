import { and, asc, desc, eq, ilike, inArray, isNull, max, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { poishaOf } from '../money';
import { pgCode, UNIQUE_VIOLATION } from './db/errors';
import { likeEscape } from './db/like';
import {
	compBudgets,
	compCycles,
	compProposals,
	departments,
	employeeSalaries,
	employeeSalaryLines,
	employees,
	salaryChanges
} from './db/schema';
import { AppError } from './errors';
import { can, userCtx, type requireMember } from './rbac/access';
import { inScope, resolveScope, scopeWhere, type ScopeSet } from './rbac/scope';
import { resolveLines, salaryComponents } from './salaries';
import { withTenant, type Tx } from './tenancy';

type Member = ReturnType<typeof requireMember>;
type Component = Awaited<ReturnType<typeof salaryComponents>>[number];
type Line = { componentId: string; value: number; amount: number };

export const COMP = { rows: 500, cycles: 50, maxPay: 2_147_483_647 };

const forbidden = () => new AppError('forbidden', 'You do not have permission to do that.', 403);
const missing = () => new AppError('not_found', 'That pay review does not exist.', 404);
const noEmployee = () => new AppError('not_found', 'That employee does not exist.', 404);

export const compCtx = (m: Member) =>
	userCtx(m, { salaryAll: can(m.access, 'comp.propose') || can(m.access, 'comp.manage') });

const words = (limit: number, empty: string, long: string) =>
	z
		.string()
		.trim()
		.min(1, empty)
		.max(limit, long)
		.regex(/^\P{Cc}*$/u, 'Remove unsupported characters.');
const pct = z
	.string()
	.trim()
	.regex(/^\d{1,3}(\.\d{1,2})?$/, 'Enter a percentage with up to 2 decimals.')
	.transform(poishaOf)
	.refine((bp) => bp >= 1 && bp <= 10_000, 'Enter a percentage from 0.01 to 100.');
const id = (error: string) => z.uuid({ error });
const cycleId = id('Choose a pay review.');

const cycleSchema = z.object({
	name: words(80, 'Name the pay review.', 'Keep the name under 80 characters.'),
	effectiveFrom: z.iso
		.date('Enter the date the new salaries start.')
		.refine((d) => d >= '2000-01-01' && d <= '2099-12-31', 'Enter a date between 2000 and 2099.'),
	guideline: z.union([z.literal(''), pct]).transform((v) => (v === '' ? null : v))
});
const budgetSchema = z.object({
	cycleId,
	departmentId: id('Choose a department.'),
	budget: z
		.string()
		.trim()
		.regex(/^\d{1,7}(\.\d{1,2})?$/, 'Enter the budget, up to 2 decimals.')
		.transform(poishaOf)
});
const proposalSchema = z.object({
	cycleId,
	employeeId: id('Choose an employee.'),
	pct,
	reason: words(200, 'Say why.', 'Keep the reason under 200 characters.')
});
const pickSchema = z.object({ cycleId, employeeId: id('Choose an employee.') });

export function raiseSalary(components: Component[], gross: number, current: Line[], bp: number) {
	const byId = new Map(components.map((c) => [c.id, c]));
	if (current.some((l) => !byId.has(l.componentId)))
		throw new AppError('component_gone', 'A pay component in this salary is no longer active.', 409);
	const basic = components.find((c) => c.code === 'BASIC');
	if (!basic) throw new AppError('no_basic', 'The basic pay component is not active.', 409);
	const scale = (v: number) => Math.round((v * (10_000 + bp)) / 10_000);
	const values = new Map<string, number>();
	let fixed = 0;
	let pctTotal = 0;
	for (const l of current) {
		const c = byId.get(l.componentId)!;
		if (c.id === basic.id) continue;
		const earning = c.kind === 'earning';
		const value = earning && c.calc === 'fixed' ? scale(l.value) : l.value;
		values.set(c.id, value);
		if (earning && c.calc === 'fixed') fixed += value;
		if (earning && c.calc === 'pct_basic') pctTotal += value;
	}
	values.set(basic.id, Math.round(((scale(gross) - fixed) * 10_000) / (10_000 + pctTotal)));
	const raised = resolveLines(components, values);
	if (raised.gross > COMP.maxPay) throw new AppError('too_large', 'The new salary is too large.', 409);
	return raised;
}

async function lockedCycle(tx: Tx, cycle: string, strength: 'share' | 'update') {
	const [c] = await tx.select().from(compCycles).where(eq(compCycles.id, cycle)).for(strength);
	if (!c) throw missing();
	if (c.status !== 'open') throw new AppError('closed', 'This pay review is closed.', 409);
	return c;
}

export async function createCycle(m: Member, raw: Record<string, string>) {
	if (!can(m.access, 'comp.manage')) throw forbidden();
	const input = cycleSchema.parse(raw);
	return withTenant(compCtx(m), async (tx) => {
		const [c] = await tx
			.insert(compCycles)
			.values({
				tenantId: m.tenant.id,
				name: input.name,
				effectiveFrom: input.effectiveFrom,
				guidelineBp: input.guideline,
				createdByUserId: m.user.userId
			})
			.returning({ id: compCycles.id })
			.catch((err) => {
				if (pgCode(err) === UNIQUE_VIOLATION)
					throw new AppError('duplicate', 'A pay review with that name already exists.', 409);
				throw err;
			});
		return c.id;
	});
}

export async function closeCycle(m: Member, raw: Record<string, string>) {
	if (!can(m.access, 'comp.manage')) throw forbidden();
	const input = z.object({ cycleId }).parse(raw);
	await withTenant(compCtx(m), async (tx) => {
		const c = await lockedCycle(tx, input.cycleId, 'update');
		await tx.update(compCycles).set({ status: 'closed' }).where(eq(compCycles.id, c.id));
	});
}

export async function setBudget(m: Member, raw: Record<string, string>) {
	if (!can(m.access, 'comp.manage')) throw forbidden();
	const input = budgetSchema.parse(raw);
	await withTenant(compCtx(m), async (tx) => {
		const c = await lockedCycle(tx, input.cycleId, 'share');
		const [d] = await tx.select({ id: departments.id }).from(departments).where(eq(departments.id, input.departmentId));
		if (!d) throw new AppError('not_found', 'That department does not exist.', 404);
		await tx
			.insert(compBudgets)
			.values({ tenantId: m.tenant.id, cycleId: c.id, departmentId: d.id, budget: input.budget })
			.onConflictDoUpdate({
				target: [compBudgets.tenantId, compBudgets.cycleId, compBudgets.departmentId],
				set: { budget: input.budget }
			});
	});
}

async function proposable(tx: Tx, m: Member, employeeId: string) {
	if (employeeId === m.access.employeeId) throw noEmployee();
	if (!inScope(await resolveScope(tx, m.access, 'comp.propose'), employeeId)) throw noEmployee();
	const [e] = await tx.select().from(employees).where(eq(employees.id, employeeId));
	if (!e) throw noEmployee();
	if (e.status === 'exited') throw new AppError('exited', `${e.fullName} has left.`, 409);
	return e;
}

export async function propose(m: Member, raw: Record<string, string>) {
	if (!can(m.access, 'comp.propose')) throw forbidden();
	const input = proposalSchema.parse(raw);
	await withTenant(compCtx(m), async (tx) => {
		const c = await lockedCycle(tx, input.cycleId, 'share');
		const e = await proposable(tx, m, input.employeeId);
		const [salary] = await tx
			.select()
			.from(employeeSalaries)
			.where(and(eq(employeeSalaries.employeeId, e.id), isNull(employeeSalaries.effectiveTo)));
		if (!salary) throw new AppError('no_salary', `${e.fullName} has no salary yet.`, 409);
		const lines = await tx.select().from(employeeSalaryLines).where(eq(employeeSalaryLines.salaryId, salary.id));
		const raised = raiseSalary(await salaryComponents(tx), salary.gross, lines, input.pct);
		const [before] = await tx
			.select({ status: compProposals.status, change: salaryChanges.status })
			.from(compProposals)
			.leftJoin(salaryChanges, eq(salaryChanges.id, compProposals.salaryChangeId))
			.where(and(eq(compProposals.cycleId, c.id), eq(compProposals.employeeId, e.id)))
			.for('update', { of: compProposals });
		if (before?.status === 'applied' && before.change !== 'rejected')
			throw new AppError('applied', `The raise for ${e.fullName} is already applied.`, 409);
		const values = {
			status: 'proposed' as const,
			salaryChangeId: null,
			currentGross: salary.gross,
			changeBp: input.pct,
			proposedGross: raised.gross,
			reason: input.reason,
			proposedByUserId: m.user.userId
		};
		await tx
			.insert(compProposals)
			.values({ tenantId: m.tenant.id, cycleId: c.id, employeeId: e.id, ...values })
			.onConflictDoUpdate({
				target: [compProposals.tenantId, compProposals.cycleId, compProposals.employeeId],
				set: values
			});
	});
}

export async function clearProposal(m: Member, raw: Record<string, string>) {
	if (!can(m.access, 'comp.propose')) throw forbidden();
	const input = pickSchema.parse(raw);
	await withTenant(compCtx(m), async (tx) => {
		const c = await lockedCycle(tx, input.cycleId, 'share');
		const e = await proposable(tx, m, input.employeeId);
		const gone = await tx
			.delete(compProposals)
			.where(
				and(eq(compProposals.cycleId, c.id), eq(compProposals.employeeId, e.id), eq(compProposals.status, 'proposed'))
			)
			.returning({ id: compProposals.id });
		if (!gone.length) throw new AppError('not_found', `There is no open proposal for ${e.fullName}.`, 404);
	});
}

export async function applyCycle(m: Member, raw: Record<string, string>) {
	if (!can(m.access, 'comp.manage') || !can(m.access, 'salary.update')) throw forbidden();
	const input = z.object({ cycleId }).parse(raw);
	return withTenant(compCtx(m), async (tx) => {
		const c = await lockedCycle(tx, input.cycleId, 'update');
		const rows = await tx
			.select({ p: compProposals, name: employees.fullName, status: employees.status, joinDate: employees.joinDate })
			.from(compProposals)
			.innerJoin(employees, eq(employees.id, compProposals.employeeId))
			.where(and(eq(compProposals.cycleId, c.id), eq(compProposals.status, 'proposed')))
			.orderBy(asc(employees.fullName))
			.for('update', { of: compProposals });
		const failures: { name: string; message: string }[] = [];
		if (!rows.length) return { applied: 0, failures };
		const ids = rows.map((r) => r.p.employeeId);
		const open = new Map(
			(
				await tx
					.select()
					.from(employeeSalaries)
					.where(and(inArray(employeeSalaries.employeeId, ids), isNull(employeeSalaries.effectiveTo)))
			).map((s) => [s.employeeId, s])
		);
		const latest = new Map(
			(
				await tx
					.select({ employeeId: employeeSalaries.employeeId, from: max(employeeSalaries.effectiveFrom) })
					.from(employeeSalaries)
					.where(inArray(employeeSalaries.employeeId, ids))
					.groupBy(employeeSalaries.employeeId)
			).map((l) => [l.employeeId, l.from])
		);
		const salaryIds = [...open.values()].map((s) => s.id);
		const lines = salaryIds.length
			? await tx.select().from(employeeSalaryLines).where(inArray(employeeSalaryLines.salaryId, salaryIds))
			: [];
		const waiting = new Set(
			(
				await tx
					.select({ employeeId: salaryChanges.employeeId })
					.from(salaryChanges)
					.where(and(eq(salaryChanges.status, 'pending'), inArray(salaryChanges.employeeId, ids)))
			).map((w) => w.employeeId)
		);
		const components = await salaryComponents(tx);
		const updateScope = await resolveScope(tx, m.access, 'salary.update');
		const changes: (typeof salaryChanges.$inferInsert)[] = [];
		const names = new Map(rows.map((r) => [r.p.employeeId, r.name]));
		for (const r of rows) {
			const e = r.p.employeeId;
			const s = open.get(e);
			const from = latest.get(e);
			const problem =
				e === m.access.employeeId
					? 'You cannot apply your own raise.'
					: !inScope(updateScope, e)
						? 'You cannot change this salary.'
						: r.status === 'exited'
							? 'They have left.'
							: waiting.has(e)
								? 'A salary change is already waiting for approval.'
								: c.effectiveFrom < r.joinDate
									? `The review starts before they joined on ${r.joinDate}.`
									: !s || s.gross !== r.p.currentGross
										? 'The salary changed after this proposal. Save the proposal again.'
										: from && from >= c.effectiveFrom
											? `The new salary must start after ${from}.`
											: null;
			if (problem) {
				failures.push({ name: r.name, message: problem });
				continue;
			}
			try {
				const raised = raiseSalary(
					components,
					s!.gross,
					lines.filter((l) => l.salaryId === s!.id),
					r.p.changeBp
				);
				changes.push({
					tenantId: m.tenant.id,
					employeeId: e,
					effectiveFrom: c.effectiveFrom,
					reason: `${c.name}: ${r.p.reason}`,
					lines: raised.lines,
					gross: raised.gross,
					requestedByUserId: m.user.userId
				});
			} catch (err) {
				if (!(err instanceof AppError)) throw err;
				failures.push({ name: r.name, message: err.message });
			}
		}
		const made = changes.length
			? await tx
					.insert(salaryChanges)
					.values(changes)
					.onConflictDoNothing()
					.returning({ employeeId: salaryChanges.employeeId })
			: [];
		const done = new Set(made.map((x) => x.employeeId));
		for (const ch of changes)
			if (!done.has(ch.employeeId))
				failures.push({ name: names.get(ch.employeeId)!, message: 'A salary change is already waiting for approval.' });
		if (done.size)
			await tx
				.update(compProposals)
				.set({
					status: 'applied',
					salaryChangeId: sql`(select ${salaryChanges.id} from ${salaryChanges} where ${salaryChanges.employeeId} = ${compProposals.employeeId} and ${salaryChanges.status} = 'pending')`
				})
				.where(and(eq(compProposals.cycleId, c.id), inArray(compProposals.employeeId, [...done])));
		return { applied: done.size, failures };
	});
}

const viewer = (m: Member) => {
	const manage = can(m.access, 'comp.manage');
	const proposer = can(m.access, 'comp.propose');
	if (!manage && !proposer) throw forbidden();
	return { manage, proposer };
};

export async function cyclesPage(m: Member) {
	const { manage } = viewer(m);
	return withTenant(compCtx(m), async (tx) => ({
		manage,
		cycles: await tx
			.select({
				id: compCycles.id,
				name: compCycles.name,
				effectiveFrom: compCycles.effectiveFrom,
				status: compCycles.status,
				guidelineBp: compCycles.guidelineBp
			})
			.from(compCycles)
			.orderBy(desc(compCycles.effectiveFrom), asc(compCycles.name))
			.limit(COMP.cycles)
	}));
}

export async function cyclePage(m: Member, cycle: string, q = '') {
	const { manage, proposer } = viewer(m);
	if (!z.uuid().safeParse(cycle).success) throw missing();
	return withTenant(compCtx(m), async (tx) => {
		const [c] = await tx.select().from(compCycles).where(eq(compCycles.id, cycle));
		if (!c) throw missing();
		const none: ScopeSet = { kind: 'ids', ids: [] };
		const edit = proposer ? await resolveScope(tx, m.access, 'comp.propose') : none;
		const view: ScopeSet = manage ? { kind: 'all' } : edit;
		const pay = await resolveScope(tx, m.access, 'salary.read');
		const money = manage && pay.kind === 'all';
		const search = q.trim().slice(0, 100);
		const people = await tx
			.select({
				id: employees.id,
				name: employees.fullName,
				code: employees.code,
				departmentId: employees.departmentId
			})
			.from(employees)
			.where(
				and(
					ne(employees.status, 'exited'),
					scopeWhere(view, employees.id),
					search ? ilike(employees.fullName, `%${likeEscape(search)}%`) : sql`true`,
					m.access.employeeId ? ne(employees.id, m.access.employeeId) : sql`true`
				)
			)
			.orderBy(asc(employees.fullName))
			.limit(COMP.rows + 1);
		const shown = people.slice(0, COMP.rows);
		const ids = shown.map((p) => p.id);
		const salaries = new Map(
			ids.length
				? (
						await tx
							.select({ employeeId: employeeSalaries.employeeId, gross: employeeSalaries.gross })
							.from(employeeSalaries)
							.where(and(inArray(employeeSalaries.employeeId, ids), isNull(employeeSalaries.effectiveTo)))
					).map((s) => [s.employeeId, s.gross])
				: []
		);
		const proposals = new Map(
			ids.length
				? (
						await tx
							.select({ p: compProposals, change: salaryChanges.status })
							.from(compProposals)
							.leftJoin(salaryChanges, eq(salaryChanges.id, compProposals.salaryChangeId))
							.where(and(eq(compProposals.cycleId, c.id), inArray(compProposals.employeeId, ids)))
					).map((r) => [r.p.employeeId, { ...r.p, change: r.change }])
				: []
		);
		const depts = await tx
			.select({ id: departments.id, name: departments.name })
			.from(departments)
			.orderBy(asc(departments.name));
		const deptName = new Map(depts.map((d) => [d.id, d.name]));
		const budgets = money
			? new Map(
					(await tx.select().from(compBudgets).where(eq(compBudgets.cycleId, c.id))).map((b) => [
						b.departmentId,
						b.budget
					])
				)
			: new Map<string, number>();
		const used = money
			? new Map(
					(
						await tx
							.select({
								departmentId: employees.departmentId,
								used: sql<number>`sum(${compProposals.proposedGross} - ${compProposals.currentGross})`.mapWith(Number)
							})
							.from(compProposals)
							.innerJoin(employees, eq(employees.id, compProposals.employeeId))
							.leftJoin(salaryChanges, eq(salaryChanges.id, compProposals.salaryChangeId))
							.where(and(eq(compProposals.cycleId, c.id), sql`${salaryChanges.status} is distinct from 'rejected'`))
							.groupBy(employees.departmentId)
					).map((u) => [u.departmentId, u.used])
				)
			: new Map<string | null, number>();
		const open = c.status === 'open';
		return {
			cycle: { id: c.id, name: c.name, effectiveFrom: c.effectiveFrom, status: c.status, guidelineBp: c.guidelineBp },
			manage,
			money,
			q: search,
			canApply: manage && can(m.access, 'salary.update') && open,
			truncated: people.length > COMP.rows,
			departments: depts,
			budgets: money
				? [
						...depts
							.filter((d) => budgets.has(d.id) || used.has(d.id))
							.map((d) => ({ ...d, budget: budgets.get(d.id) ?? null, used: used.get(d.id) ?? 0 })),
						...(used.has(null) ? [{ id: 'none', name: 'No department', budget: null, used: used.get(null)! }] : [])
					]
				: [],
			rows: shown.map((p) => {
				const gross = salaries.get(p.id);
				const pr = proposals.get(p.id);
				const seesPay = inScope(pay, p.id);
				const state = pr?.status === 'applied' ? (pr.change ?? 'pending') : 'proposed';
				return {
					id: p.id,
					name: p.name,
					code: p.code,
					department: (p.departmentId && deptName.get(p.departmentId)) || null,
					hasSalary: gross !== undefined,
					currentGross: seesPay ? (gross ?? null) : null,
					proposal: pr
						? {
								changeBp: pr.changeBp,
								reason: pr.reason,
								status: state,
								proposedGross: seesPay ? pr.proposedGross : null,
								stale: pr.status === 'proposed' && gross !== pr.currentGross
							}
						: null,
					canEdit: open && gross !== undefined && inScope(edit, p.id) && (state === 'proposed' || state === 'rejected')
				};
			})
		};
	});
}
