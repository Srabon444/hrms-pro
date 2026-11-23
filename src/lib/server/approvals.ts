import { attendanceApprovals } from './attendance-requests';
import { changeApprovals } from './change-requests';
import { leaveApprovals } from './leave-requests';
import { resignationApprovals } from './resignations';
import { salaryApprovals } from './salaries';
import type { Access } from './rbac/access';
import type { Tx } from './tenancy';

export type ApprovalItem = { id: string; kind: string; title: string; requestedBy: string; at: Date; link: string };

type ApprovalSource = (tx: Tx, access: Access) => Promise<ApprovalItem[]>;

const SOURCES: ApprovalSource[] = [
	changeApprovals,
	leaveApprovals,
	attendanceApprovals,
	resignationApprovals,
	salaryApprovals
];

export async function pendingApprovals(tx: Tx, access: Access): Promise<ApprovalItem[]> {
	const lists = await Promise.all(SOURCES.map((source) => source(tx, access)));
	return lists.flat().sort((a, b) => a.at.getTime() - b.at.getTime());
}
