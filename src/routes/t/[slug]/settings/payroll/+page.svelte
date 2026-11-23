<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import Field from '#lib/components/ui/Field.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const s = $derived(data.settings);
	const pct = '\\d{1,3}(\\.\\d{1,2})?';
</script>

<svelte:head><title>Payroll settings · {data.tenant.name}</title></svelte:head>

<h1 class="text-2xl font-semibold text-slate-900">Payroll settings</h1>

<form method="POST" class="mt-6 max-w-2xl space-y-6 rounded-xl bg-white p-6 ring-1 ring-slate-200">
	<Alert message={form?.message} />
	{#if form && 'saved' in form}<Alert tone="info" message="Payroll settings saved." />{/if}
	<div class="grid gap-4 sm:grid-cols-2">
		<label class="block text-sm font-medium text-slate-700">
			Part-month pay is based on
			<select name="payrollProrationBasis" class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2">
				<option value="calendar" selected={s.payrollProrationBasis === 'calendar'}>Calendar days</option>
				<option value="working" selected={s.payrollProrationBasis === 'working'}>Working days</option>
			</select>
		</label>
		<Field
			label="Late days that make one unpaid day (0 = off)"
			name="latePolicyCount"
			type="number"
			min={0}
			max={31}
			required
			value={s.latePolicyCount}
		/>
		<Field
			label="Meal bills are deducted after (months)"
			name="mealPayrollLagMonths"
			type="number"
			min={0}
			max={3}
			required
			value={s.mealPayrollLagMonths}
		/>
		<Field
			label="Hours in a month for overtime pay"
			name="overtimeMonthlyHours"
			type="number"
			min={1}
			max={744}
			required
			value={s.overtimeMonthlyHours}
		/>
		<Field
			label="Overtime rate (% of hourly basic, 0 = unpaid)"
			name="overtimeRate"
			inputmode="decimal"
			pattern={pct}
			required
			value={s.overtimeRate}
		/>
		<Field
			label="Provident fund, employee (% of basic)"
			name="pfEmployeeRate"
			inputmode="decimal"
			pattern={pct}
			required
			value={s.pfEmployeeRate}
		/>
		<Field
			label="Provident fund, employer (% of basic)"
			name="pfEmployerRate"
			inputmode="decimal"
			pattern={pct}
			required
			value={s.pfEmployerRate}
		/>
		<Field
			label="Festival bonus (% of basic)"
			name="bonusRate"
			inputmode="decimal"
			pattern={pct}
			required
			value={s.bonusRate}
		/>
		<Field
			label="Months of service before a festival bonus"
			name="bonusMinServiceMonths"
			type="number"
			min={0}
			max={120}
			required
			value={s.bonusMinServiceMonths}
		/>
		<Field
			label="Months that salary arrears look back"
			name="arrearsLookbackMonths"
			type="number"
			min={1}
			max={24}
			required
			value={s.arrearsLookbackMonths}
		/>
		<Field
			label="Gratuity (days of basic per year of service)"
			name="gratuityDaysPerYear"
			type="number"
			min={0}
			max={90}
			required
			value={s.gratuityDaysPerYear}
		/>
		<Field
			label="Years of service before gratuity"
			name="gratuityMinYears"
			type="number"
			min={0}
			max={40}
			required
			value={s.gratuityMinYears}
		/>
		<Field
			label="Months before the employer provident fund vests"
			name="pfVestingMonths"
			type="number"
			min={0}
			max={120}
			required
			value={s.pfVestingMonths}
		/>
	</div>
	<Button type="submit">Save payroll settings</Button>
</form>
