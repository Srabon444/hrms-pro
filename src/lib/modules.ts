export type ModuleInfo = { label: string; about: string; on: boolean; routes: readonly string[] };

export const MODULES = {
	directory: {
		label: 'Directory and org chart',
		about: 'Colleague list, org chart and work anniversaries for everyone in the organisation.',
		on: true,
		routes: ['directory']
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
