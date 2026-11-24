import { and, arrayContains, desc, eq, gte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Scope } from '../../rbac/permissions';
import { auditEvent } from '../audit';
import { addDays } from '../dates';
import { reportShares, type ShareSpec } from '../db/schema';
import { AppError } from '../errors';
import { tenantToday } from '../lifecycle';
import type { Mail } from '../mail';
import { notify } from '../notifications';
import { can, userCtx, type Access, type requireMember } from '../rbac/access';
import { resolveScope } from '../rbac/scope';
import { deleteObject, getObject, putObject } from '../storage';
import { withTenant, type Tx } from '../tenancy';
import { reportCsv, reportFileName, reportPdf, reportPeriod } from './files';
import { REPORTS, reportDef, runReport } from './index';
import type { Report, ReportDef } from './types';

type Member = ReturnType<typeof requireMember>;

export const REPORT_SHARE_DAYS = 30;
export const MAX_SHARE_RECIPIENTS = 200;

const choice = (msg: string) => z.array(z.string().max(200, msg)).max(5000, msg);
const shareSchema = z.object({
	sections: choice('Choose sections from the list.').min(1, 'Choose at least one section to share.'),
	columns: choice('Choose columns from the list.'),
	employees: z.array(z.uuid('Choose employees from the list.')).max(5000, 'Choose employees from the list.'),
	recipients: z
		.array(z.uuid('Choose recipients from the list.'))
		.min(1, 'Choose at least one person to share with.')
		.max(MAX_SHARE_RECIPIENTS, `Share with at most ${MAX_SHARE_RECIPIENTS} people at once.`)
});

export type ShareInput = {
	filters: Record<string, string>;
	sections: string[];
	columns: string[];
	employees: string[];
	recipients: string[];
};

const invalid = (message: string) => new AppError('invalid', message, 400);

export function applySpec(report: Report, spec: Pick<ShareSpec, 'sections' | 'columns' | 'employees'>): Report {
	const known = new Set(report.sections.map((s) => s.key));
	if (spec.sections.some((k) => !known.has(k))) throw invalid('Choose sections from the list.');
	const columns = new Set(spec.columns);
	const allColumns = new Set(report.sections.flatMap((s) => s.columns.map((c) => `${s.key}:${c.key}`)));
	if (spec.columns.some((c) => !allColumns.has(c))) throw invalid('Choose columns from the list.');
	const people = new Set(report.sections.flatMap((s) => s.rows.flatMap((r) => (r.employeeId ? [r.employeeId] : []))));
	if (spec.employees.some((id) => !people.has(id))) throw invalid('Choose employees from the list.');
	const only = spec.employees.length ? new Set(spec.employees) : null;
	return {
		...report,
		sections: report.sections
			.filter((s) => spec.sections.includes(s.key))
			.map((s) => {
				const kept = s.columns.filter((c) => columns.has(`${s.key}:${c.key}`));
				if (!kept.length) throw invalid(`Choose at least one column in ${s.title}.`);
				return {
					...s,
					columns: kept,
					rows: s.rows
						.filter((r) => !only || !r.employeeId || only.has(r.employeeId))
						.map((r) => ({
							...r,
							cells: Object.fromEntries(kept.map((c) => [c.key, r.cells[c.key] ?? null]))
						}))
				};
			})
	};
}

const covers = (outer: Awaited<ReturnType<typeof resolveScope>>, inner: typeof outer) =>
	outer.kind === 'all' || (inner.kind === 'ids' && inner.ids.every((id) => outer.ids.includes(id)));

export async function shareRecipients(tx: Tx, access: Access, def: ReportDef) {
	const sharer = await resolveScope(tx, access, def.permission);
	const rows = await tx.execute<{ membership_id: string; employee_id: string | null; name: string; scope: Scope }>(sql`
		select tu.membership_id, tu.employee_id, tu.name, rp.scope
		from tenant_users tu
		join membership_roles mr on mr.membership_id = tu.membership_id
		join role_permissions rp on rp.role_id = mr.role_id and rp.permission = ${def.permission}
		where tu.membership_status = 'active' and tu.membership_id <> ${access.membershipId}::uuid
		order by tu.name, tu.membership_id`);
	const byMember = new Map<string, { employeeId: string | null; name: string; scopes: Scope[] }>();
	for (const r of rows) {
		const m = byMember.get(r.membership_id) ?? { employeeId: r.employee_id, name: r.name, scopes: [] };
		m.scopes.push(r.scope);
		byMember.set(r.membership_id, m);
	}
	const eligible: { membershipId: string; name: string }[] = [];
	for (const [membershipId, m] of byMember) {
		const scope = await resolveScope(
			tx,
			{ membershipId, employeeId: m.employeeId, grants: { [def.permission]: m.scopes }, roleKeys: [], isOwner: false },
			def.permission
		);
		if (covers(scope, sharer)) eligible.push({ membershipId, name: m.name });
	}
	return eligible;
}

export async function shareReport(
	m: Member,
	reportId: string,
	raw: ShareInput
): Promise<{ id: string; mails: Mail[] }> {
	const def = reportDef(m.access, reportId);
	const spec = shareSchema.parse(raw);
	const id = crypto.randomUUID();
	const base = `t/${m.tenant.id}/report-shares/${id}`;
	const stored: string[] = [];
	const put = async (key: string, body: Uint8Array, type: string) => {
		await putObject(key, body, type);
		stored.push(key);
	};
	try {
		return await withTenant(userCtx(m), async (tx) => {
			const full = await runReport(tx, m.access, reportId, raw.filters);
			const report = applySpec(full, spec);
			const eligible = new Set((await shareRecipients(tx, m.access, def)).map((r) => r.membershipId));
			if (spec.recipients.some((r) => !eligible.has(r))) throw invalid('Choose recipients from the list.');
			await put(`${base}.json`, new TextEncoder().encode(JSON.stringify(report)), 'application/json');
			const attachments: NonNullable<Mail['attachments']> = [];
			if (!def.sensitive) {
				await put(`${base}.csv`, new TextEncoder().encode(reportCsv(report)), 'text/csv');
				await put(`${base}.pdf`, await reportPdf(m.tenant.name, report), 'application/pdf');
				attachments.push(
					{ filename: reportFileName(report, 'csv'), key: `${base}.csv`, contentType: 'text/csv' },
					{ filename: reportFileName(report, 'pdf'), key: `${base}.pdf`, contentType: 'application/pdf' }
				);
			}
			const recipients = [...new Set(spec.recipients)];
			const period = reportPeriod(report);
			await tx.insert(reportShares).values({
				id,
				tenantId: m.tenant.id,
				reportId: def.id,
				title: report.title,
				period,
				spec: {
					filters: {
						from: report.params.from,
						to: report.params.to,
						department: report.params.departmentId ?? ''
					},
					sections: spec.sections,
					columns: spec.columns,
					employees: spec.employees
				},
				storageKey: base,
				recipientMembershipIds: recipients,
				sharedByMembershipId: m.access.membershipId,
				sharedByUserId: m.user.userId,
				expiresOn: addDays(await tenantToday(tx), REPORT_SHARE_DAYS)
			});
			const [me] = await tx.execute<{ name: string }>(
				sql`select name from tenant_users where membership_id = ${m.access.membershipId}::uuid`
			);
			const mails = await notify(
				tx,
				m.tenant.id,
				recipients,
				{ category: 'reports', title: `${me.name} shared ${report.title} (${period})`, link: `reports/shared/${id}` },
				m.tenant.slug
			);
			return { id, mails: mails.map((mail) => ({ ...mail, attachments })) };
		});
	} catch (err) {
		await Promise.all(stored.map((k) => deleteObject(k).catch(() => undefined)));
		throw err;
	}
}

const holds = (access: Access, reportId: string) => {
	const def = REPORTS.find((r) => r.id === reportId);
	return !!def && can(access, def.permission);
};

export async function shareList(tx: Tx, access: Access) {
	const today = await tenantToday(tx);
	const rows = await tx
		.select({
			id: reportShares.id,
			reportId: reportShares.reportId,
			title: reportShares.title,
			period: reportShares.period,
			sharedByMembershipId: reportShares.sharedByMembershipId,
			createdAt: reportShares.createdAt,
			expiresOn: reportShares.expiresOn,
			sharer: sql<string>`(select tu.name from tenant_users tu where tu.membership_id = ${reportShares.sharedByMembershipId})`
		})
		.from(reportShares)
		.where(
			and(
				gte(reportShares.expiresOn, today),
				or(
					eq(reportShares.sharedByMembershipId, access.membershipId),
					arrayContains(reportShares.recipientMembershipIds, [access.membershipId])
				)
			)
		)
		.orderBy(desc(reportShares.createdAt))
		.limit(100);
	return rows
		.filter((r) => holds(access, r.reportId))
		.map((r) => ({ ...r, mine: r.sharedByMembershipId === access.membershipId }));
}

export async function openShare(m: Member, id: string) {
	const notFound = () => new AppError('not_found', 'That shared report does not exist or has expired.', 404);
	if (!z.uuid().safeParse(id).success) throw notFound();
	const ctx = userCtx(m);
	return withTenant(ctx, async (tx) => {
		const [row] = await tx.select().from(reportShares).where(eq(reportShares.id, id));
		if (
			!row ||
			row.expiresOn < (await tenantToday(tx)) ||
			!(
				row.sharedByMembershipId === m.access.membershipId || row.recipientMembershipIds.includes(m.access.membershipId)
			) ||
			!holds(m.access, row.reportId)
		)
			throw notFound();
		await auditEvent(tx, ctx, 'report_shares', row.id, 'report_share.open');
		const report = JSON.parse(new TextDecoder().decode(await getObject(`${row.storageKey}.json`))) as Report;
		return { share: { id: row.id, expiresOn: row.expiresOn, createdAt: row.createdAt }, report };
	});
}
