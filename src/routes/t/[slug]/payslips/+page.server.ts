import { myPayslips } from '#lib/server/payroll.ts';
import { requireMember } from '#lib/server/rbac/access.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => ({ payslips: await myPayslips(requireMember(locals)) });
