<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const r = $derived(data.report);
	const query = $derived(
		r
			? new URLSearchParams({
					from: r.params.from,
					to: r.params.to,
					department: r.params.departmentId ?? ''
				}).toString()
			: ''
	);
	const field = 'mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm';
</script>

<svelte:head><title>{r?.title ?? 'Report'} · {data.tenant.name}</title></svelte:head>

<a class="text-sm text-indigo-700 underline" href={`/t/${data.tenant.slug}/reports`}>All reports</a>
<h1 class="mt-2 text-2xl font-semibold text-slate-900">{r?.title ?? 'Report'}</h1>

<form method="GET" class="mt-4 grid max-w-3xl items-end gap-3 sm:grid-cols-4" aria-label="Filters">
	<label class="block text-sm font-medium text-slate-700">
		From
		<input name="from" type="date" value={r?.params.from ?? data.filters.from ?? ''} class={field} />
	</label>
	<label class="block text-sm font-medium text-slate-700">
		To
		<input name="to" type="date" value={r?.params.to ?? data.filters.to ?? ''} class={field} />
	</label>
	<label class="block text-sm font-medium text-slate-700">
		Department
		<select name="department" class={field}>
			<option value="">All departments</option>
			{#each data.departments as d (d.id)}
				<option value={d.id} selected={d.id === (r?.params.departmentId ?? data.filters.department)}>{d.name}</option>
			{/each}
		</select>
	</label>
	<div><Button type="submit" variant="secondary">Show</Button></div>
</form>

<div class="mt-4 max-w-3xl"><Alert message={data.message} /></div>

{#if r}
	<div class="mt-4 flex gap-3 text-sm">
		<a class="text-indigo-700 underline" href={`/t/${data.tenant.slug}/reports/${r.id}/export?format=csv&${query}`}>
			Download CSV
		</a>
		<a class="text-indigo-700 underline" href={`/t/${data.tenant.slug}/reports/${r.id}/export?format=pdf&${query}`}>
			Download PDF
		</a>
	</div>
	{#each r.sections as s (s.key)}
		<section class="mt-6 max-w-5xl" aria-label={s.title}>
			<h2 class="font-semibold text-slate-900">{s.title}</h2>
			<table class="mt-2 w-full text-left text-sm">
				<thead class="text-slate-500">
					<tr>
						{#each s.columns as c (c.key)}<th class={['py-2', c.numeric && 'text-right']}>{c.label}</th>{/each}
					</tr>
				</thead>
				<tbody>
					{#each s.rows as row, i (i)}
						<tr class="border-t border-slate-200" data-testid={`row-${s.key}`}>
							{#each s.columns as c (c.key)}
								<td class={['py-2', c.numeric && 'text-right tabular-nums']}>{row.cells[c.key] ?? '—'}</td>
							{/each}
						</tr>
					{:else}
						<tr><td colspan={s.columns.length} class="py-2 text-slate-500">Nothing in this period.</td></tr>
					{/each}
				</tbody>
			</table>
		</section>
	{/each}
{/if}
