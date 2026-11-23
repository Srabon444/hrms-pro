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

<svelte:head><title>Organisation settings · {data.tenant.name}</title></svelte:head>

<h1 class="text-2xl font-semibold text-slate-900">Organisation settings</h1>

<form method="POST" class="mt-6 max-w-2xl space-y-6 rounded-xl bg-white p-6 ring-1 ring-slate-200">
	<Alert message={form?.message} />
	{#if form && 'saved' in form}<Alert tone="info" message="Settings saved." />{/if}
	<div class="grid gap-4 sm:grid-cols-2">
		<Field label="Legal name" name="legalName" maxlength={200} value={s.legalName} />
		<Field label="Employee code prefix" name="employeeCodePrefix" required value={s.employeeCodePrefix} />
		<div class="sm:col-span-2"><Field label="Address" name="address" maxlength={500} value={s.address} /></div>
		<label class="block text-sm font-medium text-slate-700">
			Time zone
			<select name="timezone" class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2">
				{#each data.timezones as tz (tz)}<option value={tz} selected={tz === s.timezone}>{tz}</option>{/each}
			</select>
		</label>
		<label class="block text-sm font-medium text-slate-700">
			Fiscal year starts in
			<select name="fiscalYearStartMonth" class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2">
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
	<div class="grid gap-4 sm:grid-cols-2">
		<Field
			label="Former employee access (days)"
			name="exEmployeeAccessDays"
			type="number"
			min={0}
			max={3650}
			value={s.exEmployeeAccessDays}
		/>
		<Field
			label="Resignation notice period (days)"
			name="noticePeriodDays"
			type="number"
			min={0}
			max={365}
			value={s.noticePeriodDays}
		/>
		<Field
			label="Keep audit history (days)"
			name="retentionAuditDays"
			type="number"
			min={365}
			max={3650}
			value={s.retentionAuditDays}
		/>
	</div>
	<div class="space-y-2">
		<label class="flex items-center gap-2 text-sm">
			<input type="checkbox" name="require2faForSensitive" checked={s.require2faForSensitive} />
			Require two-step sign-in for members with sensitive permissions
		</label>
		<label class="flex items-center gap-2 text-sm">
			<input
				type="checkbox"
				name="allowSingleAdminApproval"
				checked={s.allowSingleAdminApproval}
				disabled={!data.isOwner}
			/>
			Let one admin both request and approve (small teams only)
		</label>
		{#if !data.isOwner && s.allowSingleAdminApproval}
			<input type="hidden" name="allowSingleAdminApproval" value="on" />
		{/if}
	</div>
	<Button type="submit">Save settings</Button>
</form>
