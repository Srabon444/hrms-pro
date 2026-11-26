<script lang="ts">
	type Locale = { timezone: string; currency: string; fiscalYearStartMonth: number; weekendDays: number[] };

	let { value, timezones, currencies }: { value: Locale; timezones: string[]; currencies: string[] } = $props();

	const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
	const MONTHS = Array.from({ length: 12 }, (_, i) => new Date(2000, i, 1).toLocaleString('en', { month: 'long' }));
</script>

<label class="block text-sm font-medium text-slate-700">
	Time zone
	<select name="timezone" class="mt-1 block w-full input">
		{#each timezones as tz (tz)}<option value={tz} selected={tz === value.timezone}>{tz}</option>{/each}
	</select>
</label>
<label class="block text-sm font-medium text-slate-700">
	Currency
	<select name="currency" class="mt-1 block w-full input" aria-describedby="currency-help">
		{#each currencies as c (c)}<option value={c} selected={c === value.currency}>{c}</option>{/each}
	</select>
	<span id="currency-help" class="mt-1 block text-xs font-normal text-slate-500">
		Changes how amounts are labelled. Amounts are not converted, and income-tax rules stay Bangladesh.
	</span>
</label>
<label class="block text-sm font-medium text-slate-700">
	Fiscal year starts in
	<select name="fiscalYearStartMonth" class="mt-1 block w-full input">
		{#each MONTHS as month, i (month)}
			<option value={i + 1} selected={i + 1 === value.fiscalYearStartMonth}>{month}</option>
		{/each}
	</select>
</label>
<fieldset class="sm:col-span-full">
	<legend class="text-sm font-medium text-slate-700">Weekend days</legend>
	<div class="mt-2 flex flex-wrap gap-4">
		{#each DAYS as day, i (day)}
			<label class="flex items-center gap-2 text-sm">
				<input type="checkbox" name="weekendDays" value={i} checked={value.weekendDays.includes(i)} />{day}
			</label>
		{/each}
	</div>
</fieldset>
