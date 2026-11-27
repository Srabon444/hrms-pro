<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import Field from '#lib/components/ui/Field.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<svelte:head><title>Company sign-in · HRMS</title></svelte:head>

<h1 class="text-lg font-semibold text-slate-900">Company sign-in</h1>
<Alert message={form?.message} />
{#if form && 'href' in form && form.href}
	<p class="text-sm text-slate-600">Your organisation signs in with its own account. You will come back here after.</p>
	<a
		href={form.href}
		data-sveltekit-reload
		class="inline-block rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white"
	>
		Continue to company sign-in
	</a>
{:else}
	<form method="POST" class="space-y-4">
		<input type="hidden" name="next" value={data.next} />
		<Field
			label="Work email"
			name="email"
			type="email"
			autocomplete="username"
			required
			value={form && 'email' in form ? form.email : ''}
		/>
		<Button type="submit">Continue</Button>
	</form>
{/if}
<a href="/login?next={encodeURIComponent(data.next)}" class="block text-sm text-brand-600 hover:underline">
	Back to sign in
</a>
