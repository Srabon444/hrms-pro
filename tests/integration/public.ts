import { expect } from 'vitest';
import { ownerPool } from '../../src/lib/server/db';

export type Holder = { tenantId: string; membershipId: string; userId: string };

const GATES = [
	['membership disabled', 'memberships', 'disabled', 'active', 'membershipId'],
	['membership of an ex-employee', 'memberships', 'ex_employee', 'active', 'membershipId'],
	['user disabled', 'users', 'disabled', 'active', 'userId'],
	['tenant suspended', 'tenants', 'suspended', 'active', 'tenantId']
] as const;

export async function expectHolderGated(holder: Holder, call: () => Promise<Response>) {
	const sql = ownerPool().sql;
	expect((await call()).status, 'open').toBe(200);
	const gate = async ([label, table, off, on, key]: (typeof GATES)[number]) => {
		await sql`update ${sql(table)} set status = ${off} where id = ${holder[key]}`;
		try {
			expect((await call()).status, label).toBe(404);
		} finally {
			await sql`update ${sql(table)} set status = ${on} where id = ${holder[key]}`;
		}
	};
	await GATES.reduce((prior, g) => prior.then(() => gate(g)), Promise.resolve());
	expect((await call()).status, 'reopened').toBe(200);
}
