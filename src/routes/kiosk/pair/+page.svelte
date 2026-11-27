<script lang="ts">
	import { onMount } from 'svelte';
	import { replaceState } from '$app/navigation';
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { form }: PageProps = $props();
	let code = $state('');

	onMount(() => {
		const fromLink = location.hash.slice(1);
		if (fromLink) replaceState(location.pathname, {});
		code = fromLink;
	});
</script>

<svelte:head>
	<title>Set up kiosk</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<main class="grid min-h-screen place-items-center bg-slate-50 px-4 py-10">
	<div class="panel w-full max-w-sm space-y-4">
		<h1 class="page-title">Set up this kiosk</h1>
		{#if form && 'paired' in form}
			<Alert tone="info" message="This browser is now a kiosk." />
			<a href="/kiosk" class="block text-sm font-medium text-brand-700 underline">Open the kiosk</a>
		{:else}
			<Alert message={form?.message} />
			<p class="text-sm text-slate-600">
				Use this on the shared tablet only. It turns this browser into the kiosk HR set up.
			</p>
			<form method="POST" class="space-y-3">
				<input type="hidden" name="code" value={code} />
				<Button type="submit" disabled={!code}>Set up kiosk</Button>
			</form>
			{#if !code}<p class="text-sm text-slate-600">Open the pairing link HR gave you on this tablet.</p>{/if}
		{/if}
	</div>
</main>
