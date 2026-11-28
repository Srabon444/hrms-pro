export type ModuleInfo = { label: string; about: string; on: boolean; routes: readonly string[] };

export const MODULES = {
	directory: {
		label: 'Directory and org chart',
		about: 'Colleague list, org chart and work anniversaries for everyone in the organisation.',
		on: true,
		routes: ['directory']
	},
	calendar: {
		label: 'Team calendar',
		about: 'Month view of who is out, holidays and events, plus a private feed for Google, Outlook or Apple calendars.',
		on: true,
		routes: ['calendar']
	},
	events: {
		label: 'Events',
		about: 'Company and team events with RSVP and a reminder the day before.',
		on: true,
		routes: ['events']
	},
	schedule: {
		label: 'Schedule',
		about: 'Weekly roster with draft and publish, availability and copying a week, on top of shifts and work weeks.',
		on: true,
		routes: ['schedule']
	},
	surveys: {
		label: 'Surveys and suggestion box',
		about: 'Pulse and eNPS surveys, anonymous by default, and an always-open anonymous suggestion box.',
		on: true,
		routes: ['surveys']
	},
	kiosk: {
		label: 'Attendance kiosk',
		about: 'A shared tablet at a work site where staff punch in with their employee code and a PIN.',
		on: false,
		routes: ['settings/kiosks']
	},
	celebrations_birthdays: {
		label: 'Birthdays',
		about: 'People can choose to show their birthday (day and month only) in the directory and on the home page.',
		on: false,
		routes: []
	}
} as const satisfies Record<string, ModuleInfo>;

export type ModuleId = keyof typeof MODULES;

export const MODULE_IDS = Object.keys(MODULES) as ModuleId[];

export type ModuleOverrides = { modulesEnabled: string[]; modulesDisabled: string[] };

export const moduleOn = (s: ModuleOverrides, m: ModuleId): boolean =>
	MODULES[m].on ? !s.modulesDisabled.includes(m) : s.modulesEnabled.includes(m);

export const overridesFor = (on: ModuleId[]): ModuleOverrides => ({
	modulesEnabled: MODULE_IDS.filter((id) => !MODULES[id].on && on.includes(id)),
	modulesDisabled: MODULE_IDS.filter((id) => MODULES[id].on && !on.includes(id))
});
