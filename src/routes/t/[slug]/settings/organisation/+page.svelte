<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import Field from '#lib/components/ui/Field.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const s = $derived(data.settings);
	const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
	const MONTHS = Array.from({ length: 12 }, (_, i) => new Date(2000, i, 1).toLocaleString('en', { month: 'long' }));
</script>

<svelte:head><title>General settings · {data.tenant.name}</title></svelte:head>

<h1 class="page-title">General</h1>

<form method="POST" class="mt-6 max-w-2xl space-y-6 panel">
	<Alert message={form?.message} />
	{#if form && 'saved' in form}<Alert tone="info" message="Settings saved." />{/if}
	<div class="grid gap-4 sm:grid-cols-2">
		<Field label="Legal name" name="legalName" maxlength={200} value={s.legalName} />
		<Field label="Employee code prefix" name="employeeCodePrefix" required value={s.employeeCodePrefix} />
		<div class="sm:col-span-2"><Field label="Address" name="address" maxlength={500} value={s.address} /></div>
		<label class="block text-sm font-medium text-slate-700">
			Time zone
			<select name="timezone" class="mt-1 block w-full input">
				{#each data.timezones as tz (tz)}<option value={tz} selected={tz === s.timezone}>{tz}</option>{/each}
			</select>
		</label>
		<label class="block text-sm font-medium text-slate-700">
			Fiscal year starts in
			<select name="fiscalYearStartMonth" class="mt-1 block w-full input">
				{#each MONTHS as month, i (month)}
					<option value={i + 1} selected={i + 1 === s.fiscalYearStartMonth}>{month}</option>
				{/each}
			</select>
		</label>
	</div>
	<fieldset>
		<legend class="text-sm font-medium text-slate-700">Weekend days</legend>
		<div class="mt-2 flex flex-wrap gap-4">
			{#each DAYS as day, i (day)}
				<label class="flex items-center gap-2 text-sm">
					<input type="checkbox" name="weekendDays" value={i} checked={s.weekendDays.includes(i)} />{day}
				</label>
			{/each}
		</div>
	</fieldset>
	<Button type="submit">Save settings</Button>
</form>
