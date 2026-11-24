<script lang="ts">
	import SettingInput from '#lib/components/ui/SettingInput.svelte';
	import { LIMITS } from '#lib/settings-sections.ts';
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import { taka } from '#lib/money.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const input = 'input mt-1 block w-full';
	const card = 'mt-6 max-w-3xl panel';
	const s = $derived(data.setup.settings);
	const activeVendors = $derived(data.setup.vendors.filter((v) => v.active));
	type Vendor = Partial<(typeof data.setup.vendors)[number]>;
	type MealType = Partial<(typeof data.setup.types)[number]>;
</script>

<svelte:head><title>Meal setup · {data.tenant.name}</title></svelte:head>

{#snippet vendorFields(v: Vendor)}
	<label class="text-sm text-slate-700">
		Caterer name
		<input name="name" required maxlength={100} value={v.name ?? ''} class={input} />
	</label>
	<label class="text-sm text-slate-700">
		Contact
		<input name="contact" maxlength={200} value={v.contact ?? ''} class={input} />
	</label>
	<label class="flex items-center gap-2 text-sm text-slate-700">
		<input type="checkbox" name="active" checked={v.active ?? true} />
		Active
	</label>
{/snippet}

{#snippet typeFields(t: MealType)}
	<label class="text-sm text-slate-700">
		Meal name
		<input name="name" required maxlength={60} value={t.name ?? ''} class={input} />
	</label>
	<label class="text-sm text-slate-700">
		Caterer
		<select name="vendorId" required class={input}>
			{#each data.setup.vendors.filter((v) => v.active || v.id === t.vendorId) as v (v.id)}
				<option value={v.id} selected={v.id === t.vendorId}>{v.name}</option>
			{/each}
		</select>
	</label>
	<label class="flex items-center gap-2 text-sm text-slate-700">
		<input type="checkbox" name="active" checked={t.active ?? true} />
		Active
	</label>
{/snippet}

<h1 class="page-title">Meal setup</h1>
<p class="mt-1 max-w-3xl text-sm text-slate-600">
	Caterers supply meals, each meal has a price per plate from a date, and the company share is taken off what employees
	pay for their own meals. Guests are always charged in full.
</p>

<div class="mt-4 max-w-3xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'saved' in form}<Alert tone="info" message="Meal setup saved." />{/if}
</div>

<section class={card} aria-label="Ordering rules">
	<h2 class="section-title">Ordering rules</h2>
	<form method="POST" action="?/settings" class="mt-3 grid gap-3 sm:grid-cols-2">
		<label class="text-sm text-slate-700">
			Daily cutoff (changes for a day close at this time that day)
			<input name="mealCutoffTime" type="time" required value={s.mealCutoffTime.slice(0, 5)} class={input} />
		</label>
		<label class="text-sm text-slate-700">
			Ordering
			<select name="mealMode" class={input}>
				<option value="opt_out" selected={s.mealMode === 'opt_out'}>Everyone eats unless they opt out</option>
				<option value="opt_in" selected={s.mealMode === 'opt_in'}>Only people who opt in eat</option>
			</select>
		</label>
		<label class="text-sm text-slate-700">
			Bills are paid
			<select name="mealBillingMode" class={input} disabled={!data.canBill}>
				<option value="payroll" selected={s.mealBillingMode === 'payroll'}>From salary</option>
				<option value="direct" selected={s.mealBillingMode === 'direct'}>Directly by the employee</option>
			</select>
			{#if !data.canBill}<input type="hidden" name="mealBillingMode" value={s.mealBillingMode} />{/if}
		</label>
		<label class="flex items-center gap-2 text-sm text-slate-700">
			<input type="checkbox" name="mealWorkingDaysOnly" checked={s.mealWorkingDaysOnly} />
			Serve meals on working days only
		</label>
		<SettingInput field={LIMITS.mealOrderDaysAhead} value={s.mealOrderDaysAhead} />
		<div class="sm:col-span-2"><Button type="submit">Save ordering rules</Button></div>
	</form>
</section>

{#each data.setup.vendors as v (v.id)}
	<section class={card} aria-label={v.name}>
		<h2 class="section-title">
			{v.name}<span class="ml-2 text-xs font-normal text-slate-500">caterer{v.active ? '' : ' · inactive'}</span>
		</h2>
		<form method="POST" action="?/vendor" class="mt-3 grid gap-3 sm:grid-cols-2">
			<input type="hidden" name="vendorId" value={v.id} />
			{@render vendorFields(v)}
			<div class="sm:col-span-2"><Button type="submit">Save {v.name}</Button></div>
		</form>
	</section>
{/each}

<section class={card} aria-label="New caterer">
	<h2 class="section-title">New caterer</h2>
	<form method="POST" action="?/vendor" class="mt-3 grid gap-3 sm:grid-cols-2">
		{@render vendorFields({})}
		<div class="sm:col-span-2"><Button type="submit">Add caterer</Button></div>
	</form>
</section>

{#each data.setup.types as t (t.id)}
	<section class={card} aria-label={t.name}>
		<h2 class="section-title">
			{t.name}
			<span class="ml-2 text-xs font-normal text-slate-500" data-testid="meal-price">
				{t.vendor} · {t.current
					? `৳${taka(t.current.unitCost)} per plate, company pays ${t.current.subsidyPct}%`
					: 'no price yet'}{t.active ? '' : ' · inactive'}
			</span>
		</h2>
		<form method="POST" action="?/type" class="mt-3 grid gap-3 sm:grid-cols-2">
			<input type="hidden" name="typeId" value={t.id} />
			{@render typeFields(t)}
			<div class="sm:col-span-2"><Button type="submit">Save {t.name}</Button></div>
		</form>
		{#if t.prices.length}
			<ul class="mt-4 space-y-1 text-sm text-slate-600">
				{#each t.prices as p (p.id)}
					<li>From {p.effectiveFrom}: ৳{taka(p.unitCost)}, company pays {p.subsidyPct}%</li>
				{/each}
			</ul>
		{/if}
		<form method="POST" action="?/price" class="mt-4 grid gap-3 sm:grid-cols-3">
			<input type="hidden" name="mealTypeId" value={t.id} />
			<label class="text-sm text-slate-700">
				Price per plate (৳)
				<input name="unitCost" required inputmode="decimal" pattern={'\\d{1,5}(\\.\\d{1,2})?'} class={input} />
			</label>
			<label class="text-sm text-slate-700">
				Company pays (%)
				<input name="subsidyPct" type="number" min="0" max="100" required value="0" class={input} />
			</label>
			<label class="text-sm text-slate-700">
				Starting
				<input
					name="effectiveFrom"
					type="date"
					required
					min={data.setup.today}
					value={data.setup.today}
					class={input}
				/>
			</label>
			<div class="sm:col-span-3"><Button type="submit">Set price for {t.name}</Button></div>
		</form>
	</section>
{/each}

{#if activeVendors.length}
	<section class={card} aria-label="New meal">
		<h2 class="section-title">New meal</h2>
		<form method="POST" action="?/type" class="mt-3 grid gap-3 sm:grid-cols-2">
			{@render typeFields({})}
			<div class="sm:col-span-2"><Button type="submit">Add meal</Button></div>
		</form>
	</section>
{/if}
