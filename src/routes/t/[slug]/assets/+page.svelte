<script lang="ts">
	import Badge from '#lib/components/ui/Badge.svelte';
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import Field from '#lib/components/ui/Field.svelte';
	import { ASSET_STATUS_LABELS } from '#lib/asset-labels.ts';
	import { unit } from '#lib/money.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const base = $derived(`/t/${data.tenant.slug}/assets`);
	const values = $derived((form && 'values' in form ? form.values : {}) as Record<string, string>);
	const input = 'mt-1 block w-full input';
</script>

<svelte:head><title>Assets · {data.tenant.name}</title></svelte:head>

<h1 class="page-title">Assets</h1>

<div class="mt-4 max-w-5xl">
	<Alert message={form?.message} />
</div>

{#if data.canManage}
	<section class="mt-4 max-w-5xl panel" aria-label="New asset">
		<h2 class="section-title">New asset</h2>
		<form method="POST" action="?/save" class="mt-3 grid gap-3 sm:grid-cols-3">
			<Field
				label="Tag"
				name="tag"
				required
				maxlength={20}
				pattern={'[A-Za-z0-9][A-Za-z0-9\\-]{1,19}'}
				value={values.tag ?? ''}
			/>
			<Field label="Name" name="name" required maxlength={120} value={values.name ?? ''} />
			<Field label="Category" name="category" required maxlength={60} value={values.category ?? ''} />
			<Field label="Serial number" name="serial" maxlength={120} value={values.serial ?? ''} />
			<Field label="Purchase date" name="purchaseDate" type="date" value={values.purchaseDate ?? ''} />
			<Field
				label="Purchase cost ({unit(data.currency)})"
				name="purchaseCost"
				inputmode="decimal"
				pattern={'\\d{1,9}(\\.\\d{1,2})?'}
				value={values.purchaseCost ?? ''}
			/>
			<div><Button type="submit">Add asset</Button></div>
		</form>
	</section>
{/if}

<form method="GET" class="mt-6 flex max-w-5xl flex-wrap items-end gap-3" aria-label="Filter assets">
	<label class="block text-sm font-medium text-slate-700">
		Search
		<input name="q" maxlength="60" value={data.filter.q ?? ''} class={input} />
	</label>
	<label class="block text-sm font-medium text-slate-700">
		Status
		<select name="status" class={input}>
			<option value="">Any</option>
			{#each Object.entries(ASSET_STATUS_LABELS) as [value, label] (value)}
				<option {value} selected={data.filter.status === value}>{label}</option>
			{/each}
		</select>
	</label>
	<Button type="submit" variant="secondary">Filter</Button>
</form>

<section class="mt-4 max-w-5xl" aria-label="Asset list">
	{#if data.assets.length}
		<table class="data-table">
			<thead>
				<tr><th class="py-2">Tag</th><th>Name</th><th>Category</th><th>Status</th><th>With</th></tr>
			</thead>
			<tbody>
				{#each data.assets as a (a.id)}
					<tr class="border-t border-slate-200" data-testid="asset">
						<td class="py-2"><a class="text-brand-700 underline" href={`${base}/${a.id}`}>{a.tag}</a></td>
						<td>{a.name}</td>
						<td>{a.category}</td>
						<td><Badge status={a.status} label={ASSET_STATUS_LABELS[a.status]} /></td>
						<td>{a.holder ?? '—'}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{:else}
		<p class="text-sm text-slate-600">No assets found.</p>
	{/if}
</section>
