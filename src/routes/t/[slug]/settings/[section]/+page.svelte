<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import SettingInput from '#lib/components/ui/SettingInput.svelte';
	import { SETTING_SECTIONS } from '#lib/settings-sections.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const section = $derived(SETTING_SECTIONS[data.id]);
</script>

<svelte:head><title>{section.title} settings · {data.tenant.name}</title></svelte:head>

<h1 class="page-title">{section.title}</h1>
<p class="mt-1 text-sm text-slate-600">{section.intro}</p>

<form method="POST" class="mt-6 max-w-2xl space-y-5 panel">
	<Alert message={form?.message} />
	{#if form && 'saved' in form}<Alert tone="info" message="Settings saved." />{/if}
	{#each section.fields as f (f.key)}
		<SettingInput field={f} value={data.values[f.key]} locked={'ownerOnly' in f && !data.isOwner} />
	{/each}
	<Button type="submit">Save settings</Button>
</form>
