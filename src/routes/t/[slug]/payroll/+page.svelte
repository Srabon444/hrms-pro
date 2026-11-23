<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import { taka } from '#lib/money.ts';
	import { runName } from '#lib/payroll.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const b = $derived(data.board);
	const r = $derived(b.run);
	const input = 'rounded-md border border-slate-300 px-2 py-1 text-sm';
	const statusLabel: Record<string, string> = {
		computed: 'Waiting for approval',
		approved: 'Approved',
		paid: 'Paid',
		void: 'Void'
	};
	let runType = $state('regular');
	const exports = [
		['register', 'Payroll register (CSV)'],
		['bank', 'Bank salary sheet (CSV)'],
		['pf', 'Provident fund report (CSV)'],
		['tax', 'Tax deduction report (CSV)']
	] as const;
	const problems = $derived(r ? r.slips.filter((s) => s.error).length : 0);
</script>

<svelte:head><title>Payroll · {data.tenant.name}</title></svelte:head>

{#snippet act(name: string, label: string)}
	<form method="POST" action={`?/${name}`}>
		<input type="hidden" name="runId" value={r!.id} />
		<Button type="submit">{label}</Button>
	</form>
{/snippet}

<h1 class="text-2xl font-semibold text-slate-900">Payroll</h1>

<div class="mt-4 max-w-5xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'done' in form}<Alert tone="info" message={form.done} />{/if}
</div>

{#if b.canRun}
	<form method="POST" action="?/start" class="mt-4 flex items-end gap-2 text-sm">
		<label class="text-slate-700">
			What to pay
			<select name="runType" bind:value={runType} class={`${input} block`}>
				<option value="regular">Monthly pay</option>
				<option value="bonus">Festival bonus</option>
				<option value="arrears">Salary arrears</option>
				<option value="final">Final settlement</option>
			</select>
		</label>
		{#if runType === 'final'}
			<label class="text-slate-700">
				Who is leaving
				<select name="employeeId" required class={`${input} block`}>
					<option value="">Choose…</option>
					{#each b.leavers as l (l.id)}
						<option value={l.id}>{l.name} ({l.code}), leaves {l.exit}</option>
					{/each}
				</select>
			</label>
			<label class="text-slate-700">
				Notice paid in lieu (days)
				<input name="noticePayDays" type="number" min="0" max="365" step="1" value="0" class={`${input} block w-28`} />
			</label>
			<label class="text-slate-700">
				Notice shortfall (days)
				<input
					name="noticeShortDays"
					type="number"
					min="0"
					max="365"
					step="1"
					value="0"
					class={`${input} block w-28`}
				/>
			</label>
			<label class="text-slate-700">
				Unreturned assets (৳)
				<input
					name="assetDeduction"
					inputmode="decimal"
					pattern={'\\d{1,7}(\\.\\d{1,2})?'}
					placeholder="0.00"
					class={`${input} block w-32`}
				/>
			</label>
		{:else}
			<label class="text-slate-700">
				Month
				<input name="period" type="month" required max={b.thisMonth} value={b.thisMonth} class={`${input} block`} />
			</label>
		{/if}
		{#if runType === 'bonus'}
			<label class="text-slate-700">
				Bonus name
				<input name="title" required maxlength="60" placeholder="Eid-ul-Fitr bonus" class={`${input} block`} />
			</label>
		{/if}
		<Button type="submit">Run payroll</Button>
	</form>
{/if}

{#if b.runs.length}
	<nav class="mt-4 flex flex-wrap gap-3 text-sm" aria-label="Payroll runs">
		{#each b.runs as x (x.id)}
			<a
				href={`/t/${data.tenant.slug}/payroll?run=${x.id}`}
				class={x.id === r?.id ? 'font-semibold text-slate-900' : 'text-indigo-700 underline'}
			>
				{x.period}{x.name ? ` · ${x.name}` : ''} · {statusLabel[x.status]}
			</a>
		{/each}
	</nav>
{/if}

{#if r}
	<section class="mt-6 max-w-5xl rounded-xl bg-white p-6 ring-1 ring-slate-200" aria-label="Payroll run">
		<h2 class="font-semibold text-slate-900">
			{runName(r)} for {r.period}{r.leaver ? ` · ${r.leaver}` : ''} · {statusLabel[r.status]}
		</h2>
		<p class="mt-1 text-sm text-slate-600" data-testid="run-totals">
			{r.slips.length} payslip(s) · Gross ৳{taka(r.totals.gross)} · Deductions ৳{taka(r.totals.deductions)} · Net ৳{taka(
				r.totals.net
			)}
		</p>
		{#if problems}
			<p class="mt-1 text-sm text-amber-700">
				{problems} payslip(s) have problems. Fix them and recompute before approval.
			</p>
		{/if}
		<div class="mt-3 flex flex-wrap gap-2">
			{#if r.status === 'computed' && b.canRun}
				{@render act('recompute', 'Recompute')}
				{@render act('void', 'Void run')}
			{/if}
			{#if r.status === 'computed' && b.canApprove && (r.computedByUserId !== b.me || b.selfApprove)}
				{@render act('approve', 'Approve payroll')}
			{/if}
			{#if r.status === 'approved' && b.canApprove}
				{@render act('pay', 'Mark paid')}
			{/if}
			{#if r.status === 'approved' && b.canReopen}
				{@render act('reopen', 'Reopen')}
			{/if}
		</div>
		<nav class="mt-3 flex flex-wrap gap-3 text-sm" aria-label="Download reports">
			{#each exports as [kind, label] (kind)}
				{#if kind !== 'bank' || (b.canApprove && (r.status === 'approved' || r.status === 'paid'))}
					<a class="text-indigo-700 underline" href={`/t/${data.tenant.slug}/payroll/export?run=${r.id}&kind=${kind}`}>
						{label}
					</a>
				{/if}
			{/each}
		</nav>
		<table class="mt-4 w-full text-left text-sm">
			<thead class="text-slate-500">
				<tr>
					<th class="py-2">Employee</th>
					<th>Paid days</th>
					<th>Unpaid days</th>
					<th class="text-right">Gross</th>
					<th class="text-right">Deductions</th>
					<th class="text-right">Net</th>
				</tr>
			</thead>
			<tbody class="divide-y divide-slate-100">
				{#each r.slips as s (s.id)}
					<tr data-testid="payslip-row" class="align-top">
						<td class="py-2">
							<details>
								<summary class="cursor-pointer text-slate-800">{s.name} ({s.code})</summary>
								<ul class="mt-1 text-slate-500">
									{#each s.lines as l (l.id)}
										<li>
											{l.name}: {l.kind === 'deduction' ? '−' : ''}৳{taka(l.amount)}{l.kind === 'employer'
												? ' (paid by employer)'
												: ''}
										</li>
									{/each}
								</ul>
							</details>
							{#if s.error}<p class="text-amber-700">{s.error}</p>{/if}
							{#each s.notes as n (n)}<p class="text-slate-500">{n}</p>{/each}
						</td>
						<td>{s.paidDays}</td>
						<td>{s.unpaidDays}</td>
						<td class="text-right">৳{taka(s.gross)}</td>
						<td class="text-right">৳{taka(s.deductions)}</td>
						<td class="text-right font-medium">৳{taka(s.net)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</section>
{:else}
	<p class="mt-6 text-sm text-slate-500">No payroll has run yet.</p>
{/if}
