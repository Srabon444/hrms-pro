<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import { STAGE_LABELS } from '#lib/performance-labels.ts';
	import { scoreLabel } from '#lib/domain/performance/score.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const v = $derived(data.view);
	const base = $derived(`/t/${data.tenant.slug}/performance`);
</script>

<svelte:head><title>{v.cycle.name} · Performance · {data.tenant.name}</title></svelte:head>

<a class="text-sm text-indigo-700 underline" href={base}>Performance</a>
<h1 class="mt-2 text-2xl font-semibold text-slate-900">{v.cycle.name}</h1>
<p class="text-sm text-slate-600">
	{v.cycle.periodStart} to {v.cycle.periodEnd} · {v.cycle.status === 'open' ? 'Open' : 'Closed'}
</p>

<div class="mt-4 max-w-4xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'done' in form}<Alert tone="info" message={form.done} />{/if}
</div>

{#if v.canClose}
	<form method="POST" action="?/close" class="mt-4">
		<Button type="submit" variant="secondary">Close cycle</Button>
	</form>
{/if}

<section class="mt-6 max-w-4xl" aria-label="Reviews">
	{#if v.rows.length}
		<table class="w-full text-left text-sm">
			<thead class="text-slate-500">
				<tr><th class="py-2">Employee</th><th>Stage</th><th>Score</th><th>Shared</th></tr>
			</thead>
			<tbody>
				{#each v.rows as r (r.id)}
					<tr class="border-t border-slate-100">
						<td class="py-2"><a class="text-indigo-700 underline" href={`${base}/reviews/${r.id}`}>{r.name}</a></td>
						<td>{STAGE_LABELS[r.stage]}</td>
						<td>{r.score === null ? '—' : scoreLabel(r.score)}</td>
						<td>{r.shared ? 'Yes' : 'No'}</td>
					</tr>
				{/each}
			</tbody>
		</table>
		{#if v.pages > 1}
			<nav class="mt-3 flex gap-3 text-sm" aria-label="Pages">
				{#if v.page > 1}<a class="text-indigo-700 underline" href={`?page=${v.page - 1}`}>Previous</a>{/if}
				<span class="text-slate-500">Page {v.page} of {v.pages}</span>
				{#if v.page < v.pages}<a class="text-indigo-700 underline" href={`?page=${v.page + 1}`}>Next</a>{/if}
			</nav>
		{/if}
	{:else}
		<p class="text-sm text-slate-600">No reviews you can see in this cycle.</p>
	{/if}
</section>
