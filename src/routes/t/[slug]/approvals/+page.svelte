<script lang="ts">
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head><title>Approvals · {data.tenant.name}</title></svelte:head>

<h1 class="text-2xl font-semibold text-slate-900">Approvals</h1>

{#if data.items.length === 0}
	<p class="mt-6 text-sm text-slate-600">Nothing is waiting for your decision.</p>
{:else}
	<ul class="mt-6 divide-y divide-slate-200 rounded-xl bg-white ring-1 ring-slate-200">
		{#each data.items as item (item.id)}
			<li class="p-4" data-testid="approval">
				<a href="/t/{data.tenant.slug}/{item.link}" class="font-medium text-indigo-700 hover:underline">{item.title}</a>
				<p class="text-sm text-slate-600">{item.kind} · {item.requestedBy} · {item.at.toLocaleDateString()}</p>
			</li>
		{/each}
	</ul>
{/if}
