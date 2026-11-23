type WithCode = { code?: unknown; cause?: unknown };

export function pgCode(err: unknown): string | null {
	for (let e = err as WithCode | undefined, i = 0; e && i < 4; e = e.cause as WithCode | undefined, i++)
		if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) return e.code;
	return null;
}

export const UNIQUE_VIOLATION = '23505';
export const FK_VIOLATION = '23503';
