import { calendarMonth, feedStatus, issueFeed, revokeFeed } from '#lib/server/calendar.ts';
import { config } from '#lib/server/config.ts';
import { requireModule } from '#lib/server/modules.ts';
import { userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	const m = await requireModule(locals, 'calendar', 'calendar.read');
	return withTenant(userCtx(m), async (tx) => ({
		calendar: await calendarMonth(tx, m.access, url.searchParams.get('month')),
		feed: await feedStatus(tx, m.access.membershipId)
	}));
};

export const actions: Actions = {
	issueFeed: async ({ locals }) => {
		const m = await requireModule(locals, 'calendar', 'calendar.read');
		const token = await issueFeed(m);
		return { feedUrl: `${config().APP_URL}/ical/${token}.ics` };
	},
	revokeFeed: async ({ locals }) => {
		const m = await requireModule(locals, 'calendar', 'calendar.read');
		await revokeFeed(m);
		return { revoked: true };
	}
};
