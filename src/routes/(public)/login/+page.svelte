<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import Field from '#lib/components/ui/Field.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const notices: Record<string, string> = {
		reset: 'Your password was changed. Sign in with the new one.',
		expired: 'That sign-in step expired. Please sign in again.',
		signedout: 'You have been signed out.'
	};
</script>

<svelte:head><title>Sign in · HRMS</title></svelte:head>

<h1 class="text-lg font-semibold text-slate-900">Sign in</h1>
<Alert tone="info" message={data.notice ? notices[data.notice] : null} />
<Alert message={form?.message} />
<form method="POST" class="space-y-4">
	<input type="hidden" name="next" value={data.next} />
	<Field
		label="Email"
		name="email"
		type="email"
		autocomplete="username"
		required
		value={form && 'email' in form ? form.email : ''}
	/>
	<Field label="Password" name="password" type="password" autocomplete="current-password" required maxlength={128} />
	<Button type="submit">Sign in</Button>
</form>
<a href="/forgot-password" class="block text-sm text-indigo-600 hover:underline">Forgot your password?</a>
