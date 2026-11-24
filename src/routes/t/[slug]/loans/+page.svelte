<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import { taka } from '#lib/money.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const b = $derived(data.board);
	const input = 'input px-2 py-1';
	const label = (kind: string) => (kind === 'advance' ? 'Salary advance' : 'Loan');
	const statusLabel: Record<string, string> = {
		requested: 'Waiting for approval',
		approved: 'Repaying',
		rejected: 'Rejected',
		cancelled: 'Cancelled',
		closed: 'Repaid'
	};
</script>

<svelte:head><title>Loans · {data.tenant.name}</title></svelte:head>

<h1 class="page-title">Loans and advances</h1>

<div class="mt-4 max-w-4xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'done' in form}<Alert tone="info" message={form.done} />{/if}
</div>

{#if b.toDecide.length}
	<section class="mt-6 max-w-4xl panel" aria-label="Requests to decide">
		<h2 class="section-title">Requests to decide</h2>
		<ul class="mt-3 divide-y divide-slate-100 text-sm">
			{#each b.toDecide as l (l.id)}
				<li class="py-3" data-testid="loan-to-decide">
					<p class="text-slate-800">
						{l.name} · {label(l.kind)} ৳{taka(l.amount)} · {l.instalments} instalment(s) from {l.startPeriod}
					</p>
					<p class="text-slate-500">{l.reason}</p>
					<form method="POST" action="?/decide" class="mt-2 flex flex-wrap items-center gap-2">
						<input type="hidden" name="loanId" value={l.id} />
						<input name="note" maxlength="300" aria-label={`Note for ${l.name}`} class={`${input} w-64`} />
						<Button type="submit" name="decision" value="approve">Approve request of {l.name}</Button>
						<Button type="submit" name="decision" value="reject">Reject request of {l.name}</Button>
					</form>
				</li>
			{/each}
		</ul>
	</section>
{/if}

{#if b.canRequest}
	<section class="mt-6 max-w-4xl panel" aria-label="New request">
		<h2 class="section-title">New request</h2>
		<form method="POST" action="?/request" class="mt-3 grid gap-3 text-sm sm:grid-cols-2">
			<label class="text-slate-700">
				Type
				<select name="kind" class={`${input} block w-full`}>
					<option value="loan">Loan</option>
					<option value="advance">Salary advance</option>
				</select>
			</label>
			<label class="text-slate-700">
				Amount (৳)
				<input
					name="amount"
					required
					inputmode="decimal"
					pattern={'\\d{1,7}(\\.\\d{1,2})?'}
					class={`${input} block w-full`}
				/>
			</label>
			<label class="text-slate-700">
				Instalments
				<input
					name="instalments"
					type="number"
					required
					min="1"
					max={b.maxInstalments}
					value="1"
					class={`${input} block w-full`}
				/>
			</label>
			<label class="text-slate-700">
				First repayment month
				<input
					name="startPeriod"
					type="month"
					required
					min={b.today.slice(0, 7)}
					value={b.today.slice(0, 7)}
					class={`${input} block w-full`}
				/>
			</label>
			<label class="text-slate-700 sm:col-span-2">
				Reason
				<input name="reason" required maxlength="300" class={`${input} block w-full`} />
			</label>
			<div><Button type="submit">Send request</Button></div>
		</form>
	</section>
{/if}

{#if b.mine.length}
	<section class="mt-6 max-w-4xl panel" aria-label="My loans">
		<h2 class="section-title">My loans and advances</h2>
		<ul class="mt-3 divide-y divide-slate-100 text-sm">
			{#each b.mine as l (l.id)}
				<li class="py-3" data-testid="my-loan">
					<p class="text-slate-800">
						{label(l.kind)} ৳{taka(l.amount)} · {statusLabel[l.status]}{l.schedule.length
							? ` · ৳${taka(l.balance)} left`
							: ''}
					</p>
					{#if l.schedule.length}
						<p class="text-slate-500">
							{l.schedule
								.map((s) => `${s.period} ৳${taka(s.amount)}${s.status === 'paid' ? ' (paid)' : ''}`)
								.join(', ')}
						</p>
					{/if}
					{#if l.status === 'requested'}
						<form method="POST" action="?/cancel" class="mt-2">
							<input type="hidden" name="loanId" value={l.id} />
							<Button type="submit">Cancel request</Button>
						</form>
					{/if}
				</li>
			{/each}
		</ul>
	</section>
{/if}

{#if b.active.length}
	<section class="mt-6 max-w-4xl panel" aria-label="Being repaid">
		<h2 class="section-title">Being repaid</h2>
		<table class="mt-3 data-table">
			<thead>
				<tr><th class="py-1">Employee</th><th>Type</th><th>Amount</th><th>Repaid</th><th>Left</th></tr>
			</thead>
			<tbody class="divide-y divide-slate-100">
				{#each b.active as l (l.id)}
					<tr data-testid="active-loan">
						<td class="py-2">{l.name}</td>
						<td>{label(l.kind)}</td>
						<td>৳{taka(l.amount)}</td>
						<td>৳{taka(l.repaid)}</td>
						<td>৳{taka(l.balance)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</section>
{/if}
