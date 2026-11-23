<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import Field from '#lib/components/ui/Field.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<svelte:head><title>Verify · HRMS</title></svelte:head>

{#if data.stage === 'stepup'}
	<h1 class="text-lg font-semibold text-slate-900">Check your email</h1>
	<p class="text-sm text-slate-600">
		We saw failed sign-in attempts from several places, so we emailed you a 6-digit code.
	</p>
{:else}
	<h1 class="text-lg font-semibold text-slate-900">Two-factor authentication</h1>
	<p class="text-sm text-slate-600">Enter the code from your authenticator app, or one of your recovery codes.</p>
{/if}
<Alert message={form?.message} />
<form method="POST" class="space-y-4">
	<input type="hidden" name="next" value={data.next} />
	<Field label="Code" name="code" autocomplete="one-time-code" required maxlength={32} />
	<Button type="submit">Verify</Button>
</form>
