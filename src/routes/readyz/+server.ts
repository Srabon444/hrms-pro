import { readiness } from '#lib/server/http/readiness.ts';

export const GET = async () => {
	const result = await readiness();
	return Response.json(result, { status: result.ok ? 200 : 503 });
};
