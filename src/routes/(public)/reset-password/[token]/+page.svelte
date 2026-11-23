<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import Field from '#lib/components/ui/Field.svelte';
	import type { PageProps } from './$types';

	let { form }: PageProps = $props();
</script>

<svelte:head><title>Choose a new password · HRMS</title></svelte:head>

<h1 class="text-lg font-semibold text-slate-900">Choose a new password</h1>
<Alert message={form?.message} />
<form method="POST" class="space-y-4">
	<Field
		label="New password"
		name="password"
		type="password"
		autocomplete="new-password"
		required
		minlength={10}
		maxlength={128}
	/>
	<Field
		label="Repeat new password"
		name="confirm"
		type="password"
		autocomplete="new-password"
		required
		minlength={10}
		maxlength={128}
	/>
	<p class="text-xs text-slate-500">At least 10 characters. Avoid common passwords and your email address.</p>
	<Button type="submit">Set password</Button>
</form>
