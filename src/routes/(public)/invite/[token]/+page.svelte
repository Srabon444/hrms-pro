<script lang="ts">
	import { page } from '$app/state';
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import Field from '#lib/components/ui/Field.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const inv = $derived(data.invitation);
</script>

<svelte:head><title>Invitation · HRMS</title></svelte:head>

<h1 class="text-lg font-semibold text-slate-900">Join {inv.tenantName}</h1>
<p class="text-sm text-slate-600">This invitation is for <strong>{inv.email}</strong>.</p>
<Alert message={form?.message} />

{#if data.signedInAs && data.signedInAs === inv.email}
	<form method="POST" action="?/accept">
		<Button type="submit">Accept invitation</Button>
	</form>
{:else if data.signedInAs}
	<Alert message="You are signed in as {data.signedInAs}. Sign out, then open this link again." />
	<form method="POST" action="/logout"><Button type="submit" variant="secondary">Sign out</Button></form>
{:else if inv.userExists}
	<a
		href="/login?next={encodeURIComponent(page.url.pathname)}"
		class="inline-flex rounded-lg bg-brand-600 px-3.5 py-1.5 text-sm font-medium text-white no-underline hover:bg-brand-700"
	>
		Sign in to accept
	</a>
{:else}
	{#if data.sso}
		<a
			href="/sso/start?invite={encodeURIComponent(page.params.token ?? '')}"
			data-sveltekit-reload
			class="inline-flex rounded-lg bg-brand-600 px-3.5 py-1.5 text-sm font-medium text-white no-underline hover:bg-brand-700"
		>
			Accept with company sign-in
		</a>
		<p class="text-sm text-slate-600">Or set a password:</p>
	{/if}
	<form method="POST" action="?/register" class="space-y-4">
		<Field
			label="Your name"
			name="name"
			required
			maxlength={120}
			autocomplete="name"
			value={form && 'name' in form ? form.name : ''}
		/>
		<Field
			label="Password"
			name="password"
			type="password"
			required
			minlength={10}
			maxlength={128}
			autocomplete="new-password"
		/>
		<Field
			label="Repeat password"
			name="confirm"
			type="password"
			required
			minlength={10}
			maxlength={128}
			autocomplete="new-password"
		/>
		<Button type="submit">Create account and join</Button>
	</form>
{/if}
