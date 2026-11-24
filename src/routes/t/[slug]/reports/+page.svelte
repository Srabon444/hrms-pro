<script lang="ts">
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head><title>Reports · {data.tenant.name}</title></svelte:head>

<h1 class="page-title">Reports</h1>
<ul class="mt-6 grid max-w-3xl gap-3 sm:grid-cols-2">
	{#each data.reports as r (r.id)}
		<li>
			<a
				class="block rounded-xl bg-white p-4 font-medium text-brand-700 ring-1 ring-slate-200 hover:ring-brand-300"
				href={`/t/${data.tenant.slug}/reports/${r.id}`}
			>
				{r.title}
			</a>
		</li>
	{/each}
</ul>

<section class="mt-8 max-w-3xl" aria-label="Shared reports">
	<h2 class="section-title">Shared reports</h2>
	<ul class="mt-2 divide-y divide-slate-200 text-sm">
		{#each data.shares as s (s.id)}
			<li class="flex justify-between gap-3 py-2" data-testid="shared-report">
				<a class="text-brand-700 underline" href={`/t/${data.tenant.slug}/reports/shared/${s.id}`}>
					{s.title} · {s.period}
				</a>
				<span class="text-slate-500">{s.mine ? 'Shared by you' : `From ${s.sharer}`} · until {s.expiresOn}</span>
			</li>
		{:else}
			<li class="py-2 text-slate-500">Nothing shared yet.</li>
		{/each}
	</ul>
</section>
