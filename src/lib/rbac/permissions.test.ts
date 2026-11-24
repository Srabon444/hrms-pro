import { describe, expect, it } from 'vitest';
import { PERMISSIONS, SYSTEM_ROLES, isRestricted } from './permissions';

describe('permission catalog', () => {
	it('has no duplicates or wildcards', () => {
		expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
		expect(PERMISSIONS.filter((p) => p.includes('*'))).toEqual([]);
	});

	it('marks payroll, salary, audit, sensitive and access-control permissions as restricted', () => {
		const restricted = PERMISSIONS.filter(isRestricted);
		expect(restricted).toEqual(
			expect.arrayContaining([
				'payroll.run',
				'salary.read',
				'audit.sensitive',
				'employee.sensitive.read',
				'role.manage',
				'data.export'
			])
		);
		expect(isRestricted('employee.read')).toBe(false);
		expect(isRestricted('leave.approve')).toBe(false);
	});

	it('never gives the employee role a restricted permission or a scope wider than own', () => {
		const employee = SYSTEM_ROLES.find((r) => r.key === 'employee')!;
		expect(employee.grants.filter(([p]) => isRestricted(p))).toEqual([]);
		expect(employee.grants.every(([, s]) => s === 'own')).toBe(true);
	});

	it('keeps payroll maker and checker in different roles', () => {
		const holders = (perm: string) => SYSTEM_ROLES.filter((r) => r.grants.some(([p]) => p === perm)).map((r) => r.key);
		const makers = holders('payroll.run').filter((k) => k !== 'owner');
		const checkers = holders('payroll.approve').filter((k) => k !== 'owner');
		expect(makers.filter((k) => checkers.includes(k))).toEqual([]);
	});

	it('gives the owner every permission at scope all and unique role keys', () => {
		const owner = SYSTEM_ROLES.find((r) => r.key === 'owner')!;
		expect(owner.grants).toHaveLength(PERMISSIONS.length);
		expect(new Set(SYSTEM_ROLES.map((r) => r.key)).size).toBe(SYSTEM_ROLES.length);
		for (const r of SYSTEM_ROLES) expect(new Set(r.grants.map(([p, s]) => `${p}:${s}`)).size).toBe(r.grants.length);
	});
});
