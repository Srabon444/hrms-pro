import { and, asc, eq, lte } from 'drizzle-orm';
import { z } from 'zod';
import { weekStartOf } from '../domain/workplan/rollover';
import { now } from './clock';
import { addDays, dateIn } from './dates';
import { employeeHistory, employees, memberships, tenantSettings } from './db/schema';
import { AppError } from './errors';
import { notify, sendAll } from './notifications';
import { userCtx, type Access, type requireMember } from './rbac/access';
import { inScope, resolveScope, scopeWhere } from './rbac/scope';
import { withTenant, type Tx } from './tenancy';

type Member = ReturnType<typeof requireMember>;

export const PROBATION_WINDOW_DAYS = 30;

export async function tenantToday(tx: Tx): Promise<string> {
	const [s] = await tx.select({ tz: tenantSettings.timezone }).from(tenantSettings);
	return dateIn(now(), s?.tz ?? 'UTC');
}

export async function tenantWeeks(tx: Tx) {
	const [s] = await tx
		.select({ tz: tenantSettings.timezone, weekend: tenantSettings.weekendDays })
		.from(tenantSettings);
	const weekend = s?.weekend ?? [5, 6];
	const today = dateIn(now(), s?.tz ?? 'UTC');
	const of = (d: string) => weekStartOf(d, weekend);
	return { of, today, current: of(today) };
}

export async function probationDue(tx: Tx, access: Access) {
	const scope = await resolveScope(tx, access, 'employee.update');
	const today = await tenantToday(tx);
	const rows = await tx
		.select({
			id: employees.id,
			code: employees.code,
			fullName: employees.fullName,
			probationEndDate: employees.probationEndDate
		})
		.from(employees)
		.where(
			and(
				eq(employees.status, 'probation'),
				lte(employees.probationEndDate, addDays(today, PROBATION_WINDOW_DAYS)),
				scopeWhere(scope, employees.id)
			)
		)
		.orderBy(asc(employees.probationEndDate), asc(employees.code))
		.limit(200);
	return { today, rows: rows.map((r) => ({ ...r, overdue: !!r.probationEndDate && r.probationEndDate < today })) };
}

const probationSchema = z.discriminatedUnion('decision', [
	z.object({ decision: z.literal('confirm'), date: z.iso.date('Enter the confirmation date.') }),
	z.object({ decision: z.literal('extend'), date: z.iso.date('Enter the new probation end date.') })
]);

export async function decideProbation(m: Member, employeeId: string, raw: Record<string, string>) {
	const input = probationSchema.parse(raw);
	const mails = await withTenant(userCtx(m), async (tx) => {
		const target = z.uuid().safeParse(employeeId);
		const [e] = target.success
			? await tx.select().from(employees).where(eq(employees.id, target.data)).for('update')
			: [];
		if (!e || !inScope(await resolveScope(tx, m.access, 'employee.read'), e.id))
			throw new AppError('not_found', 'That employee does not exist.', 404);
		if (!inScope(await resolveScope(tx, m.access, 'employee.update'), e.id))
			throw new AppError('forbidden', 'You cannot change this employee.', 403);
		if (e.status !== 'probation') throw new AppError('not_on_probation', 'This person is not on probation.', 409);
		if (input.date < e.joinDate) throw new AppError('before_join', 'The date cannot be before the join date.', 400);
		const history = { tenantId: m.tenant.id, employeeId: e.id, changedByUserId: m.user.userId };
		if (input.decision === 'confirm') {
			await tx.update(employees).set({ status: 'active', confirmationDate: input.date }).where(eq(employees.id, e.id));
			await tx
				.insert(employeeHistory)
				.values({ ...history, field: 'status', oldValue: 'probation', newValue: 'active' });
		} else {
			if (e.probationEndDate && input.date <= e.probationEndDate)
				throw new AppError('not_later', 'The new end date must be after the current one.', 400);
			await tx.update(employees).set({ probationEndDate: input.date }).where(eq(employees.id, e.id));
			await tx.insert(employeeHistory).values({
				...history,
				field: 'probationEndDate',
				oldValue: e.probationEndDate,
				newValue: input.date
			});
		}
		const owners = await tx.select({ id: memberships.id }).from(memberships).where(eq(memberships.employeeId, e.id));
		return notify(
			tx,
			m.tenant.id,
			owners.map((o) => o.id),
			{
				category: 'profile',
				title:
					input.decision === 'confirm' ? 'Your employment is confirmed' : `Your probation now ends on ${input.date}`,
				link: `employees/${e.id}`
			},
			m.tenant.slug
		);
	});
	await sendAll(mails);
}
