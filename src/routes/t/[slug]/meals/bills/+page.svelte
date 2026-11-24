<script lang="ts">
	import Attachments from '#lib/components/Attachments.svelte';
	import Badge from '#lib/components/ui/Badge.svelte';
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import { BILL_STATUS } from '#lib/meal-bill-status.ts';
	import { money } from '#lib/money.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const b = $derived(data.billing);
	const input = 'input px-2 py-1';
	const takesReceipts = (bill: { billingMode: string; status: string }) =>
		bill.billingMode === 'direct' && ['issued', 'partially_paid', 'paid'].includes(bill.status);
</script>

<svelte:head><title>Meal bills · {data.tenant.name}</title></svelte:head>

<h1 class="page-title">Meal bills</h1>

<div class="mt-4 max-w-4xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'done' in form}<Alert tone="info" message={form.done} />{/if}
</div>

<section class="mt-6 max-w-4xl panel" aria-label="Bills">
	<form method="GET" class="flex flex-wrap items-end gap-3 text-sm">
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
		<table class="mt-4 data-table">
			<thead>
				<tr><th class="py-1">Employee</th><th>Status</th><th>Paid by</th><th>Total</th><th>Paid</th><th></th></tr>
			</thead>
			<tbody>
				{#each b.bills as bill (bill.id)}
					<tr class="border-t border-slate-100" data-testid="meal-bill">
						<td class="py-1">{bill.name} <span class="text-slate-400">{bill.code}</span></td>
						<td><Badge status={bill.status} label={BILL_STATUS[bill.status]} /></td>
						<td>{bill.billingMode === 'payroll' ? 'Salary' : 'Cash'}</td>
						<td>{money(bill.total, data.currency)}</td>
						<td>{money(bill.paid, data.currency)}</td>
						<td>
							{#if bill.billingMode === 'direct' && (bill.status === 'issued' || bill.status === 'partially_paid')}
								<form method="POST" action="?/pay" class="flex flex-wrap items-center gap-1">
									<input type="hidden" name="billId" value={bill.id} />
									<input
										name="amount"
										inputmode="decimal"
										required
										pattern={'\\d{1,7}(\\.\\d{1,2})?'}
										aria-label={`Amount from ${bill.name}`}
										class={`${input} w-24`}
									/>
									<input
										name="paidOn"
										type="date"
										required
										max={data.today}
										value={data.today}
										aria-label={`Paid on by ${bill.name}`}
										class={input}
									/>
									<select name="method" aria-label={`Paid by ${bill.name} in`} class={input}>
										<option value="cash">Cash</option>
										<option value="bank">Bank</option>
										<option value="mobile">Mobile banking</option>
									</select>
									<input type="hidden" name="note" value="" />
									<Button type="submit">Record payment from {bill.name}</Button>
								</form>
							{/if}
							{#if bill.status !== 'draft' && bill.status !== 'void'}
								<a href="/t/{data.tenant.slug}/meals/bills/{bill.id}/pdf" class="text-brand-700 hover:underline">
									PDF of {bill.name}
								</a>
							{/if}
							{#if takesReceipts(bill) || data.receipts[bill.id]?.length}
								<Attachments
									slug={data.tenant.slug}
									attachments={{ files: data.receipts[bill.id] ?? [], canEdit: takesReceipts(bill) }}
									{form}
									action="?/receipts"
									ownerId={bill.id}
									title={`Receipts of ${bill.name}`}
									compact
								/>
							{/if}
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

<section class="mt-6 max-w-4xl panel" aria-label="Caterer statement">
	<h2 class="section-title">Caterer statement for {b.period}</h2>
	{#if data.statement.rows.length}
		<table class="mt-3 data-table">
			<thead>
				<tr>
					<th class="py-1">Caterer</th>
					<th>Meal</th>
					<th>Price</th>
					<th>Plates</th>
					<th>Guests</th>
					<th>Caterer cost</th>
					<th>Staff pay</th>
					<th>Company pays</th>
				</tr>
			</thead>
			<tbody>
				{#each data.statement.rows as r (`${r.vendor}${r.meal}${r.unitCost}${r.subsidyPct}`)}
					<tr class="border-t border-slate-100" data-testid="statement-row">
						<td class="py-1">{r.vendor}</td>
						<td>{r.meal}</td>
						<td>{money(r.unitCost, data.currency)}</td>
						<td>{r.plates}</td>
						<td>{r.guests}</td>
						<td>{money(r.cost, data.currency)}</td>
						<td>{money(r.staff, data.currency)}</td>
						<td>{money(r.company, data.currency)}</td>
					</tr>
				{/each}
				<tr class="border-t border-slate-300 font-medium" data-testid="statement-total">
					<td class="py-1" colspan="5">Total</td>
					<td>{money(data.statement.cost, data.currency)}</td>
					<td>{money(data.statement.staff, data.currency)}</td>
					<td>{money(data.statement.company, data.currency)}</td>
				</tr>
			</tbody>
		</table>
	{:else}
		<p class="mt-3 text-sm text-slate-500">No meals served in {b.period}.</p>
	{/if}
</section>
