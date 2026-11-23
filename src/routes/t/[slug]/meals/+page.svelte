<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import { employeeShare, taka } from '#lib/money.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const input = 'rounded-md border border-slate-300 px-2 py-1 text-sm';
	const card = 'mt-6 max-w-4xl rounded-xl bg-white p-6 ring-1 ring-slate-200';
	const STATUS: Record<string, string> = {
		ordered: 'Eating',
		opted_out: 'Skipped',
		auto_off: 'Off (leave or holiday)'
	};
</script>

<svelte:head><title>Meals · {data.tenant.name}</title></svelte:head>

<h1 class="text-2xl font-semibold text-slate-900">Meals</h1>

<div class="mt-4 max-w-4xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'done' in form}<Alert tone="info" message={form.done} />{/if}
</div>

{#if data.mine}
	<section class={card} aria-label="My meals">
		<h2 class="font-semibold text-slate-900">My meals</h2>
		<p class="mt-1 text-sm text-slate-600">
			Change a day until {data.mine.cutoff} that day. You pay your share for your own plate and the full price for guests.
		</p>
		<ul class="mt-4 divide-y divide-slate-100">
			{#each data.mine.days as d (d.date)}
				<li class="py-3" data-testid="meal-day">
					<div class="text-sm font-medium text-slate-800">{d.date}{d.working ? '' : ' · day off'}</div>
					{#if !d.meals.length}
						<p class="text-sm text-slate-500">No meals served.</p>
					{/if}
					{#each d.meals as meal (meal.mealTypeId)}
						{#if d.open}
							<form method="POST" action="?/choose" class="mt-2 flex flex-wrap items-center gap-2 text-sm">
								<input type="hidden" name="date" value={d.date} />
								<input type="hidden" name="mealTypeId" value={meal.mealTypeId} />
								<span class="w-32 text-slate-700">
									{meal.name} · ৳{taka(employeeShare(meal.unitCost, meal.subsidyPct))}
								</span>
								<select name="status" class={input} aria-label={`${meal.name} on ${d.date}`}>
									<option value="ordered" selected={meal.status === 'ordered'}>Eating</option>
									<option value="opted_out" selected={meal.status !== 'ordered'}>Skip</option>
								</select>
								<label class="flex items-center gap-1 text-slate-700">
									Guests
									<input name="guestQty" type="number" min="0" max="10" value={meal.guestQty} class={`${input} w-16`} />
								</label>
								<Button type="submit">Save {meal.name} on {d.date}</Button>
							</form>
						{:else}
							<p class="mt-1 text-sm text-slate-600" data-testid="meal-choice">
								{meal.name}: {STATUS[meal.status]}{meal.guestQty ? ` + ${meal.guestQty} guests` : ''}
							</p>
						{/if}
					{/each}
				</li>
			{/each}
		</ul>
		<form method="POST" action="?/skip" class="mt-4 flex flex-wrap items-end gap-3 text-sm">
			<label class="text-slate-700">
				Skip from
				<input name="from" type="date" required min={data.mine.today} class={`${input} block`} />
			</label>
			<label class="text-slate-700">
				Skip until
				<input name="to" type="date" required min={data.mine.today} class={`${input} block`} />
			</label>
			<Button type="submit">Skip these days</Button>
		</form>
	</section>
{/if}

{#if data.day}
	{@const day = data.day}
	<section class={card} aria-label="Daily meals">
		<h2 class="font-semibold text-slate-900">Daily meals</h2>
		<form method="GET" class="mt-3 flex items-end gap-3 text-sm">
			<label class="text-slate-700">
				Day
				<input name="date" type="date" value={day.date} class={`${input} block`} />
			</label>
			<Button type="submit">Show</Button>
		</form>
		<p class="mt-3 text-sm text-slate-600" data-testid="meal-day-state">
			{day.prepared ? (day.locked ? 'Locked' : 'Prepared, open for corrections') : 'Not prepared yet'}
		</p>
		{#if day.canPrepare}
			<form method="POST" action="?/prepare" class="mt-2">
				<input type="hidden" name="date" value={day.date} />
				<Button type="submit">Prepare {day.date}</Button>
			</form>
		{/if}
		{#if day.prepared}
			<form method="POST" action={day.locked ? '?/unlock' : '?/lock'} class="mt-2">
				<input type="hidden" name="date" value={day.date} />
				<Button type="submit">{day.locked ? 'Unlock' : 'Lock'} {day.date}</Button>
			</form>
		{/if}
		<ul class="mt-4 space-y-1 text-sm text-slate-700">
			{#each day.totals as t (t.meal)}
				<li data-testid="meal-total">{t.meal}: {t.plates} plates + {t.guests} guests</li>
			{/each}
		</ul>
		{#if day.rows.length}
			<table class="mt-4 w-full text-left text-sm">
				<thead class="text-slate-500">
					<tr><th class="py-1">Employee</th><th>Meal</th><th>Status</th><th>Guests</th></tr>
				</thead>
				<tbody>
					{#each day.rows as row (row.id)}
						<tr class="border-t border-slate-100" data-testid="meal-row">
							<td class="py-1">{row.name} <span class="text-slate-400">{row.code}</span></td>
							<td>{row.meal}</td>
							{#if day.prepared && !day.locked}
								<td colspan="2">
									<form method="POST" action="?/adjust" class="flex items-center gap-2">
										<input type="hidden" name="date" value={day.date} />
										<input type="hidden" name="orderId" value={row.id} />
										<select name="status" class={input} aria-label={`${row.meal} for ${row.name}`}>
											<option value="ordered" selected={row.status === 'ordered'}>Ate</option>
											<option value="opted_out" selected={row.status !== 'ordered'}>Did not eat</option>
										</select>
										<input
											name="guestQty"
											type="number"
											min="0"
											max="10"
											value={row.guestQty}
											aria-label={`Guests of ${row.name}`}
											class={`${input} w-16`}
										/>
										<Button type="submit">Correct {row.name}</Button>
									</form>
								</td>
							{:else}
								<td>{STATUS[row.status]}</td>
								<td>{row.guestQty}</td>
							{/if}
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</section>
{/if}
