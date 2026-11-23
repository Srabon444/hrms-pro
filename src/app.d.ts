import type { SessionUser } from '#lib/server/auth/session.ts';
import type { TenantAccess } from '#lib/server/tenancy/resolve.ts';

declare global {
	namespace App {
		interface Error {
			message: string;
			requestId?: string;
		}
		interface Locals {
			requestId: string;
			user: SessionUser | null;
			tenant: TenantAccess['tenant'] | null;
			membership: TenantAccess['membership'] | null;
		}
	}
}

export {};
