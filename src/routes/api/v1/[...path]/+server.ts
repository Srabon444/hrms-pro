import { apiRequest } from '#lib/server/public/api.ts';
import type { RequestHandler } from './$types';

const handle: RequestHandler = ({ request, params, getClientAddress }) =>
	apiRequest(request, params.path, getClientAddress());

export const GET = handle;
export const fallback = handle;
