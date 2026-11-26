import { hash, verify } from '@node-rs/argon2';
import common from './common-passwords.json' with { type: 'json' };

const blocked = new Set<string>(common);
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export const isCommonPassword = (password: string) => blocked.has(password.toLowerCase());

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

export function passwordProblem(password: string, email: string): string | null {
	if (password.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters`;
	if (password.length > PASSWORD_MAX) return `Password must be at most ${PASSWORD_MAX} characters`;
	const lower = password.toLowerCase();
	if (lower === email.trim().toLowerCase()) return 'Password must not be your email address';
	if (blocked.has(lower)) return 'This password is too common';
	return null;
}

export const hashPassword = (password: string): Promise<string> => hash(password, OPTIONS);

let dummy: Promise<string> | undefined;

export async function verifyPassword(stored: string | null | undefined, password: string): Promise<boolean> {
	if (password.length > PASSWORD_MAX) return false;
	if (!stored || !stored.startsWith('$argon2')) {
		await verify(await (dummy ??= hashPassword('dummy-password-for-timing')), password).catch(() => false);
		return false;
	}
	return verify(stored, password).catch(() => false);
}
