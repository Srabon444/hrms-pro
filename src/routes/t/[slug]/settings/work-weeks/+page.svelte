<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import { WEEKDAYS, weekendText } from '#lib/day-month.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	type Values = { name?: string; weekendDays: number[]; rosterMode: boolean; active: boolean; used?: boolean };
	const blank: Values = { weekendDays: [], rosterMode: false, active: true };
</script>

<svelte:head><title>Work weeks · {data.tenant.name}</title></svelte:head>

{#snippet fields(v: Values)}
	<label class="text-sm text-slate-700 sm:col-span-2">
		Name
		<input name="name" required maxlength={60} value={v.name ?? ''} class="input mt-1 block w-full" />
	</label>
	<fieldset class="sm:col-span-2" disabled={v.used}>
		<legend class="text-sm text-slate-700">Weekend days</legend>
		<div class="mt-2 flex flex-wrap gap-x-4 gap-y-2">
			{#each WEEKDAYS as day, i (day)}
				<label class="flex items-center gap-2 text-sm">
					<input type="checkbox" name="weekendDays" value={i} checked={v.weekendDays.includes(i)} />{day}
				</label>
			{/each}
		</div>
		<label class="mt-3 flex items-start gap-2 text-sm">
			<input type="checkbox" name="rosterMode" checked={v.rosterMode} class="mt-1" />
			<span>
				Rostered
				<span class="block text-xs text-slate-500">
					A day is only a working day when the published schedule gives the person a shift.
				</span>
			</span>
		</label>
		{#if v.used}<p class="mt-1 text-xs text-slate-500">People follow this work week, so its days are fixed.</p>{/if}
	</fieldset>
	{#if v.used}
		{#each v.weekendDays as d (d)}<input type="hidden" name="weekendDays" value={d} />{/each}
		{#if v.rosterMode}<input type="hidden" name="rosterMode" value="on" />{/if}
	{/if}
	<label class="flex items-center gap-2 text-sm text-slate-700">
		<input type="checkbox" name="active" checked={v.active} />
		Active
	</label>
{/snippet}

<h1 class="page-title">Work weeks</h1>
<p class="mt-1 max-w-3xl text-sm text-slate-600">
	Everyone follows the company weekend from Organisation settings unless their profile assigns a work week from a given
	date. Attendance, leave days, payroll working days and meals follow each person's own weekend.
</p>

<div class="mt-4 max-w-3xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'saved' in form}<Alert tone="info" message="Work weeks saved." />{/if}
</div>

{#each data.weeks as w (w.id)}
	<section class="mt-6 max-w-3xl panel" aria-label={w.name}>
		<h2 class="section-title [overflow-wrap:anywhere]">
			{w.name}
			<span class="ml-2 text-xs font-normal text-slate-500">
				Weekend: {weekendText(w.weekendDays)}{w.rosterMode ? ' · rostered' : ''}{w.active ? '' : ' · inactive'}
			</span>
		</h2>
		<form method="POST" action="?/update" class="mt-3 grid gap-3 sm:grid-cols-2">
			<input type="hidden" name="workWeekId" value={w.id} />
			{@render fields(w)}
			<div class="sm:col-span-2"><Button type="submit">Save {w.name}</Button></div>
		</form>
	</section>
{/each}

<section class="mt-6 max-w-3xl panel" aria-label="New work week">
	<h2 class="section-title">New work week</h2>
	<form method="POST" action="?/create" class="mt-3 grid gap-3 sm:grid-cols-2">
		{@render fields(blank)}
		<div class="sm:col-span-2"><Button type="submit">Add work week</Button></div>
	</form>
</section>
