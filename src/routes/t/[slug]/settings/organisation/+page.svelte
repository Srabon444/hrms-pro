<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import Field from '#lib/components/ui/Field.svelte';
	import LocaleFields from '#lib/components/LocaleFields.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const s = $derived(data.settings);
</script>

<svelte:head><title>General settings · {data.tenant.name}</title></svelte:head>

<h1 class="page-title">General</h1>

<form method="POST" class="mt-6 max-w-2xl space-y-6 panel">
	<Alert message={form?.message} />
	{#if form && 'saved' in form}<Alert tone="info" message="Settings saved." />{/if}
	<div class="grid gap-4 sm:grid-cols-2">
		<Field label="Legal name" name="legalName" maxlength={200} value={s.legalName} />
		<Field label="Employee code prefix" name="employeeCodePrefix" required value={s.employeeCodePrefix} />
		<div class="sm:col-span-2"><Field label="Address" name="address" maxlength={500} value={s.address} /></div>
		<LocaleFields value={s} timezones={data.timezones} currencies={data.currencies} />
	</div>
	<Button type="submit">Save settings</Button>
</form>
