export type WorkPlanStatus = 'pending' | 'in_progress' | 'done';

export type WorkPlanItem = {
	id: string;
	employeeId: string;
	description: string;
	target: string;
	status: WorkPlanStatus | string;
};

export type CarriedItem = Omit<WorkPlanItem, 'id' | 'status'> & { weekStart: string; carriedOverFromId: string };

export function rolloverIncomplete(items: WorkPlanItem[], newWeekStart: string): CarriedItem[] {
	return items
		.filter((item) => item.status !== 'done')
		.map((item) => ({
			employeeId: item.employeeId,
			description: item.description,
			target: item.target,
			weekStart: newWeekStart,
			carriedOverFromId: item.id
		}));
}

export function firstWorkday(weekendDays: number[]): number {
	for (let i = 1; i <= 7; i++) {
		const day = i % 7;
		if (!weekendDays.includes(day) && weekendDays.includes((day + 6) % 7)) return day;
	}
	return 1;
}

export function weekStartOf(isoDate: string, weekendDays: number[]): string {
	const d = new Date(`${isoDate}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() - firstWorkday(weekendDays) + 7) % 7));
	return d.toISOString().slice(0, 10);
}
