<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const input = 'input mt-1 block w-full';
	type Values = Partial<(typeof data.sites)[number]>;
	const blank: Values = { radiusM: 200, active: true, ipCidrs: [] };
	const rules = [
		{ value: 'off', label: 'Off: punches are not checked' },
		{ value: 'flag', label: 'Flag: punches away from a site are marked for HR' },
		{ value: 'block', label: 'Block: punches away from a site are refused (every branch needs a site)' }
	];
</script>

<svelte:head><title>Work sites · {data.tenant.name}</title></svelte:head>

{#snippet fields(v: Values)}
	<label class="text-sm text-slate-700">
		Name
		<input name="name" required maxlength={60} value={v.name ?? ''} class={input} />
	</label>
	<label class="text-sm text-slate-700">
		Branch
		<select name="branchId" class={input} value={v.branchId ?? ''}>
			<option value="">Every branch</option>
			{#each data.branches as b (b.id)}<option value={b.id}>{b.name}</option>{/each}
		</select>
	</label>
	<label class="text-sm text-slate-700">
		Latitude
		<input name="lat" type="number" step="any" min="-90" max="90" value={v.lat ?? ''} class={input} />
	</label>
	<label class="text-sm text-slate-700">
		Longitude
		<input name="lng" type="number" step="any" min="-180" max="180" value={v.lng ?? ''} class={input} />
	</label>
	<label class="text-sm text-slate-700">
		Radius (metres)
		<input name="radiusM" type="number" min="25" max="5000" required value={v.radiusM} class={input} />
	</label>
	<label class="text-sm text-slate-700 sm:col-span-2">
		Office networks (one per line, like 203.0.113.0/24)
		<textarea name="ipCidrs" rows="2" maxlength={2000} class={input}>{(v.ipCidrs ?? []).join('\n')}</textarea>
	</label>
	<label class="flex items-center gap-2 text-sm text-slate-700">
		<input type="checkbox" name="active" checked={!!v.active} />
		Active
	</label>
{/snippet}

<h1 class="page-title">Work sites</h1>
<p class="mt-1 max-w-3xl text-sm text-slate-600">
	A punch counts as on site when it comes from an office network or from a phone inside the site's radius. A browser's
	location can be faked, so office networks are the stronger check.
</p>

<div class="mt-4 max-w-3xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'saved' in form}<Alert tone="info" message="Work sites saved." />{/if}
</div>

<section class="mt-6 max-w-3xl panel" aria-label="Punch rule">
	<h2 class="section-title">Punch rule</h2>
	<form method="POST" action="?/rule" class="mt-3 flex flex-wrap items-end gap-3">
		<label class="min-w-0 flex-1 text-sm text-slate-700">
			Punches away from a work site
			<select name="rule" class={input} value={data.rule}>
				{#each rules as r (r.value)}<option value={r.value}>{r.label}</option>{/each}
			</select>
		</label>
		<Button type="submit">Save rule</Button>
	</form>
</section>

{#each data.sites as s (s.id)}
	<section class="mt-6 max-w-3xl panel" aria-label={s.name}>
		<h2 class="section-title">
			{s.name}{#if !s.active}<span class="ml-2 text-xs font-normal text-slate-500">inactive</span>{/if}
		</h2>
		<form method="POST" action="?/save" class="mt-3 grid gap-3 sm:grid-cols-2">
			<input type="hidden" name="siteId" value={s.id} />
			{@render fields(s)}
			<div class="sm:col-span-2"><Button type="submit">Save {s.name}</Button></div>
		</form>
	</section>
{/each}

<section class="mt-6 max-w-3xl panel" aria-label="New work site">
	<h2 class="section-title">New work site</h2>
	<form method="POST" action="?/save" class="mt-3 grid gap-3 sm:grid-cols-2">
		{@render fields(blank)}
		<div class="sm:col-span-2"><Button type="submit">Add site</Button></div>
	</form>
</section>
