import { icalFeed } from '#lib/server/public/ical.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params, getClientAddress }) => icalFeed(params.file, getClientAddress());
