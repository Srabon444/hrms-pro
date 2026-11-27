import { isIP } from 'node:net';
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { pgCode, UNIQUE_VIOLATION } from './db/errors';
import { branches, PUNCH_LOCATION_RULES, tenantSettings, workSites } from './db/schema';
import { AppError } from './errors';
import { withTenant, type TenantCtx, type Tx } from './tenancy';

export type PunchRule = (typeof PUNCH_LOCATION_RULES)[number];
export type Point = { lat: number; lng: number; accuracyM: number };

const MAX_ACCURACY_BONUS_M = 200;
const EARTH_RADIUS_M = 6_371_000;

const PREFIX = /^(0|[1-9]\d{0,2})$/;

const cidrOk = (v: string) => {
	const [addr, bits, ...rest] = v.split('/');
	const family = addr.includes('%') ? 0 : isIP(addr);
	if (!family || rest.length) return false;
	if (bits === undefined) return true;
	return PREFIX.test(bits) && Number(bits) <= (family === 4 ? 32 : 128);
};

export function clientIp(ip: string | null) {
	if (!ip || ip.includes('%')) return null;
	const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip)?.[1];
	if (mapped && isIP(mapped) === 4) return mapped;
	return isIP(ip) ? ip : null;
}

const optionalNumber = (min: number, max: number, message: string) =>
	z.preprocess(
		(v) => (v === undefined || v === '' ? null : v),
		z.coerce.number(message).min(min, message).max(max, message).nullable()
	);

const siteSchema = z
	.object({
		name: z.string().trim().min(1, 'Enter a name.').max(60, 'Keep the name under 60 characters.'),
		branchId: z.union([z.literal(''), z.uuid('Pick a branch from the list.')]),
		lat: optionalNumber(-90, 90, 'Latitude must be between -90 and 90.'),
		lng: optionalNumber(-180, 180, 'Longitude must be between -180 and 180.'),
		radiusM: z.coerce
			.number('Radius must be 25 to 5000 metres.')
			.int('Radius must be 25 to 5000 metres.')
			.min(25, 'Radius must be 25 to 5000 metres.')
			.max(5000, 'Radius must be 25 to 5000 metres.'),
		ipCidrs: z
			.string()
			.max(2000, 'Keep the network list shorter.')
			.transform((v) => [...new Set(v.split(/[\s,]+/).filter(Boolean))])
			.refine((list) => list.length <= 20, 'Add at most 20 networks.')
			.refine((list) => list.every(cidrOk), 'Enter networks like 203.0.113.0/24 or 2001:db8::/48.'),
		active: z.preprocess((v) => v === 'on' || v === true, z.boolean())
	})
	.refine((s) => (s.lat === null) === (s.lng === null), 'Enter both latitude and longitude, or neither.')
	.refine((s) => s.lat !== null || s.ipCidrs.length > 0, 'Give a location, an office network, or both.');

const ruleSchema = z.enum(PUNCH_LOCATION_RULES, 'Pick a rule from the list.');

const duplicate = (err: unknown) => {
	if (pgCode(err) === UNIQUE_VIOLATION) throw new AppError('duplicate', 'A site with that name already exists.', 409);
	throw err;
};

export const listWorkSites = (tx: Tx) =>
	tx
		.select({
			id: workSites.id,
			name: workSites.name,
			branchId: workSites.branchId,
			lat: workSites.lat,
			lng: workSites.lng,
			radiusM: workSites.radiusM,
			ipCidrs: sql<string[]>`${workSites.ipCidrs}::text[]`,
			active: workSites.active
		})
		.from(workSites)
		.orderBy(asc(workSites.name));

export async function punchRule(tx: Tx): Promise<PunchRule> {
	const [s] = await tx.select({ rule: tenantSettings.punchLocationRule }).from(tenantSettings);
	return ruleSchema.catch('off').parse(s?.rule);
}

async function requireCoverage(tx: Tx) {
	const [row] = await tx.execute<{ n: number }>(sql`
		select count(*)::int as n from employees e
		where e.status <> 'exited'
			and not exists (
				select 1 from work_sites s where s.active and (s.branch_id is null or s.branch_id = e.branch_id)
			)`);
	if (row && row.n > 0)
		throw new AppError(
			'no_sites',
			`${row.n} ${row.n === 1 ? 'person has' : 'people have'} no active work site for their branch, so blocking would stop them punching. Add a site for every branch first.`,
			409
		);
}

export async function savePunchRule(ctx: TenantCtx, raw: string) {
	const rule = ruleSchema.parse(raw);
	await withTenant(ctx, async (tx) => {
		if (rule === 'block') await requireCoverage(tx);
		await tx.update(tenantSettings).set({ punchLocationRule: rule });
	});
}

const networks = (list: string[]) =>
	list.length
		? sql`array[${sql.join(
				list.map((c) => sql`network(${c}::inet)`),
				sql`, `
			)}]::cidr[]`
		: sql`'{}'::cidr[]`;

async function checkedBranch(tx: Tx, branchId: string) {
	if (!branchId) return null;
	const [b] = await tx.select({ id: branches.id }).from(branches).where(eq(branches.id, branchId));
	if (!b) throw new AppError('invalid', 'Pick a branch from the list.', 400);
	return b.id;
}

export async function saveWorkSite(ctx: TenantCtx, siteId: string, raw: Record<string, string>) {
	const input = siteSchema.parse(raw);
	const id = siteId ? z.uuid().safeParse(siteId) : null;
	await withTenant(ctx, async (tx) => {
		const values = {
			name: input.name,
			branchId: await checkedBranch(tx, input.branchId),
			lat: input.lat,
			lng: input.lng,
			radiusM: input.radiusM,
			ipCidrs: networks(input.ipCidrs),
			active: input.active
		};
		if (!id) {
			await tx
				.insert(workSites)
				.values({ tenantId: ctx.tenantId, ...values })
				.catch(duplicate);
			return;
		}
		const [s] = id.success
			? await tx.select({ id: workSites.id }).from(workSites).where(eq(workSites.id, id.data))
			: [];
		if (!s) throw new AppError('not_found', 'That site does not exist.', 404);
		await tx.update(workSites).set(values).where(eq(workSites.id, s.id)).catch(duplicate);
		if ((await punchRule(tx)) === 'block') await requireCoverage(tx);
	});
}

const radians = (d: number) => (d * Math.PI) / 180;

export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
	const h =
		Math.sin(radians(b.lat - a.lat) / 2) ** 2 +
		Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(radians(b.lng - a.lng) / 2) ** 2;
	return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export async function matchSite(tx: Tx, employeeId: string, ip: string | null, point: Point | null) {
	const address = clientIp(ip);
	const sites = await tx
		.select({
			id: workSites.id,
			lat: workSites.lat,
			lng: workSites.lng,
			radiusM: workSites.radiusM,
			onNetwork: address ? sql<boolean>`${address}::inet <<= any(${workSites.ipCidrs})` : sql<boolean>`false`
		})
		.from(workSites)
		.where(
			and(
				eq(workSites.active, true),
				or(
					isNull(workSites.branchId),
					sql`${workSites.branchId} = (select e.branch_id from employees e where e.id = ${employeeId})`
				)
			)
		)
		.orderBy(asc(workSites.name));
	const near = (s: (typeof sites)[number]) =>
		!!point &&
		s.lat !== null &&
		s.lng !== null &&
		distanceM(point, { lat: s.lat, lng: s.lng }) <= s.radiusM + Math.min(point.accuracyM, MAX_ACCURACY_BONUS_M);
	return (sites.find((s) => s.onNetwork) ?? sites.find(near))?.id ?? null;
}

export const siteBranches = (tx: Tx) =>
	tx.select({ id: branches.id, name: branches.name }).from(branches).orderBy(asc(branches.name));
