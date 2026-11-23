<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import Field from '#lib/components/ui/Field.svelte';
	import type { PageProps } from './$types';

	let { form }: PageProps = $props();
</script>

<svelte:head><title>Reset password · HRMS</title></svelte:head>

<h1 class="text-lg font-semibold text-slate-900">Reset your password</h1>
{#if form && 'sent' in form}
	<Alert tone="info" message="If an account exists for that email, we sent a reset link. It expires in 30 minutes." />
{:else}
	<Alert message={form?.message} />
	<form method="POST" class="space-y-4">
		<Field label="Email" name="email" type="email" autocomplete="username" required />
		<Button type="submit">Send reset link</Button>
	</form>
{/if}
<a href="/login" class="block text-sm text-indigo-600 hover:underline">Back to sign in</a>
