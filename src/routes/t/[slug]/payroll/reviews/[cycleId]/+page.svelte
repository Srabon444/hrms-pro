<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import { money } from '#lib/money.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const c = $derived(data.cycle);
	const input = 'input px-2 py-1';
	const pct = (bp: number) => `${bp / 100}%`;
	const STATE: Record<string, string> = {
		proposed: 'Proposed',
		pending: 'Sent for approval',
		approved: 'Approved',
		rejected: 'Rejected by finance'
	};
	const failures = $derived((form && 'failures' in form && form.failures) || []);
</script>

<svelte:head><title>{c.name} · {data.tenant.name}</title></svelte:head>

<h1 class="page-title">{c.name}</h1>
<p class="mt-1 text-sm text-slate-600" data-testid="review-status">
	New salaries from {c.effectiveFrom}{c.guidelineBp ? ` · guideline ${pct(c.guidelineBp)}` : ''} · {c.status === 'open'
		? 'Open'
		: 'Closed'}
</p>

<div class="mt-4 max-w-4xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'done' in form}<Alert tone="info" message={form.done} />{/if}
	{#if failures.length}
		<ul class="panel text-sm" aria-label="Not applied">
			{#each failures as f, i (i)}<li class="py-1"><b>{f.name}</b>: {f.message}</li>{/each}
		</ul>
	{/if}
</div>

{#if data.money}
	<section class="mt-6 max-w-4xl panel" aria-label="Budgets">
		<h2 class="section-title">Budgets</h2>
		<p class="mt-1 text-xs text-slate-500">Monthly gross increase per department. Going over is allowed but shown.</p>
		{#if data.budgets.length}
			<ul class="mt-3 divide-y divide-slate-100 text-sm">
				{#each data.budgets as b (b.id)}
					<li class="flex flex-wrap justify-between gap-2 py-2" data-testid="budget">
						<span>{b.name}</span>
						<span class={b.budget !== null && b.used > b.budget ? 'font-medium text-red-700' : 'text-slate-600'}>
							{money(b.used, data.currency)} used{b.budget !== null
								? ` of ${money(b.budget, data.currency)}${b.used > b.budget ? ' · over budget' : ''}`
								: ' · no budget'}
						</span>
					</li>
				{/each}
			</ul>
		{/if}
		{#if c.status === 'open' && data.departments.length}
			<form method="POST" action="?/budget" class="mt-3 flex flex-wrap items-end gap-2 text-sm">
				<label class="text-slate-700">
					Department
					<select name="departmentId" required class={`${input} block`}>
						{#each data.departments as d (d.id)}<option value={d.id}>{d.name}</option>{/each}
					</select>
				</label>
				<label class="text-slate-700">
					Budget
					<input
						name="budget"
						required
						inputmode="decimal"
						pattern={'\\d{1,7}(\\.\\d{1,2})?'}
						class={`${input} block w-32`}
					/>
				</label>
				<Button type="submit">Save budget</Button>
			</form>
		{/if}
	</section>
{/if}

<section class="mt-6 max-w-4xl panel" aria-label="Proposals">
	<h2 class="section-title">Proposals</h2>
	<form method="GET" class="mt-3 flex flex-wrap items-center gap-2 text-sm" role="search">
		<input
			name="q"
			value={data.q}
			maxlength="100"
			aria-label="Search by name"
			placeholder="Search by name"
			class={input}
		/>
		<Button type="submit">Search</Button>
	</form>
	{#if data.truncated}
		<p class="mt-1 text-xs text-amber-700">Showing the first 500 people. Search by name to find others.</p>
	{/if}
	{#if data.rows.length}
		<ul class="mt-3 divide-y divide-slate-100 text-sm">
			{#each data.rows as r (r.id)}
				{@const p = r.proposal}
				<li class="py-3" data-testid="proposal-row">
					<p class="font-medium text-slate-800">
						{r.name} <span class="font-normal text-slate-400">{r.code}{r.department ? ` · ${r.department}` : ''}</span>
					</p>
					<p class="text-slate-600">
						{#if !r.hasSalary}
							No salary yet
						{:else if r.currentGross !== null}
							Now {money(r.currentGross, data.currency)}
						{/if}
						{#if p}
							· {pct(p.changeBp)}{p.proposedGross !== null ? ` → ${money(p.proposedGross, data.currency)}` : ''}
							{#if c.guidelineBp && p.changeBp > c.guidelineBp}<span class="text-amber-700">
									· above guideline
								</span>{/if}
							· {p.reason}
							· <span data-testid="proposal-status">{STATE[p.status]}</span>
							{#if p.stale}<span class="text-red-700"> · salary changed, save again</span>{/if}
						{/if}
					</p>
					{#if r.canEdit}
						<form method="POST" action="?/propose" class="mt-2 flex flex-wrap items-center gap-2">
							<input type="hidden" name="employeeId" value={r.id} />
							<input
								name="pct"
								required
								inputmode="decimal"
								pattern={'\\d{1,3}(\\.\\d{1,2})?'}
								value={p ? p.changeBp / 100 : ''}
								aria-label={`Raise % for ${r.name}`}
								class={`${input} w-20`}
							/>
							<input
								name="reason"
								required
								maxlength="200"
								value={p?.reason ?? ''}
								aria-label={`Reason for ${r.name}`}
								class={`${input} min-w-0 flex-1`}
							/>
							<Button type="submit">Save</Button>
							{#if p}
								<Button type="submit" formaction="?/clear">Remove</Button>
							{/if}
						</form>
					{/if}
				</li>
			{/each}
		</ul>
	{:else}
		<p class="mt-2 text-sm text-slate-600">Nobody to review.</p>
	{/if}
</section>

{#if data.manage && c.status === 'open'}
	<section class="mt-6 max-w-4xl panel" aria-label="Finish">
		<h2 class="section-title">Finish</h2>
		<p class="mt-1 text-xs text-slate-500">
			Apply sends each proposal to finance as a salary change starting {c.effectiveFrom}. People who cannot be applied
			are listed with the reason and stay proposed.
		</p>
		<div class="mt-3 flex flex-wrap gap-2">
			{#if data.canApply}
				<form method="POST" action="?/apply"><Button type="submit">Apply proposals</Button></form>
			{/if}
			<form method="POST" action="?/close"><Button type="submit">Close review</Button></form>
		</div>
	</section>
{/if}
