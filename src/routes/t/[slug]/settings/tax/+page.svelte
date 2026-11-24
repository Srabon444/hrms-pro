<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import { taka } from '#lib/money.ts';
	import { TAX_CATEGORIES, TAX_CATEGORY_LABELS } from '#lib/tax.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const b = $derived(data.board);
	const y = $derived(b.year);
	const input = 'input px-2 py-1';
	const money = '\\d{1,9}(\\.\\d{1,2})?';
</script>

<svelte:head><title>Income tax · {data.tenant.name}</title></svelte:head>

<h1 class="page-title">Income tax</h1>

<div class="mt-4 max-w-4xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'done' in form}<Alert tone="info" message={form.done} />{/if}
</div>

<nav class="mt-4 flex flex-wrap gap-3 text-sm" aria-label="Tax years">
	{#each b.years as t (t.fy)}
		<a
			href={`/t/${data.tenant.slug}/settings/tax?fy=${t.fy}`}
			class={t.fy === y?.fy ? 'font-semibold text-slate-900' : 'text-brand-700 underline'}
		>
			{t.fy}{t.confirmed ? '' : ' (not confirmed)'}
		</a>
	{/each}
</nav>

{#if b.canConfigure && !b.years.some((t) => t.fy === b.current)}
	<form method="POST" action="?/start" class="mt-4 flex items-center gap-2 text-sm">
		<label class="text-slate-700">
			Fiscal year <input name="fy" required value={b.current} class={`${input} w-24`} />
		</label>
		<Button type="submit">Set up tax year</Button>
	</form>
{/if}

{#if y}
	<section class="mt-6 max-w-4xl panel" aria-label="Tax rules">
		<h2 class="section-title">Tax rules for {y.fy}</h2>
		{#if y.confirmedAt}
			<p class="mt-1 text-sm text-emerald-700">Confirmed on {new Date(y.confirmedAt).toLocaleDateString()}.</p>
		{:else}
			<p class="mt-1 text-sm text-amber-700" data-testid="tax-unconfirmed">
				Not confirmed. Payroll for {y.fy} cannot be approved until these rules are checked against the current Finance Act
				and confirmed. Figures copied or seeded here are a starting point, not advice.
			</p>
		{/if}
		<form method="POST" action="?/save" class="mt-4 grid gap-3 text-sm sm:grid-cols-3">
			<input type="hidden" name="taxYearId" value={y.id} />
			<label class="text-slate-700">
				Minimum tax (৳)
				<input
					name="minimumTax"
					required
					disabled={!b.canConfigure}
					value={taka(y.minimumTax)}
					pattern={money}
					class={`${input} block w-full`}
				/>
			</label>
			<label class="text-slate-700">
				Salary exemption cap (৳)
				<input
					name="exemptionCap"
					required
					disabled={!b.canConfigure}
					value={taka(y.exemptionCap)}
					pattern={money}
					class={`${input} block w-full`}
				/>
			</label>
			<label class="text-slate-700">
				Exempt share of income (1 / n)
				<input
					name="exemptionDivisor"
					type="number"
					min="1"
					max="10"
					required
					disabled={!b.canConfigure}
					value={y.exemptionDivisor}
					class={`${input} block w-full`}
				/>
			</label>
			{#each TAX_CATEGORIES as c (c)}
				<label class="text-slate-700">
					{TAX_CATEGORY_LABELS[c]} bands
					<textarea
						name={`bands_${c}`}
						rows="7"
						required
						disabled={!b.canConfigure}
						class={`${input} block w-full font-mono`}>{y.bands[c]}</textarea
					>
				</label>
			{/each}
			<p class="text-slate-500 sm:col-span-3">
				One band per line: the width in taka and the rate in percent. The last line is "rest" and covers everything
				above.
			</p>
			{#if b.canConfigure}
				<div class="flex gap-2 sm:col-span-3">
					<Button type="submit">Save rules</Button>
				</div>
			{/if}
		</form>
		{#if b.canConfigure && !y.confirmedAt}
			<form method="POST" action="?/confirm" class="mt-3">
				<input type="hidden" name="taxYearId" value={y.id} />
				<Button type="submit">Confirm rules for {y.fy}</Button>
			</form>
		{/if}
	</section>

	{#if b.canProfiles}
		<section class="mt-6 max-w-4xl panel" aria-label="Tax profiles">
			<h2 class="section-title">Employee tax profiles for {y.fy}</h2>
			<ul class="mt-3 space-y-2 text-sm">
				{#each b.people as p (p.id)}
					<li data-testid="tax-profile">
						<form method="POST" action="?/profile" class="flex flex-wrap items-center gap-2">
							<input type="hidden" name="taxYearId" value={y.id} />
							<input type="hidden" name="employeeId" value={p.id} />
							<span class="w-40 text-slate-800">{p.name} ({p.code})</span>
							<select name="category" aria-label={`Tax category of ${p.name}`} class={input}>
								{#each TAX_CATEGORIES as c (c)}
									<option value={c} selected={(p.category ?? 'general') === c}>{TAX_CATEGORY_LABELS[c]}</option>
								{/each}
							</select>
							<input
								name="prevEmployerIncome"
								required
								pattern={money}
								value={taka(p.prevEmployerIncome ?? 0)}
								aria-label={`Income from previous employer for ${p.name}`}
								class={`${input} w-28`}
							/>
							<input
								name="prevTaxPaid"
								required
								pattern={money}
								value={taka(p.prevTaxPaid ?? 0)}
								aria-label={`Tax paid at previous employer for ${p.name}`}
								class={`${input} w-28`}
							/>
							<input
								name="rebate"
								required
								pattern={money}
								value={taka(p.rebate ?? 0)}
								aria-label={`Investment rebate for ${p.name}`}
								class={`${input} w-28`}
							/>
							<Button type="submit">Save tax profile of {p.name}</Button>
						</form>
					</li>
				{/each}
			</ul>
		</section>
	{/if}
{/if}
