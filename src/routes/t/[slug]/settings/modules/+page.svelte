<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import { MODULE_IDS, MODULES } from '#lib/modules.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<svelte:head><title>Modules · {data.tenant.name}</title></svelte:head>

<h1 class="page-title">Modules</h1>
<p class="mt-1 text-sm text-slate-600">
	Turn parts of the app on or off. A module that is off leaves the menu and its pages.
</p>

<form method="POST" class="mt-6 max-w-2xl space-y-5 panel">
	<Alert message={form?.message} />
	{#if form && 'saved' in form}<Alert tone="info" message="Modules saved." />{/if}
	{#each MODULE_IDS as id (id)}
		<label class="flex items-start gap-3">
			<input type="checkbox" name="modules" value={id} checked={data.on.includes(id)} class="mt-1" />
			<span>
				<span class="block text-sm font-medium text-slate-800">{MODULES[id].label}</span>
				<span class="block text-sm text-slate-600">{MODULES[id].about}</span>
			</span>
		</label>
	{/each}
	<Button type="submit">Save modules</Button>
</form>
