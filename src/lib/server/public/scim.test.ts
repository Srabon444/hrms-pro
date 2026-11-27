import { describe, expect, it } from 'vitest';
import { FILTER, patchActive, SCIM_TOKEN } from './scim';

const PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const ops = (...Operations: unknown[]) => ({ schemas: [PATCH], Operations });
const fails = (body: unknown) => {
	try {
		patchActive(body);
		return null;
	} catch (e) {
		return (e as { scimType?: string }).scimType;
	}
};

describe('scim patch', () => {
	it('reads active from a path or a value object, in Entra and Okta shapes', () => {
		expect(patchActive(ops({ op: 'replace', path: 'active', value: false }))).toBe(false);
		expect(patchActive(ops({ op: 'Replace', value: { active: 'False' } }))).toBe(false);
		expect(patchActive(ops({ op: 'Add', path: 'Active', value: 'True' }))).toBe(true);
		expect(patchActive(ops({ op: 'replace', value: { displayName: 'x' } }))).toBeUndefined();
		expect(patchActive(ops({ op: 'remove', path: 'active' }))).toBeUndefined();
		expect(
			patchActive(ops({ op: 'replace', path: 'active', value: true }, { op: 'replace', path: 'active', value: false }))
		).toBe(false);
	});

	it('rejects malformed patches', () => {
		expect(fails({ Operations: [{ op: 'replace' }] })).toBe('invalidSyntax');
		expect(fails(ops())).toBe('invalidSyntax');
		expect(fails(ops({ op: 'replace', path: 'active', value: 'yes' }))).toBe('invalidValue');
		expect(fails(ops({ op: 'replace', value: { active: 1 } }))).toBe('invalidValue');
		expect(fails(null)).toBe('invalidSyntax');
	});
});

describe('scim filter and token', () => {
	it('accepts only userName eq', () => {
		expect(FILTER.exec('userName eq "a@b.example"')?.[1]).toBe('a@b.example');
		expect(FILTER.exec('  USERNAME EQ "a\\"b@c.example" ')?.[1]).toBe('a\\"b@c.example');
		expect(FILTER.exec('userName co "a"')).toBeNull();
		expect(FILTER.exec('userName eq "a" or userName eq "b"')).toBeNull();
		expect(FILTER.exec('emails.value eq "a@b.example"')).toBeNull();
	});

	it('recognises provisioning tokens only', () => {
		expect(SCIM_TOKEN.test(`hrs_0a1b2c3d_${'A'.repeat(43)}`)).toBe(true);
		expect(SCIM_TOKEN.test(`hrd_0a1b2c3d_${'A'.repeat(43)}`)).toBe(false);
		expect(SCIM_TOKEN.test(`hrs_0a1b2c3d_${'A'.repeat(42)}`)).toBe(false);
	});
});
