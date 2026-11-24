<script lang="ts">
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const groups = $derived(Map.groupBy(data.settingsPages, (p) => p.group));
</script>

<svelte:head><title>Settings · {data.tenant.name}</title></svelte:head>

<h1 class="page-title">Settings</h1>
<p class="mt-1 text-sm text-slate-600">Every rule the system follows for this organisation.</p>

{#each groups as [group, pages] (group)}
	<section class="mt-8" aria-label={group}>
		<h2 class="text-sm font-medium text-slate-500">{group}</h2>
		<ul class="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
			{#each pages as p (p.href)}
				<li class="relative rounded-xl bg-white p-4 ring-1 ring-slate-200 hover:ring-brand-300">
					<a
						href="/t/{data.tenant.slug}/settings/{p.href}"
						class="font-medium text-slate-900 after:absolute after:inset-0"
					>
						{p.label}
					</a>
					<p class="mt-1 text-sm text-slate-600">{p.about}</p>
				</li>
			{/each}
		</ul>
	</section>
{/each}
