<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import { BILL_STATUS } from '#lib/meal-bill-status.ts';
	import { taka } from '#lib/money.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const b = $derived(data.billing);
	const input = 'rounded-md border border-slate-300 px-2 py-1 text-sm';
</script>

<svelte:head><title>Meal bills · {data.tenant.name}</title></svelte:head>

<h1 class="text-2xl font-semibold text-slate-900">Meal bills</h1>

<div class="mt-4 max-w-4xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'done' in form}<Alert tone="info" message={form.done} />{/if}
</div>

<section class="mt-6 max-w-4xl rounded-xl bg-white p-6 ring-1 ring-slate-200" aria-label="Bills">
	<form method="GET" class="flex items-end gap-3 text-sm">
		<label class="text-slate-700">
			Month
			<input name="period" type="month" value={b.period} class={`${input} block`} />
		</label>
		<Button type="submit">Show</Button>
	</form>
	{#if b.unlocked.length}
		<p class="mt-3 text-sm text-amber-700" data-testid="unlocked-days">
			Lock these days before billing: {b.unlocked.join(', ')}
		</p>
	{/if}
	{#if b.canRun}
		<div class="mt-3 flex gap-2">
			<form method="POST" action="?/generate">
				<input type="hidden" name="period" value={b.period} />
				<Button type="submit">Prepare drafts for {b.period}</Button>
			</form>
			<form method="POST" action="?/issue">
				<input type="hidden" name="period" value={b.period} />
				<Button type="submit">Issue bills for {b.period}</Button>
			</form>
		</div>
	{/if}
	{#if b.bills.length}
		<table class="mt-4 w-full text-left text-sm">
			<thead class="text-slate-500">
				<tr><th class="py-1">Employee</th><th>Status</th><th>Paid by</th><th>Total</th><th>Paid</th><th></th></tr>
			</thead>
			<tbody>
				{#each b.bills as bill (bill.id)}
					<tr class="border-t border-slate-100" data-testid="meal-bill">
						<td class="py-1">{bill.name} <span class="text-slate-400">{bill.code}</span></td>
						<td>{BILL_STATUS[bill.status]}</td>
						<td>{bill.billingMode === 'payroll' ? 'Salary' : 'Cash'}</td>
						<td>৳{taka(bill.total)}</td>
						<td>৳{taka(bill.paid)}</td>
						<td>
							{#if bill.status === 'issued' && !bill.paid}
								<form method="POST" action="?/void">
									<input type="hidden" name="billId" value={bill.id} />
									<Button type="submit">Void bill of {bill.name}</Button>
								</form>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{:else}
		<p class="mt-4 text-sm text-slate-500">No bills for {b.period}.</p>
	{/if}
</section>
