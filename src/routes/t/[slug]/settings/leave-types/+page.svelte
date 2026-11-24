<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const input = 'input mt-1 block w-full';
	type Values = Partial<(typeof data.types)[number]>;
	const blank: Values = {
		paid: true,
		accrual: 'yearly',
		proRata: true,
		carryCap: 0,
		minNoticeDays: 0,
		halfDayAllowed: true,
		duringProbation: true,
		active: true
	};
	const flags = [
		['paid', 'Paid'],
		['proRata', 'Pro-rata for joiners'],
		['encashable', 'Encashable'],
		['halfDayAllowed', 'Half days allowed'],
		['duringProbation', 'Allowed during probation'],
		['sandwich', 'Count weekends and holidays in between'],
		['active', 'Active']
	] as const;
</script>

<svelte:head><title>Leave types · {data.tenant.name}</title></svelte:head>

{#snippet fields(v: Values)}
	<label class="text-sm text-slate-700">
		Name
		<input name="name" required maxlength={60} value={v.name ?? ''} class={input} />
	</label>
	<label class="text-sm text-slate-700">
		Days per year (blank for no limit)
		<input name="quota" type="number" min="0" max="366" step="0.5" value={v.quota ?? ''} class={input} />
	</label>
	<label class="text-sm text-slate-700">
		Credited
		<select name="accrual" class={input}>
			{#each data.accruals as a (a)}<option value={a} selected={v.accrual === a}>{a}</option>{/each}
		</select>
	</label>
	<label class="text-sm text-slate-700">
		Carry forward up to (days)
		<input name="carryCap" type="number" min="0" max="366" step="0.5" required value={v.carryCap ?? 0} class={input} />
	</label>
	<label class="text-sm text-slate-700">
		Longest stretch (days, blank for any)
		<input name="maxConsecutive" type="number" min="1" max="366" value={v.maxConsecutive ?? ''} class={input} />
	</label>
	<label class="text-sm text-slate-700">
		Notice needed (days)
		<input name="minNoticeDays" type="number" min="0" max="365" required value={v.minNoticeDays ?? 0} class={input} />
	</label>
	<label class="text-sm text-slate-700">
		Who can take it
		<select name="gender" class={input}>
			<option value="">Everyone</option>
			{#each data.genders as g (g)}<option value={g} selected={v.gender === g}>{g} only</option>{/each}
		</select>
	</label>
	<div class="grid gap-1 sm:col-span-2 sm:grid-cols-2">
		{#each flags as [name, label] (name)}
			<label class="flex items-center gap-2 text-sm text-slate-700">
				<input type="checkbox" {name} checked={!!v[name]} />
				{label}
			</label>
		{/each}
	</div>
{/snippet}

<h1 class="page-title">Leave types</h1>
<p class="mt-1 max-w-3xl text-sm text-slate-600">
	Changes apply to new credits and new requests. Credits already given stay as they are.
</p>

<div class="mt-4 max-w-3xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'saved' in form}<Alert tone="info" message="Leave types saved." />{/if}
</div>

{#each data.types as t (t.id)}
	<section class="mt-6 max-w-3xl panel" aria-label={t.name}>
		<h2 class="section-title">
			{t.name}
			<span class="ml-2 text-xs font-normal text-slate-500">{t.code}{t.active ? '' : ' · inactive'}</span>
		</h2>
		<form method="POST" action="?/update" class="mt-3 grid gap-3 sm:grid-cols-2">
			<input type="hidden" name="typeId" value={t.id} />
			{@render fields(t)}
			<div class="sm:col-span-2"><Button type="submit">Save {t.name}</Button></div>
		</form>
	</section>
{/each}

<section class="mt-6 max-w-3xl panel" aria-label="New leave type">
	<h2 class="section-title">New leave type</h2>
	<form method="POST" action="?/create" class="mt-3 grid gap-3 sm:grid-cols-2">
		<label class="text-sm text-slate-700">
			Code
			<input name="code" required pattern="[a-z][a-z_]{'{1,29}'}" class={input} />
		</label>
		{@render fields(blank)}
		<div class="sm:col-span-2"><Button type="submit">Add leave type</Button></div>
	</form>
</section>
