import { describe, expect, it } from 'vitest';
import { canGrant, covers, holdsRestricted, toGrantMap } from './grants';

describe('grant map', () => {
	it('unions scopes from several roles instead of keeping only the widest', () => {
		const map = toGrantMap([
			{ permission: 'leave.approve', scope: 'team' },
			{ permission: 'leave.approve', scope: 'department' },
			{ permission: 'leave.approve', scope: 'team' },
			{ permission: 'leave.read', scope: 'own' }
		]);
		expect(map['leave.approve']).toEqual(['team', 'department']);
		expect(map['leave.read']).toEqual(['own']);
	});

	it('all covers every scope, team and department cover own, but not each other', () => {
		expect(covers(['all'], 'department')).toBe(true);
		expect(covers(['team'], 'own')).toBe(true);
		expect(covers(['department'], 'own')).toBe(true);
		expect(covers(['team'], 'department')).toBe(false);
		expect(covers(['department'], 'team')).toBe(false);
		expect(covers(['own'], 'team')).toBe(false);
		expect(covers(undefined, 'own')).toBe(false);
	});

	it('only an owner can hand out restricted permissions, and never wider than held', () => {
		const hr = {
			isOwner: false,
			grants: toGrantMap([
				{ permission: 'leave.approve', scope: 'department' },
				{ permission: 'user.manage', scope: 'all' }
			])
		};
		expect(canGrant(hr, 'leave.approve', 'department')).toBe(true);
		expect(canGrant(hr, 'leave.approve', 'all')).toBe(false);
		expect(canGrant(hr, 'employee.read', 'own')).toBe(false);
		expect(canGrant(hr, 'user.manage', 'all')).toBe(false);
		expect(canGrant({ ...hr, isOwner: true }, 'user.manage', 'all')).toBe(true);
	});

	it('detects restricted permissions among grants', () => {
		expect(holdsRestricted(toGrantMap([{ permission: 'leave.read', scope: 'own' }]))).toBe(false);
		expect(holdsRestricted(toGrantMap([{ permission: 'payroll.read', scope: 'all' }]))).toBe(true);
	});
});
