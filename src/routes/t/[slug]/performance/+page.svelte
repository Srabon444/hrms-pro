<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import Field from '#lib/components/ui/Field.svelte';
	import { STAGE_LABELS } from '#lib/performance-labels.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const base = $derived(`/t/${data.tenant.slug}/performance`);
	const values = $derived((form && 'values' in form ? form.values : {}) as Record<string, string>);
	const lists = $derived([
		{ label: 'My reviews', rows: data.home.mine, empty: 'No reviews for you yet.' },
		{ label: 'Waiting for your rating', rows: data.home.toReview, empty: 'Nothing waiting for your rating.' },
		{ label: 'Waiting to finalise', rows: data.home.toFinalise, empty: 'Nothing waiting to finalise.' }
	]);
</script>

<svelte:head><title>Performance · {data.tenant.name}</title></svelte:head>

<h1 class="text-2xl font-semibold text-slate-900">Performance</h1>

<div class="mt-4 max-w-4xl">
	<Alert message={form?.message} />
</div>

{#if data.canRun}
	<section class="mt-4 max-w-4xl rounded-xl bg-white p-6 ring-1 ring-slate-200" aria-label="New review cycle">
		<h2 class="font-semibold text-slate-900">New review cycle</h2>
		<p class="mt-1 text-sm text-slate-600">Opens a review for every employee on probation, active or serving notice.</p>
		<form method="POST" action="?/cycle" class="mt-3 grid gap-3 sm:grid-cols-3">
			<Field label="Name" name="name" required maxlength={80} value={values.name ?? ''} />
			<Field label="Period starts" name="periodStart" type="date" required value={values.periodStart ?? ''} />
			<Field label="Period ends" name="periodEnd" type="date" required value={values.periodEnd ?? ''} />
			<div><Button type="submit">Open cycle</Button></div>
		</form>
	</section>
{/if}

{#each lists as list (list.label)}
	{#if list.label === 'My reviews' || list.rows.length}
		<section class="mt-6 max-w-4xl" aria-label={list.label}>
			<h2 class="font-semibold text-slate-900">{list.label}</h2>
			{#if list.rows.length}
				<ul class="mt-2 space-y-1 text-sm">
					{#each list.rows as r (r.id)}
						<li>
							<a class="text-indigo-700 underline" href={`${base}/reviews/${r.id}`}>{r.cycle} · {r.name}</a>
							<span class="text-slate-500">· {STAGE_LABELS[r.stage]}</span>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="mt-2 text-sm text-slate-600">{list.empty}</p>
			{/if}
		</section>
	{/if}
{/each}

<section class="mt-6 max-w-4xl" aria-label="Review cycles">
	<h2 class="font-semibold text-slate-900">Review cycles</h2>
	{#if data.home.cycles.length}
		<ul class="mt-2 space-y-1 text-sm">
			{#each data.home.cycles as c (c.id)}
				<li>
					<a class="text-indigo-700 underline" href={`${base}/${c.id}`}>{c.name}</a>
					<span class="text-slate-500">
						· {c.periodStart} to {c.periodEnd} · {c.status === 'open' ? 'Open' : 'Closed'}
					</span>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="mt-2 text-sm text-slate-600">No review cycles yet.</p>
	{/if}
</section>
