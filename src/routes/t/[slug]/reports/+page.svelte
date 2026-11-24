<script lang="ts">
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head><title>Reports · {data.tenant.name}</title></svelte:head>

<h1 class="text-2xl font-semibold text-slate-900">Reports</h1>
<ul class="mt-6 grid max-w-3xl gap-3 sm:grid-cols-2">
	{#each data.reports as r (r.id)}
		<li>
			<a
				class="block rounded-xl bg-white p-4 font-medium text-indigo-700 ring-1 ring-slate-200 hover:ring-indigo-300"
				href={`/t/${data.tenant.slug}/reports/${r.id}`}
			>
				{r.title}
			</a>
		</li>
	{/each}
</ul>
