<script lang="ts">
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head><title>Choose organisation · HRMS</title></svelte:head>

<main class="mx-auto max-w-lg px-4 py-12">
	<h1 class="text-2xl font-semibold text-slate-900">Hello, {data.user.name}</h1>
	{#if data.tenants.length}
		<p class="mt-2 text-slate-600">Choose an organisation.</p>
		<ul class="mt-6 divide-y divide-slate-200 rounded-lg bg-white ring-1 ring-slate-200">
			{#each data.tenants as t (t.slug)}
				<li><a class="block px-4 py-3 hover:bg-slate-50" href="/t/{t.slug}">{t.name}</a></li>
			{/each}
		</ul>
	{:else}
		<p class="mt-2 text-slate-600">You are not a member of any organisation yet. Ask your HR team for an invitation.</p>
	{/if}
	<div class="mt-8 flex items-center gap-3">
		{#if data.user.isPlatformAdmin}
			<a href="/platform" class="text-sm font-semibold text-indigo-600 hover:underline">Platform admin</a>
		{/if}
		<a href="/account/security" class="text-sm text-indigo-600 hover:underline">Account security</a>
		<form method="POST" action="/logout" class="ml-auto">
			<Button type="submit" variant="secondary">Sign out</Button>
		</form>
	</div>
</main>
