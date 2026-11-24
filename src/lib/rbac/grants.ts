import { isRestricted, type Permission, type Scope } from './permissions';

export type GrantMap = Partial<Record<Permission, Scope[]>>;

export function toGrantMap(rows: { permission: string; scope: string }[]): GrantMap {
	const map: GrantMap = {};
	for (const r of rows) {
		const list = (map[r.permission as Permission] ??= []);
		if (!list.includes(r.scope as Scope)) list.push(r.scope as Scope);
	}
	return map;
}

export const covers = (held: readonly Scope[] | undefined, scope: Scope): boolean =>
	!!held &&
	(held.includes('all') ||
		held.includes(scope) ||
		(scope === 'own' && (held.includes('team') || held.includes('department'))));

export type Grantor = { grants: GrantMap; isOwner: boolean };

export const canGrant = (actor: Grantor, permission: Permission, scope: Scope): boolean =>
	(!isRestricted(permission) || actor.isOwner) && covers(actor.grants[permission], scope);

export const holdsRestricted = (grants: GrantMap): boolean =>
	(Object.keys(grants) as Permission[]).some((p) => isRestricted(p));
