<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import Field from '#lib/components/ui/Field.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<svelte:head><title>Account security · HRMS</title></svelte:head>

<main class="mx-auto max-w-lg space-y-8 px-4 py-12">
	<div class="flex items-center">
		<h1 class="page-title">Account security</h1>
		<a href="/" class="ml-auto text-sm text-brand-600 hover:underline">Back</a>
	</div>
	{#if data.required && !data.totpEnabled}
		<Alert message="Two-factor authentication is required for this area. Set it up to continue." />
	{/if}
	<Alert message={form?.message} />
	<Alert message={data.ssoError} />
	{#if data.locked}
		<Alert
			tone="info"
			message="You signed in with a company account. Sign in with your password to change these settings."
		/>
	{/if}

	{#if data.links.length}
		<section class="space-y-4 panel" aria-label="Company sign-in">
			<h2 class="section-title">Company sign-in</h2>
			{#if data.linkedNow}<Alert tone="info" message="Company sign-in linked." />{/if}
			{#if form && 'unlinked' in form}<Alert tone="info" message="Company sign-in unlinked." />{/if}
			{#if !data.locked && !data.recent}
				<p class="text-sm text-slate-600">Confirm your password to link or unlink. This lasts 10 minutes.</p>
				<form method="POST" action="?/reauth" class="space-y-3">
					<Field label="Your password" name="password" type="password" required autocomplete="current-password" />
					{#if data.totpEnabled}
						<Field label="Authenticator code" name="code" required inputmode="numeric" autocomplete="one-time-code" />
					{/if}
					<Button type="submit">Confirm</Button>
				</form>
			{/if}
			<ul class="divide-y divide-slate-100 text-sm">
				{#each data.links as l (l.tenantId)}
					<li class="flex flex-wrap items-center gap-2 py-2" data-testid="sso-link">
						<span>{l.name} · {l.provider === 'google' ? 'Google Workspace' : 'Microsoft Entra'}</span>
						<span class="text-slate-500">{l.linked ? 'Linked' : 'Not linked'}</span>
						{#if !data.locked && data.recent}
							{#if l.linked}
								<form method="POST" action="?/unlink" class="ml-auto">
									<input type="hidden" name="tenantId" value={l.tenantId} />
									<Button type="submit" variant="secondary">Unlink {l.name}</Button>
								</form>
							{:else}
								<a
									class="ml-auto text-brand-600 hover:underline"
									data-sveltekit-reload
									href="/sso/start?t={l.tenantId}&link=1"
								>
									Link {l.name}
								</a>
							{/if}
						{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	<section class="space-y-4 panel">
		<h2 class="section-title">Two-factor authentication</h2>
		{#if form && 'recoveryCodes' in form && form.recoveryCodes}
			<Alert tone="info" message="Two-factor authentication is on. Save these recovery codes now; each works once." />
			<ul data-testid="recovery-codes" class="grid grid-cols-2 gap-2 font-mono text-sm">
				{#each form.recoveryCodes as code (code)}<li>{code}</li>{/each}
			</ul>
		{:else if data.totpEnabled}
			<p class="text-sm text-slate-600">Two-factor authentication is on.</p>
			<form method="POST" action="?/disable" class="space-y-3">
				<Field label="Password" name="password" type="password" required autocomplete="current-password" />
				<Button type="submit" variant="danger">Turn off</Button>
			</form>
		{:else if form && 'enrol' in form && form.enrol}
			<p class="text-sm text-slate-600">
				Add this key to your authenticator app (Google Authenticator, 1Password, Authy…), then enter the 6-digit code.
			</p>
			<p data-testid="totp-secret" class="font-mono text-sm break-all">{form.enrol.secret}</p>
			<a href={form.enrol.uri} class="text-sm text-brand-600 hover:underline">Open in authenticator app</a>
			<form method="POST" action="?/confirm" class="space-y-3">
				<Field label="Code" name="code" inputmode="numeric" required maxlength={6} autocomplete="one-time-code" />
				<Button type="submit">Turn on</Button>
			</form>
		{:else}
			<p class="text-sm text-slate-600">Protect your account with a code from an authenticator app.</p>
			<form method="POST" action="?/begin"><Button type="submit">Set up</Button></form>
		{/if}
	</section>

	<section class="space-y-4 panel">
		<h2 class="section-title">Change password</h2>
		{#if form && 'passwordChanged' in form}
			<Alert tone="info" message="Password changed. Other devices were signed out." />
		{/if}
		<form method="POST" action="?/password" class="space-y-3">
			<Field label="Current password" name="current" type="password" required autocomplete="current-password" />
			<Field
				label="New password"
				name="next"
				type="password"
				required
				minlength={10}
				maxlength={128}
				autocomplete="new-password"
			/>
			<Field
				label="Repeat new password"
				name="confirm"
				type="password"
				required
				minlength={10}
				maxlength={128}
				autocomplete="new-password"
			/>
			<Button type="submit">Change password</Button>
		</form>
	</section>
</main>
