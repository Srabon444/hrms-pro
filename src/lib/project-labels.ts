export const PROJECT_STATUS_LABELS: Record<string, string> = { active: 'Active', on_hold: 'On hold', closed: 'Closed' };
export const PROJECT_ROLE_LABELS: Record<string, string> = { member: 'Member', lead: 'Lead' };
export const TIMESHEET_STATUS_LABELS: Record<string, string> = {
	draft: 'Draft',
	submitted: 'Waiting for approval',
	approved: 'Approved',
	rejected: 'Sent back'
};
export const hoursOf = (minutes: number) => (minutes / 60).toFixed(2).replace(/\.?0+$/, '');
