import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	addTemplateItem,
	createTemplate,
	listTemplates,
	MAX_TEMPLATE_ITEMS,
	removeTemplateItem,
	setTemplateActive
} from '../../src/lib/server/checklists';
import { closePools } from '../../src/lib/server/db';
import { checklistTemplateItems } from '../../src/lib/server/db/schema';
import { seedTenant } from '../../src/lib/server/platform/tenants';
import { systemCtx, withTenant } from '../../src/lib/server/tenancy';
import { createTenant, TEST_LOCALE } from './helpers';

let tenant: { id: string; slug: string };
let other: { id: string; slug: string };
const ctx = () => ({ tenantId: tenant.id, actor: 'user' as const });
const sys = () => systemCtx(tenant.id);
const code = (p: Promise<unknown>) =>
	p
		.then(() => 'ok')
		.catch((e: { code?: string; issues?: unknown[] }) => (e.issues ? 'invalid' : (e.code ?? String(e))));
const templates = async (id = tenant.id) => (await withTenant(systemCtx(id), listTemplates)).templates;
const task = (title: string, extra: Record<string, string> = {}) => ({
	title,
	assigneeRole: 'it_asset_manager',
	dueOffsetDays: '-2',
	...extra
});

beforeAll(async () => {
	tenant = await createTenant('lists');
	other = await createTenant('lists-other');
	await withTenant(sys(), (tx) => seedTenant(tx, tenant.id, TEST_LOCALE));
	await withTenant(systemCtx(other.id), (tx) => seedTenant(tx, other.id, TEST_LOCALE));
});

afterAll(closePools);

describe('checklist templates', () => {
	it('creates named templates per kind and refuses duplicates', async () => {
		expect(await code(createTemplate(ctx(), { kind: 'onboarding', name: 'Engineers' }))).toBe('ok');
		expect(await code(createTemplate(ctx(), { kind: 'offboarding', name: 'Engineers' }))).toBe('ok');
		expect(await code(createTemplate(ctx(), { kind: 'onboarding', name: 'Engineers' }))).toBe('duplicate');
		expect(await code(createTemplate(ctx(), { kind: 'probation', name: 'X' }))).toBe('invalid');
		expect(await code(createTemplate(ctx(), { kind: 'onboarding', name: ' ' }))).toBe('invalid');
		expect((await templates()).map((t) => [t.kind, t.name, t.active])).toEqual([
			['offboarding', 'Engineers', true],
			['onboarding', 'Engineers', true]
		]);
		expect(await templates(other.id)).toEqual([]);
	});

	it('adds tasks for existing roles only, in due order', async () => {
		const [, onboarding] = await templates();
		expect(await code(addTemplateItem(ctx(), onboarding.id, task('Issue laptop')))).toBe('ok');
		expect(
			await code(
				addTemplateItem(
					ctx(),
					onboarding.id,
					task('Meet the team', { assigneeRole: 'line_manager', dueOffsetDays: '3' })
				)
			)
		).toBe('ok');
		expect(await code(addTemplateItem(ctx(), onboarding.id, task('X', { assigneeRole: 'wizard' })))).toBe(
			'unknown_role'
		);
		expect(await code(addTemplateItem(ctx(), onboarding.id, task('X', { dueOffsetDays: '400' })))).toBe('invalid');
		expect(await code(addTemplateItem(ctx(), onboarding.id, task('')))).toBe('invalid');
		expect(await code(addTemplateItem(ctx(), crypto.randomUUID(), task('X')))).toBe('not_found');
		expect(await code(addTemplateItem(ctx(), 'nope', task('X')))).toBe('not_found');
		const [, after] = await templates();
		expect(after.items.map((i) => [i.title, i.assigneeRole, i.dueOffsetDays])).toEqual([
			['Issue laptop', 'it_asset_manager', -2],
			['Meet the team', 'line_manager', 3]
		]);
	});

	it('keeps tasks inside their template and the tenant', async () => {
		const [offboarding, onboarding] = await templates();
		const [laptop] = onboarding.items;
		expect(await code(removeTemplateItem(ctx(), offboarding.id, laptop.id))).toBe('not_found');
		const foreign = { tenantId: other.id, actor: 'user' as const };
		expect(await code(addTemplateItem(foreign, onboarding.id, task('X')))).toBe('not_found');
		expect(await code(removeTemplateItem(ctx(), onboarding.id, laptop.id))).toBe('ok');
		expect((await templates())[1].items.map((i) => i.title)).toEqual(['Meet the team']);
	});

	it('caps the number of tasks and can switch a template off', async () => {
		const [offboarding] = await templates();
		await withTenant(sys(), (tx) =>
			tx.insert(checklistTemplateItems).values(
				Array.from({ length: MAX_TEMPLATE_ITEMS }, (_, n) => ({
					tenantId: tenant.id,
					templateId: offboarding.id,
					title: `Task ${n}`,
					assigneeRole: 'hr_admin',
					dueOffsetDays: 0
				}))
			)
		);
		expect(await code(addTemplateItem(ctx(), offboarding.id, task('One more')))).toBe('too_many');
		expect(await code(addTemplateItem(ctx(), (await templates())[1].id, task('Still room')))).toBe('ok');
		await setTemplateActive(ctx(), offboarding.id, false);
		expect((await templates())[0].active).toBe(false);
	});
});
