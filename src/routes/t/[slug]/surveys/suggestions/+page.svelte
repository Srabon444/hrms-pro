<script lang="ts">
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head><title>Suggestions · {data.tenant.name}</title></svelte:head>

<a class="text-sm text-brand-700 underline" href={`/t/${data.tenant.slug}/surveys`}>Surveys</a>
<h1 class="page-title mt-2">Suggestions</h1>
<p class="mt-1 max-w-3xl text-sm text-slate-600">
	Suggestions carry no names. New ones appear here only once at least {data.minGroupSize} have arrived, together and in random
	order, so nobody can be matched to a suggestion by when it was sent.
</p>

<ul class="mt-4 max-w-3xl space-y-2" aria-label="Suggestions">
	{#each data.entries as e, i (i)}
		<li class="panel text-sm break-words whitespace-pre-line text-slate-700" data-testid="suggestion">{e.text}</li>
	{:else}
		<li class="text-sm text-slate-600">No suggestions to show yet.</li>
	{/each}
</ul>
