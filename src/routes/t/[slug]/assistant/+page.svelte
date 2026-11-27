<script lang="ts">
	import AskHr from '#lib/components/AskHr.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head><title>Ask HR · {data.tenant.name}</title></svelte:head>

<h1 class="page-title">Ask HR</h1>
<p class="mt-1 max-w-2xl text-sm text-slate-600">
	Ask about your leave, attendance, holidays, payslips or company policies. Ask HR looks only at what you may see.
</p>
<div class="mt-6 max-w-3xl rounded-xl bg-white p-5 ring-1 ring-slate-200">
	{#if data.ai.ask}
		<AskHr slug={data.tenant.slug} />
	{:else}
		<p class="text-sm text-slate-700">Ask HR is turned off. An owner can turn it on in Settings → AI.</p>
	{/if}
</div>
