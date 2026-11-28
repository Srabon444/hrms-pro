import { signDocumentResponse } from '#lib/server/public/esign.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, getClientAddress }) =>
	signDocumentResponse(params.token, getClientAddress());
