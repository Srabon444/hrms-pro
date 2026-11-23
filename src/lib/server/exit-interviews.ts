import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { pgCode, UNIQUE_VIOLATION } from './db/errors';
import { EXIT_REASONS, exitInterviews } from './db/schema';
import { text } from './employees';
import { AppError } from './errors';
import { lockEmployee } from './exits';
import { userCtx, type Access, type requireMember } from './rbac/access';
import { inScope, resolveScope } from './rbac/scope';
import { withTenant, type Tx } from './tenancy';

type Member = ReturnType<typeof requireMember>;
type Target = { id: string; status: string; exitDate: string | null };

const checkbox = z.preprocess((v) => v === 'on' || v === true, z.boolean());
const interviewSchema = z.object({
	primaryReason: z.enum(EXIT_REASONS, { error: 'Choose the main reason for leaving.' }),
	rating: z.coerce.number().int().min(1, 'Rate from 1 to 5.').max(5, 'Rate from 1 to 5.'),
	wouldRecommend: checkbox,
	wouldRejoin: checkbox,
	comments: text(2000)
});

const leaving = (e: Target): e is Target & { exitDate: string } =>
	(e.status === 'notice' || e.status === 'exited') && !!e.exitDate;

async function rights(tx: Tx, access: Access, e: Target) {
	const self = access.employeeId === e.id;
	const hr = inScope(await resolveScope(tx, access, 'employee.delete'), e.id);
	return { self, hr };
}

export async function exitInterviewView(tx: Tx, access: Access, e: Target) {
	if (!leaving(e)) return null;
	const { self, hr } = await rights(tx, access, e);
	if (!self && !hr) return null;
	const [row] = await tx
		.select()
		.from(exitInterviews)
		.where(and(eq(exitInterviews.employeeId, e.id), eq(exitInterviews.exitDate, e.exitDate)));
	return {
		submitted: !!row,
		answers:
			row && hr
				? {
						primaryReason: row.primaryReason,
						rating: row.rating,
						wouldRecommend: row.wouldRecommend,
						wouldRejoin: row.wouldRejoin,
						comments: row.comments
					}
				: null,
		reasons: EXIT_REASONS
	};
}

export async function submitExitInterview(m: Member, employeeId: string, raw: Record<string, string>) {
	const input = interviewSchema.parse(raw);
	await withTenant(userCtx(m), async (tx) => {
		const e = await lockEmployee(tx, m.access, employeeId);
		const { self, hr } = await rights(tx, m.access, e);
		if (!self && !hr) throw new AppError('forbidden', 'You cannot fill in this exit interview.', 403);
		if (!leaving(e)) throw new AppError('not_leaving', 'There is no exit recorded for this person.', 409);
		await tx
			.insert(exitInterviews)
			.values({
				tenantId: m.tenant.id,
				employeeId: e.id,
				exitDate: e.exitDate,
				submittedByUserId: m.user.userId,
				...input
			})
			.catch((err) => {
				if (pgCode(err) === UNIQUE_VIOLATION)
					throw new AppError('already_submitted', 'The exit interview is already filled in.', 409);
				throw err;
			});
	});
}
