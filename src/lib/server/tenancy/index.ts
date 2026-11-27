import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { appPool, type Db } from '../db';

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const ctxSchema = z.object({
	tenantId: z.uuid(),
	userId: z.uuid().nullish(),
	employeeId: z.uuid().nullish(),
	actor: z.enum(['user', 'system']),
	payrollAll: z.boolean().optional(),
	salaryAll: z.boolean().optional(),
	auditSensitive: z.boolean().optional(),
	kioskPins: z.boolean().optional()
});

export type TenantCtx = z.input<typeof ctxSchema>;

const flag = (on: boolean | undefined) => (on ? 'on' : 'off');

const openTx = new AsyncLocalStorage<true>();

export const insideTenantTx = () => openTx.getStore() === true;

export async function withTenant<T>(input: TenantCtx, fn: (tx: Tx) => Promise<T>): Promise<T> {
	const ctx = ctxSchema.parse(input);
	return openTx.run(true, () => run(ctx, fn));
}

function run<T>(ctx: z.output<typeof ctxSchema>, fn: (tx: Tx) => Promise<T>): Promise<T> {
	return appPool().db.transaction(async (tx) => {
		await tx.execute(sql`select
			set_config('app.tenant_id', ${ctx.tenantId}, true),
			set_config('app.user_id', ${ctx.userId ?? ''}, true),
			set_config('app.employee_id', ${ctx.employeeId ?? ''}, true),
			set_config('app.actor', ${ctx.actor}, true),
			set_config('app.payroll_all', ${flag(ctx.payrollAll)}, true),
			set_config('app.salary_all', ${flag(ctx.salaryAll)}, true),
			set_config('app.audit_sensitive', ${flag(ctx.auditSensitive)}, true),
			set_config('app.kiosk_pins', ${flag(ctx.kioskPins)}, true)`);
		return fn(tx);
	});
}

export const systemCtx = (tenantId: string): TenantCtx => ({ tenantId, actor: 'system' });
