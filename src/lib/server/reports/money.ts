import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { mealCharge, taka } from '../../money';
import {
	departments,
	employees,
	expenseCategories,
	expenseClaims,
	expenseItems,
	mealOrders,
	mealTypes,
	mealVendors,
	payrollRuns,
	payslips
} from '../db/schema';
import { scopeWhere } from '../rbac/scope';
import { add, amount, byDepartment, departmentColumn, inTaka, personColumns, type Tally } from './groups';
import type { Cell, Column, ReportDef, Row, Section } from './types';

export const MIN_PAYROLL_GROUP = 5;

const AMOUNTS = [
	['gross', 'Gross'],
	['deductions', 'Deductions'],
	['tax', 'Tax'],
	['net', 'Net']
] as const;

type Amounts = Record<(typeof AMOUNTS)[number][0], number>;
type Group = Amounts & { people: Set<string> };

const amountColumns: Column[] = [
	{ key: 'employees', label: 'Employees', numeric: true },
	...AMOUNTS.map(([key, label]) => ({ key, label, numeric: true as const }))
];

const newGroup = (): Group => ({ gross: 0, deductions: 0, tax: 0, net: 0, people: new Set() });

function totals(g: Group, open: boolean): Record<string, Cell> {
	if (!open && g.people.size < MIN_PAYROLL_GROUP)
		return { employees: `<${MIN_PAYROLL_GROUP}`, gross: null, deductions: null, tax: null, net: null };
	return { employees: g.people.size, ...Object.fromEntries(AMOUNTS.map(([k]) => [k, taka(g[k])])) };
}

function groupOf<G>(groups: Map<string, G>, key: string, make: () => G) {
	if (!groups.has(key)) groups.set(key, make());
	return groups.get(key)!;
}

export const payrollCostReport: ReportDef = {
	id: 'payroll',
	title: 'Payroll cost',
	permission: 'report.payroll',
	sensitive: true,
	async build(tx, { scope, params: { from, to, departmentId } }) {
		const slips = await tx
			.select({
				employeeId: payslips.employeeId,
				name: employees.fullName,
				code: employees.code,
				department: departments.name,
				period: payrollRuns.period,
				gross: payslips.gross,
				deductions: payslips.deductions,
				tax: payslips.tax,
				net: payslips.net
			})
			.from(payslips)
			.innerJoin(payrollRuns, eq(payrollRuns.id, payslips.runId))
			.innerJoin(employees, eq(employees.id, payslips.employeeId))
			.leftJoin(departments, eq(departments.id, employees.departmentId))
			.where(
				and(
					scopeWhere(scope, employees.id),
					departmentId ? eq(employees.departmentId, departmentId) : undefined,
					inArray(payrollRuns.status, ['approved', 'paid']),
					gte(payrollRuns.period, from.slice(0, 7)),
					lte(payrollRuns.period, to.slice(0, 7)),
					isNull(payslips.error)
				)
			)
			.orderBy(asc(employees.fullName), asc(employees.code), asc(payrollRuns.period));
		const open = scope.kind === 'all';
		const byDepartment = new Map<string, Group>();
		const byMonth = new Map<string, Group>();
		const byEmployee = new Map<string, Group & { name: string; code: string; department: string | null }>();
		const all = newGroup();
		for (const s of slips) {
			const person = () => ({ ...newGroup(), name: s.name, code: s.code, department: s.department });
			for (const g of [
				groupOf(byDepartment, s.department ?? 'No department', newGroup),
				groupOf(byMonth, s.period, newGroup),
				groupOf(byEmployee, s.employeeId, person),
				all
			]) {
				for (const [k] of AMOUNTS) g[k] += s[k];
				g.people.add(s.employeeId);
			}
		}
		const sorted = (m: Map<string, Group>) => [...m].sort(([a], [b]) => a.localeCompare(b));
		const sections: Section[] = [
			{
				key: 'departments',
				title: 'By department',
				columns: [{ key: 'department', label: 'Department' }, ...amountColumns],
				rows: [
					...sorted(byDepartment).map(([department, g]) => ({ cells: { department, ...totals(g, open) } })),
					{ cells: { department: 'All departments', ...totals(all, open) } }
				]
			},
			{
				key: 'months',
				title: 'By month',
				columns: [{ key: 'month', label: 'Month' }, ...amountColumns],
				rows: sorted(byMonth).map(([month, g]) => ({ cells: { month, ...totals(g, open) } }))
			}
		];
		if (open)
			sections.push({
				key: 'employees',
				title: 'By employee',
				columns: [
					{ key: 'name', label: 'Name' },
					{ key: 'code', label: 'Code' },
					{ key: 'department', label: 'Department' },
					...AMOUNTS.map(([key, label]) => ({ key, label, numeric: true as const }))
				],
				rows: [...byEmployee].map(([employeeId, g]): Row => ({
					employeeId,
					cells: {
						name: g.name,
						code: g.code,
						department: g.department,
						...Object.fromEntries(AMOUNTS.map(([k]) => [k, taka(g[k])]))
					}
				}))
			});
		return sections;
	}
};

type PersonTally = { id: string; name: string; code: string; department: string | null; tally: Tally };

function people<T extends { employeeId: string; name: string; code: string; department: string | null }>(
	rows: T[],
	keys: string[],
	tallyOf: (r: T) => Tally
) {
	const out = new Map<string, PersonTally>();
	for (const r of rows) {
		if (!out.has(r.employeeId))
			out.set(r.employeeId, {
				id: r.employeeId,
				name: r.name,
				code: r.code,
				department: r.department,
				tally: Object.fromEntries(keys.map((k) => [k, 0]))
			});
		add(out.get(r.employeeId)!.tally, tallyOf(r));
	}
	return [...out.values()].sort((a, b) => a.name.localeCompare(b.name) || a.code.localeCompare(b.code));
}

const personRows = (list: PersonTally[]): Row[] =>
	list.map((p) => ({ employeeId: p.id, cells: { name: p.name, code: p.code, department: p.department, ...p.tally } }));

function totalled(groups: Map<string, Tally>, label: string, labelKey: string, keys: string[]): Row[] {
	const total: Tally = Object.fromEntries(keys.map((k) => [k, 0]));
	const rows = [...groups].map(([name, t]) => {
		add(total, t);
		return { cells: { [labelKey]: name, ...t } };
	});
	return [...rows, { cells: { [labelKey]: label, ...total } }];
}

const MEAL_MONEY = ['cost', 'staff', 'company'];

export const mealReport: ReportDef = {
	id: 'meal',
	title: 'Meals',
	permission: 'report.meal',
	async build(tx, { scope, params: { from, to, departmentId } }) {
		const orders = await tx
			.select({
				employeeId: mealOrders.employeeId,
				name: employees.fullName,
				code: employees.code,
				department: departments.name,
				vendor: mealVendors.name,
				meal: mealTypes.name,
				status: mealOrders.status,
				guests: mealOrders.guestQty,
				unitCost: sql<number>`${mealOrders.unitCost}`,
				subsidyPct: sql<number>`${mealOrders.subsidyPct}`
			})
			.from(mealOrders)
			.innerJoin(employees, eq(employees.id, mealOrders.employeeId))
			.leftJoin(departments, eq(departments.id, employees.departmentId))
			.innerJoin(mealTypes, eq(mealTypes.id, mealOrders.mealTypeId))
			.innerJoin(mealVendors, eq(mealVendors.id, mealTypes.vendorId))
			.where(
				and(
					scopeWhere(scope, employees.id),
					departmentId ? eq(employees.departmentId, departmentId) : undefined,
					gte(mealOrders.date, from),
					lte(mealOrders.date, to),
					isNotNull(mealOrders.unitCost)
				)
			)
			.orderBy(asc(mealVendors.name), asc(mealTypes.name));
		const keys = ['plates', 'guests', ...MEAL_MONEY];
		const tallyOf = (o: (typeof orders)[number]): Tally => {
			const plates = o.status === 'ordered' ? 1 : 0;
			const cost = (plates + o.guests) * o.unitCost;
			const staff = mealCharge(plates === 1, o.guests, o.unitCost, o.subsidyPct);
			return { plates, guests: o.guests, cost, staff, company: cost - staff };
		};
		const meals = new Map<string, Tally>();
		for (const o of orders) {
			const key = `${o.vendor} · ${o.meal}`;
			if (!meals.has(key)) meals.set(key, Object.fromEntries(keys.map((k) => [k, 0])));
			add(meals.get(key)!, tallyOf(o));
		}
		const list = people(orders, keys, tallyOf);
		const columns: Column[] = [
			{ key: 'plates', label: 'Plates', numeric: true },
			{ key: 'guests', label: 'Guests', numeric: true },
			amount('cost', 'Cost'),
			amount('staff', 'Staff share'),
			amount('company', 'Company share')
		];
		return [
			{
				key: 'meals',
				title: 'By meal',
				columns: [{ key: 'meal', label: 'Meal' }, ...columns],
				rows: inTaka(totalled(meals, 'All meals', 'meal', keys), MEAL_MONEY)
			},
			{
				key: 'departments',
				title: 'By department',
				columns: [departmentColumn, ...columns],
				rows: inTaka(byDepartment(list, keys), MEAL_MONEY)
			},
			{
				key: 'employees',
				title: 'By employee',
				columns: [...personColumns, ...columns],
				rows: inTaka(personRows(list), MEAL_MONEY)
			}
		];
	}
};

const EXPENSE_MONEY = ['approved', 'paid', 'total'];

export const expenseReport: ReportDef = {
	id: 'expense',
	title: 'Expenses',
	permission: 'report.expense',
	async build(tx, { scope, params: { from, to, departmentId } }) {
		const items = await tx
			.select({
				employeeId: expenseClaims.employeeId,
				name: employees.fullName,
				code: employees.code,
				department: departments.name,
				category: expenseCategories.name,
				status: expenseClaims.status,
				amount: expenseItems.amount
			})
			.from(expenseItems)
			.innerJoin(expenseClaims, eq(expenseClaims.id, expenseItems.claimId))
			.innerJoin(expenseCategories, eq(expenseCategories.id, expenseItems.categoryId))
			.innerJoin(employees, eq(employees.id, expenseClaims.employeeId))
			.leftJoin(departments, eq(departments.id, employees.departmentId))
			.where(
				and(
					scopeWhere(scope, employees.id),
					departmentId ? eq(employees.departmentId, departmentId) : undefined,
					inArray(expenseClaims.status, ['approved', 'paid']),
					gte(expenseItems.spentOn, from),
					lte(expenseItems.spentOn, to)
				)
			)
			.orderBy(asc(expenseCategories.name));
		const tallyOf = (i: (typeof items)[number]): Tally => ({
			items: 1,
			approved: i.status === 'approved' ? i.amount : 0,
			paid: i.status === 'paid' ? i.amount : 0,
			total: i.amount
		});
		const keys = ['items', ...EXPENSE_MONEY];
		const categories = new Map<string, Tally>();
		for (const i of items) {
			if (!categories.has(i.category)) categories.set(i.category, Object.fromEntries(keys.map((k) => [k, 0])));
			add(categories.get(i.category)!, tallyOf(i));
		}
		const list = people(items, keys, tallyOf);
		const columns: Column[] = [
			{ key: 'items', label: 'Items', numeric: true },
			amount('approved', 'Approved, unpaid'),
			amount('paid', 'Paid'),
			amount('total', 'Total')
		];
		return [
			{
				key: 'categories',
				title: 'By category',
				columns: [{ key: 'category', label: 'Category' }, ...columns],
				rows: inTaka(totalled(categories, 'All categories', 'category', keys), EXPENSE_MONEY)
			},
			{
				key: 'departments',
				title: 'By department',
				columns: [departmentColumn, ...columns],
				rows: inTaka(byDepartment(list, keys), EXPENSE_MONEY)
			},
			{
				key: 'employees',
				title: 'By employee',
				columns: [...personColumns, ...columns],
				rows: inTaka(personRows(list), EXPENSE_MONEY)
			}
		];
	}
};
