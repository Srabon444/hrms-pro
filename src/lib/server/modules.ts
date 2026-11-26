import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { MODULE_IDS, moduleOn, overridesFor, type ModuleId, type ModuleOverrides } from '../modules';
import type { Permission } from '../rbac/permissions';
import { tenantSettings } from './db/schema';
import { can, requireMember, userCtx } from './rbac/access';
import { withTenant, type TenantCtx, type Tx } from './tenancy';

type TenantLocals = Parameters<typeof requireMember>[0];

export async function moduleOverrides(tx: Tx): Promise<ModuleOverrides> {
	const [row] = await tx
		.select({ modulesEnabled: tenantSettings.modulesEnabled, modulesDisabled: tenantSettings.modulesDisabled })
		.from(tenantSettings);
	return row ?? { modulesEnabled: [], modulesDisabled: [] };
}

export const modulesOn = async (tx: Tx): Promise<Set<ModuleId>> => {
	const s = await moduleOverrides(tx);
	return new Set(MODULE_IDS.filter((m) => moduleOn(s, m)));
};

export async function requireModule(locals: TenantLocals, module: ModuleId, permission?: Permission) {
	const m = requireMember(locals);
	const on = await withTenant(userCtx(m), async (tx) => moduleOn(await moduleOverrides(tx), module));
	if (!on) error(404, 'Not found');
	if (permission && !can(m.access, permission)) error(403, 'You do not have permission to do that.');
	return m;
}

export const modulesSchema = z.array(z.enum(MODULE_IDS)).transform((ids) => [...new Set(ids)]);

export async function saveModules(ctx: TenantCtx, raw: string[]): Promise<void> {
	const overrides = overridesFor(modulesSchema.parse(raw));
	await withTenant(ctx, async (tx) => {
		const [row] = await tx.select({ id: tenantSettings.id }).from(tenantSettings);
		await tx.update(tenantSettings).set(overrides).where(eq(tenantSettings.id, row.id));
	});
}
