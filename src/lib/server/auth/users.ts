import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { authPool } from '../db';
import { users } from '../db/schema';
import { AppError } from '../errors';
import { hashPassword, passwordProblem } from './password';

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));

export type NewUser = { email: string; name: string; password: string; isPlatformAdmin?: boolean };

export async function createUser(input: NewUser): Promise<string> {
	const email = emailSchema.parse(input.email);
	const name = input.name.trim();
	if (!name || name.length > 120) throw new AppError('invalid_name', 'Name must be 1-120 characters');
	const problem = passwordProblem(input.password, email);
	if (problem) throw new AppError('weak_password', problem);
	const [row] = await authPool()
		.db.insert(users)
		.values({ email, name, passwordHash: await hashPassword(input.password), isPlatformAdmin: !!input.isPlatformAdmin })
		.onConflictDoNothing({ target: users.email })
		.returning({ id: users.id });
	if (!row) throw new AppError('email_taken', 'An account with this email already exists', 409);
	return row.id;
}

export async function findUserByEmail(email: string) {
	const [row] = await authPool()
		.db.select()
		.from(users)
		.where(eq(users.email, emailSchema.parse(email)));
	return row;
}
