import { and, asc, count, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { moduleOn } from '../modules';
import { authPool } from './db';
import { containsPattern } from './db/like';
import { branches, departments, designations, employees, memberships, tenants } from './db/schema';
import { log } from './log';
import { moduleOverrides } from './modules';
import { notify, sendAll } from './notifications';
import type { Access } from './rbac/access';
import { inScope, resolveScope } from './rbac/scope';
import { claimDay, tenantToday } from './lifecycle';
import { systemCtx, withTenant, type TenantCtx, type Tx } from './tenancy';

export const LISTED_STATUSES = ['probation', 'active', 'notice'] as const;
export const DIRECTORY_PAGE_SIZE = 50;
export const CHART_CHILDREN = 200;
export const CHART_MAX_HOPS = 20;
export const CELEBRATION_DAYS = 7;

const LISTED = sql.raw(`(${LISTED_STATUSES.map((s) => `'${s}'`).join(',')})`);
const manager = alias(employees, 'manager');

export const directorySchema = z.object({
	q: z.string().trim().max(100).catch(''),
	page: z.coerce.number().int().min(1).max(10_000).catch(1)
});

export async function listDirectory(tx: Tx, access: Access, raw: Record<string, string | null>) {
	const f = directorySchema.parse(raw);
	const birthdays = moduleOn(await moduleOverrides(tx), 'celebrations_birthdays');
	const where: SQL[] = [inArray(employees.status, LISTED_STATUSES)];
	if (f.q) {
		const like = containsPattern(f.q);
		where.push(or(ilike(employees.fullName, like), ilike(designations.name, like), ilike(departments.name, like))!);
	}
	const filter = and(...where);
	const [rows, [{ total }], scope] = await Promise.all([
		tx
			.select({
				id: employees.id,
				name: employees.fullName,
				designation: designations.name,
				department: departments.name,
				branch: branches.name,
				manager: manager.fullName,
				joinDate: employees.joinDate,
				workEmail: employees.workEmail,
				birthday: birthdays
					? sql<string | null>`case when ${employees.showBirthday} then to_char(${employees.dateOfBirth}, 'MM-DD') end`
					: sql<string | null>`null`
			})
			.from(employees)
			.leftJoin(designations, eq(designations.id, employees.designationId))
			.leftJoin(departments, eq(departments.id, employees.departmentId))
			.leftJoin(branches, eq(branches.id, employees.branchId))
			.leftJoin(manager, eq(manager.id, employees.managerId))
			.where(filter)
			.orderBy(asc(employees.fullName), asc(employees.id))
			.limit(DIRECTORY_PAGE_SIZE)
			.offset((f.page - 1) * DIRECTORY_PAGE_SIZE),
		tx
			.select({ total: count() })
			.from(employees)
			.leftJoin(designations, eq(designations.id, employees.designationId))
			.leftJoin(departments, eq(departments.id, employees.departmentId))
			.where(filter),
		resolveScope(tx, access, 'employee.read')
	]);
	const me = access.employeeId
		? (
				await tx
					.select({ showBirthday: employees.showBirthday })
					.from(employees)
					.where(eq(employees.id, access.employeeId))
			)[0]
		: undefined;
	return {
		filters: f,
		rows: rows.map((r) => ({ ...r, canOpen: inScope(scope, r.id) })),
		total,
		pages: Math.max(1, Math.ceil(total / DIRECTORY_PAGE_SIZE)),
		birthdays,
		showBirthday: birthdays && me ? me.showBirthday : null
	};
}

export type ChartNode = {
	id: string;
	name: string;
	designation: string | null;
	managerId: string | null;
	reports: number;
	siblings: number;
};

const ROOT = sql`not exists (select 1 from employees m where m.id = x.manager_id and m.status in ${LISTED})`;

const chartNodes = (tx: Tx, where: SQL, perManager: boolean, include: string[] = []) => {
	const window = perManager ? sql`partition by x.manager_id` : sql``;
	return tx.execute<ChartNode>(sql`
		select e.id, e.full_name as name, d.name as designation, e.manager_id as "managerId", e.siblings,
			(select count(*)::int from employees r where r.manager_id = e.id and r.status in ${LISTED}) as reports
		from (
			select x.*, row_number() over (${window} order by x.full_name, x.id) as rn,
				(count(*) over (${window}))::int as siblings
			from employees x where x.status in ${LISTED} and ${where}
		) e
		left join designations d on d.id = e.designation_id
		where e.rn <= ${CHART_CHILDREN}${include.length ? sql` or e.id in ${include}` : sql``}
		order by e.full_name, e.id`);
};

export const chartRoots = (tx: Tx) => chartNodes(tx, ROOT, false);

export const chartChildren = (tx: Tx, managerIds: string[]) =>
	managerIds.length ? chartNodes(tx, sql`x.manager_id in ${managerIds}`, true) : Promise.resolve([] as ChartNode[]);

export async function chartStart(tx: Tx) {
	const roots = [...(await chartRoots(tx))];
	return {
		roots,
		children: [
			...(await chartChildren(
				tx,
				roots.map((r) => r.id)
			))
		]
	};
}

export async function chartPathTo(tx: Tx, employeeId: string) {
	const chain = await tx.execute<{ id: string }>(sql`
		with recursive up(id, manager_id, depth, path) as (
			select id, manager_id, 0, array[id] from employees where id = ${employeeId}::uuid and status in ${LISTED}
			union all
			select e.id, e.manager_id, u.depth + 1, u.path || e.id
			from employees e join up u on e.id = u.manager_id
			where u.depth < ${CHART_MAX_HOPS} and not e.id = any(u.path) and e.status in ${LISTED}
		)
		select id from up order by depth desc`);
	const ids = chain.map((r) => r.id);
	if (!ids.length) return { chain: ids, top: null, children: [] };
	const managers = ids.slice(0, -1);
	const [top, children] = await Promise.all([
		chartNodes(tx, sql`x.id = ${ids[0]}::uuid and ${ROOT}`, false),
		managers.length ? chartNodes(tx, sql`x.manager_id in ${managers}`, true, ids) : Promise.resolve([] as ChartNode[])
	]);
	return { chain: ids, top: top[0] ?? null, children: [...children] };
}

export type DepartmentNode = { id: string; name: string; people: number; subDepartments: number };

export async function departmentLevel(tx: Tx, departmentId: string | null) {
	const [units, people] = await Promise.all([
		tx
			.select({
				id: departments.id,
				name: departments.name,
				people: sql<number>`(select count(*)::int from employees e where e.department_id = departments.id and e.status in ${LISTED})`,
				subDepartments: sql<number>`(select count(*)::int from departments s where s.parent_id = departments.id)`
			})
			.from(departments)
			.where(departmentId ? eq(departments.parentId, departmentId) : isNull(departments.parentId))
			.orderBy(asc(departments.name)),
		departmentId
			? chartNodes(tx, sql`x.department_id = ${departmentId}::uuid`, false)
			: Promise.resolve([] as ChartNode[])
	]);
	return { departments: units as DepartmentNode[], people: [...people] };
}

export type Celebration = {
	date: string;
	kind: 'anniversary' | 'birthday';
	employeeId: string;
	name: string;
	years: number | null;
	managerId: string | null;
};

export async function celebrations(tx: Tx, from: string, days: number, birthdays: boolean): Promise<Celebration[]> {
	const onDay = (col: SQL) => sql`
		case when to_char(${col}, 'MM-DD') = '02-29'
			and extract(day from make_date(extract(year from g.d)::int, 3, 1) - 1) <> 29
		then '02-28' else to_char(${col}, 'MM-DD') end = to_char(g.d, 'MM-DD')`;
	const rows = await tx.execute<Celebration>(sql`
		select to_char(g.d, 'YYYY-MM-DD') as date, c.kind, e.id as "employeeId", e.full_name as name,
			case when c.kind = 'anniversary' then (extract(year from g.d) - extract(year from e.join_date))::int end as years,
			e.manager_id as "managerId"
		from (select ${from}::date + n as d from generate_series(0, ${days - 1}) as n) as g
		cross join (values ('anniversary'), ('birthday')) as c(kind)
		join employees e on e.status in ${LISTED} and (
			(c.kind = 'anniversary' and e.join_date < g.d and ${onDay(sql`e.join_date`)})
			or (c.kind = 'birthday' and ${birthdays} and e.show_birthday and e.date_of_birth is not null
				and ${onDay(sql`e.date_of_birth`)})
		)
		order by g.d, e.full_name, c.kind`);
	return [...rows];
}

export async function weekCelebrations(tx: Tx, today: string) {
	const s = await moduleOverrides(tx);
	if (!moduleOn(s, 'directory')) return null;
	return celebrations(tx, today, CELEBRATION_DAYS, moduleOn(s, 'celebrations_birthdays'));
}

export async function setShowBirthday(ctx: TenantCtx, access: Access, show: boolean) {
	if (!access.employeeId) return;
	await withTenant(ctx, async (tx) => {
		if (!moduleOn(await moduleOverrides(tx), 'celebrations_birthdays')) return;
		await tx.update(employees).set({ showBirthday: show }).where(eq(employees.id, access.employeeId!));
	});
}

const celebrationLine = (c: Celebration) =>
	c.kind === 'birthday' ? `${c.name}: birthday` : `${c.name}: ${c.years} year${c.years === 1 ? '' : 's'} with us`;

export async function notifyCelebrations(tenantId: string, slug: string) {
	const mails = await withTenant(systemCtx(tenantId), async (tx) => {
		const today = await tenantToday(tx);
		if (!(await claimDay(tx, tenantId, 'celebrations_day', today))) return [];
		const s = await moduleOverrides(tx);
		if (!moduleOn(s, 'directory')) return [];
		const due = (await celebrations(tx, today, 1, moduleOn(s, 'celebrations_birthdays'))).filter((c) => c.managerId);
		if (!due.length) return [];
		const managers = await tx
			.select({ employeeId: memberships.employeeId, membershipId: memberships.id })
			.from(memberships)
			.where(
				and(
					inArray(memberships.employeeId, [...new Set(due.map((c) => c.managerId!))]),
					eq(memberships.status, 'active')
				)
			);
		const sent = await Promise.all(
			managers.map((mgr) => {
				const lines = due.filter((c) => c.managerId === mgr.employeeId).map(celebrationLine);
				return notify(
					tx,
					tenantId,
					[mgr.membershipId],
					{
						category: 'celebrations',
						title: `Celebrations in your team today`,
						body: lines.join('\n'),
						link: 'directory'
					},
					slug
				);
			})
		);
		return sent.flat();
	});
	await sendAll(mails);
}

export async function runCelebrations() {
	const list = await authPool()
		.db.select({ id: tenants.id, slug: tenants.slug })
		.from(tenants)
		.where(eq(tenants.status, 'active'));
	await list.reduce<Promise<void>>(
		(prior, t) =>
			prior.then(() =>
				notifyCelebrations(t.id, t.slug).catch((err) =>
					log.error({ tenantId: t.id, err: (err as Error).message }, 'celebration notices failed')
				)
			),
		Promise.resolve()
	);
}
