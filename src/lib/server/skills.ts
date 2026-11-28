import { and, asc, count, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requireActiveMember } from './audience';
import { now } from './clock';
import { pgCode, UNIQUE_VIOLATION } from './db/errors';
import { employees, employeeSkills, skills } from './db/schema';
import { AppError } from './errors';
import { can, userCtx, type Access, type requireMember } from './rbac/access';
import { inScope, resolveScope, scopeWhere } from './rbac/scope';
import { withTenant, type Tx } from './tenancy';

type Member = ReturnType<typeof requireMember>;

export const MAX_SKILLS = 500;
const LIST_SIZE = 200;
const NUL = 'Remove unsupported characters.';

const nameSchema = z
	.string('Enter the skill name.')
	.trim()
	.min(1, 'Enter the skill name.')
	.max(60, 'Keep the skill name under 60 characters.')
	.refine((v) => !v.includes('\0'), NUL);

const mySkillSchema = z.object({
	skillId: z.uuid('Choose a skill.'),
	level: z.coerce
		.number('Choose a level from 1 to 5.')
		.int('Choose a level from 1 to 5.')
		.min(1, 'Choose a level from 1 to 5.')
		.max(5, 'Choose a level from 1 to 5.')
});

const idOf = (raw: string, message: string) => z.uuid({ error: message }).parse(raw);

const requireManage = (m: Member) => {
	if (!can(m.access, 'skill.manage')) throw new AppError('forbidden', 'You do not have permission to do that.', 403);
};

export async function addSkill(m: Member, raw: Record<string, string>) {
	requireManage(m);
	const name = nameSchema.parse(raw.name);
	await withTenant(userCtx(m), async (tx) => {
		const [{ n }] = await tx.select({ n: count() }).from(skills);
		if (n >= MAX_SKILLS) throw new AppError('too_many', `The catalogue holds up to ${MAX_SKILLS} skills.`, 409);
		await tx
			.insert(skills)
			.values({ tenantId: m.tenant.id, name })
			.catch((err) => {
				if (pgCode(err) === UNIQUE_VIOLATION)
					throw new AppError('duplicate', 'That skill is already in the catalogue.', 409);
				throw err;
			});
	});
}

export async function removeSkill(m: Member, rawId: string) {
	requireManage(m);
	const id = idOf(rawId, 'Choose a skill.');
	await withTenant(userCtx(m), async (tx) => {
		const [r] = await tx.delete(skills).where(eq(skills.id, id)).returning({ id: skills.id });
		if (!r) throw new AppError('not_found', 'That skill does not exist.', 404);
	});
}

const forbidden = () => new AppError('forbidden', 'Only employees can list skills.', 403);

const requireEmployee = (m: Member) => {
	if (!m.access.employeeId) throw forbidden();
	return m.access.employeeId;
};

async function requireStaff(tx: Tx, m: Member, employeeId: string) {
	await requireActiveMember(tx, m.access.membershipId);
	const [e] = await tx.select({ status: employees.status }).from(employees).where(eq(employees.id, employeeId));
	if (!e || e.status === 'exited') throw forbidden();
}

export async function setMySkill(m: Member, raw: Record<string, string>) {
	const employeeId = requireEmployee(m);
	const input = mySkillSchema.parse(raw);
	await withTenant(userCtx(m), async (tx) => {
		await requireStaff(tx, m, employeeId);
		const [skill] = await tx.select({ id: skills.id }).from(skills).where(eq(skills.id, input.skillId));
		if (!skill) throw new AppError('invalid_skill', 'Choose a skill from the catalogue.', 400);
		await tx
			.insert(employeeSkills)
			.values({ tenantId: m.tenant.id, employeeId, skillId: skill.id, level: input.level })
			.onConflictDoUpdate({
				target: [employeeSkills.tenantId, employeeSkills.employeeId, employeeSkills.skillId],
				set: {
					level: input.level,
					validatedByUserId: sql`case when ${employeeSkills.level} = excluded.level then ${employeeSkills.validatedByUserId} end`,
					validatedAt: sql`case when ${employeeSkills.level} = excluded.level then ${employeeSkills.validatedAt} end`
				}
			});
	});
}

export async function removeMySkill(m: Member, rawId: string) {
	const employeeId = requireEmployee(m);
	const skillId = idOf(rawId, 'Choose a skill.');
	await withTenant(userCtx(m), async (tx) => {
		await requireStaff(tx, m, employeeId);
		const [r] = await tx
			.delete(employeeSkills)
			.where(and(eq(employeeSkills.employeeId, employeeId), eq(employeeSkills.skillId, skillId)))
			.returning({ id: employeeSkills.id });
		if (!r) throw new AppError('not_found', 'You have not listed that skill.', 404);
	});
}

const validateSchema = z.object({ id: z.uuid('Choose a skill to validate.'), level: mySkillSchema.shape.level });

export async function validateSkill(m: Member, raw: Record<string, string>) {
	const { id, level } = validateSchema.parse(raw);
	await withTenant(userCtx(m), async (tx) => {
		await requireActiveMember(tx, m.access.membershipId);
		const [row] = await tx
			.select({
				employeeId: employeeSkills.employeeId,
				level: employeeSkills.level,
				validatedAt: employeeSkills.validatedAt
			})
			.from(employeeSkills)
			.where(eq(employeeSkills.id, id))
			.for('update');
		if (!row || !inScope(await resolveScope(tx, m.access, 'skill.validate'), row.employeeId))
			throw new AppError('not_found', 'That skill does not exist.', 404);
		if (row.employeeId === m.access.employeeId)
			throw new AppError('self', 'Someone else has to validate your skills.', 403);
		if (row.validatedAt) throw new AppError('validated', 'That skill is already validated.', 409);
		if (row.level !== level)
			throw new AppError('changed', 'They changed this skill. Reload the page and check it again.', 409);
		await tx
			.update(employeeSkills)
			.set({ validatedByUserId: m.user.userId, validatedAt: now() })
			.where(eq(employeeSkills.id, id));
	});
}

const skillRows = (tx: Tx) =>
	tx
		.select({
			id: employeeSkills.id,
			skillId: employeeSkills.skillId,
			name: skills.name,
			level: employeeSkills.level,
			validated: employeeSkills.validatedAt
		})
		.from(employeeSkills)
		.innerJoin(skills, eq(skills.id, employeeSkills.skillId));

export const catalogue = (tx: Tx) =>
	tx.select({ id: skills.id, name: skills.name }).from(skills).orderBy(asc(skills.name)).limit(MAX_SKILLS);

export const skillsOf = (tx: Tx, employeeId: string) =>
	skillRows(tx).where(eq(employeeSkills.employeeId, employeeId)).orderBy(asc(skills.name)).limit(MAX_SKILLS);

export async function skillsPage(tx: Tx, access: Access) {
	const scope = await resolveScope(tx, access, 'skill.validate');
	const pending = await tx
		.select({ id: employeeSkills.id, employee: employees.fullName, name: skills.name, level: employeeSkills.level })
		.from(employeeSkills)
		.innerJoin(skills, eq(skills.id, employeeSkills.skillId))
		.innerJoin(employees, eq(employees.id, employeeSkills.employeeId))
		.where(
			and(
				isNull(employeeSkills.validatedAt),
				ne(employees.status, 'exited'),
				scopeWhere(scope, employeeSkills.employeeId),
				access.employeeId ? ne(employeeSkills.employeeId, access.employeeId) : undefined
			)
		)
		.orderBy(desc(employeeSkills.updatedAt))
		.limit(LIST_SIZE);
	return {
		catalogue: await catalogue(tx),
		mine: access.employeeId ? await skillsOf(tx, access.employeeId) : [],
		pending,
		canManage: can(access, 'skill.manage'),
		isEmployee: !!access.employeeId
	};
}
