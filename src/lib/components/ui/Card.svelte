<script lang="ts">
	import type { Snippet } from 'svelte';

	let { title, href, children }: { title: string; href?: string; children: Snippet } = $props();
</script>

<section class="rounded-xl bg-white p-5 ring-1 ring-slate-200" aria-label={title}>
	<h2 class="flex items-baseline justify-between gap-2 font-semibold text-slate-900">
		{title}
		{#if href}<a class="text-sm font-normal text-brand-700 underline" {href}>Open</a>{/if}
	</h2>
	<div class="mt-3 text-sm text-slate-800">{@render children()}</div>
</section>
