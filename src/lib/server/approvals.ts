import { attendanceApprovals } from './attendance-requests';
import { changeApprovals } from './change-requests';
import { expenseApprovals } from './expenses';
import { leaveApprovals } from './leave-requests';
import { loanApprovals } from './loans';
import { payrollApprovals } from './payroll';
import { resignationApprovals } from './resignations';
import { salaryApprovals } from './salaries';
import { scheduleApprovals } from './shift-swaps';
import { timesheetApprovals } from './timesheets';
import { travelApprovals } from './travel';
import type { Access } from './rbac/access';
import type { Tx } from './tenancy';

export type ApprovalItem = { id: string; kind: string; title: string; requestedBy: string; at: Date; link: string };

type ApprovalSource = (tx: Tx, access: Access) => Promise<ApprovalItem[]>;

const SOURCES: ApprovalSource[] = [
	expenseApprovals,
	loanApprovals,
	changeApprovals,
	leaveApprovals,
	attendanceApprovals,
	resignationApprovals,
	salaryApprovals,
	payrollApprovals,
	timesheetApprovals,
	scheduleApprovals,
	travelApprovals
];

export async function pendingApprovals(tx: Tx, access: Access): Promise<ApprovalItem[]> {
	const lists = await Promise.all(SOURCES.map((source) => source(tx, access)));
	return lists.flat().sort((a, b) => a.at.getTime() - b.at.getTime());
}
