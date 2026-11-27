import { describe, expect, it } from 'vitest';
import { API_KEY, effectiveGrants, keyGrants } from './api-keys';

const err = (fn: () => unknown) => {
	try {
		fn();
		return 'ok';
	} catch (e) {
		return (e as { code: string }).code;
	}
};

describe('API key grants', () => {
	it('allows only listed read permissions within what the creator holds', () => {
		const held = {
			'employee.read': ['team' as const],
			'leave.read': ['all' as const],
			'payroll.read': ['all' as const]
		};
		expect(keyGrants({ 'grant.employee.read': 'team', 'grant.leave.read': 'own' }, held)).toEqual({
			'employee.read': 'team',
			'leave.read': 'own'
		});
		expect(keyGrants({ 'grant.employee.read': 'own' }, held)).toEqual({ 'employee.read': 'own' });
		expect(err(() => keyGrants({ 'grant.employee.read': 'all' }, held))).toBe('forbidden');
		expect(err(() => keyGrants({ 'grant.employee.read': 'everyone' }, held))).toBe('forbidden');
		expect(err(() => keyGrants({ 'grant.payroll.read': 'all' }, held))).toBe('invalid');
		expect(err(() => keyGrants({}, held))).toBe('invalid');
	});

	it('narrows a key to what its creator holds today', () => {
		const key = { 'employee.read': 'all', 'leave.read': 'team', 'attendance.read': 'team', 'payroll.read': 'all' };
		expect(effectiveGrants(key, { 'employee.read': ['all'], 'leave.read': ['all'], 'payroll.read': ['all'] })).toEqual({
			'employee.read': ['all'],
			'leave.read': ['team']
		});
		expect(
			effectiveGrants(key, { 'employee.read': ['team'], 'leave.read': ['own'], 'attendance.read': ['department'] })
		).toEqual({
			'employee.read': ['team'],
			'leave.read': ['own']
		});
		expect(effectiveGrants({ 'employee.read': 'nope' }, { 'employee.read': ['all'] })).toEqual({});
		expect(effectiveGrants(key, {})).toEqual({});
	});

	it('recognises only the hrp_<prefix>_<secret> format', () => {
		expect(API_KEY.test(`hrp_0a1b2c3d_${'A'.repeat(43)}`)).toBe(true);
		expect(API_KEY.test(`hrp_0A1B2C3D_${'A'.repeat(43)}`)).toBe(false);
		expect(API_KEY.test(`hrp_0a1b2c3d_${'A'.repeat(42)}`)).toBe(false);
		expect(API_KEY.test(`xhrp_0a1b2c3d_${'A'.repeat(43)}`)).toBe(false);
	});
});
