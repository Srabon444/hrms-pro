import type { Permission } from '../../rbac/permissions';
import type { Access } from '../rbac/access';
import type { ScopeSet } from '../rbac/scope';
import type { Tx } from '../tenancy';

export type Cell = string | number | null;
export type Column = { key: string; label: string; numeric?: true };
export type Row = { employeeId?: string; cells: Record<string, Cell> };
export type Section = { key: string; title: string; columns: Column[]; rows: Row[] };
export type ReportParams = { from: string; to: string; departmentId: string | null; departmentName: string | null };
export type Report = { id: string; title: string; params: ReportParams; sections: Section[] };
export type ReportDef = {
	id: string;
	title: string;
	permission: Permission;
	sensitive?: true;
	defaultPeriod?: 'week';
	build: (tx: Tx, input: { scope: ScopeSet; params: ReportParams; access: Access }) => Promise<Section[]>;
};
