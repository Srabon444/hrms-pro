<script lang="ts">
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head><title>Careers · {data.tenant}</title></svelte:head>

<main class="mx-auto min-h-screen max-w-3xl bg-slate-50 px-4 py-10">
	<h1 class="page-title">Careers at {data.tenant}</h1>
	{#if data.openings.length}
		<ul class="mt-6 space-y-3">
			{#each data.openings as o (o.slug)}
				<li class="panel">
					<a class="font-semibold text-brand-700 underline" href={`/careers/${data.slug}/${o.slug}`}>{o.title}</a>
					{#if o.department || o.designation}
						<p class="mt-1 text-sm text-slate-600">{[o.designation, o.department].filter(Boolean).join(' · ')}</p>
					{/if}
				</li>
			{/each}
		</ul>
	{:else}
		<p class="mt-6 text-sm text-slate-600">There are no open jobs right now. Check back later.</p>
	{/if}
</main>
