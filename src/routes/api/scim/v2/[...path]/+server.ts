import { scimRequest } from '#lib/server/public/scim.ts';
import type { RequestHandler } from './$types';

const handle: RequestHandler = ({ request, params, getClientAddress }) =>
	scimRequest(request, params.path, getClientAddress());

export const GET = handle;
export const fallback = handle;
