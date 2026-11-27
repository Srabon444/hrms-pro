<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const input = 'input mt-1 block w-full';
	const c = $derived(data.connection);
	const stateLine = $derived(
		c
			? [
					c.active ? 'On' : 'Off',
					c.enforce ? 'Required for everyone but the owner' : 'Optional',
					`${data.linked} ${data.linked === 1 ? 'person' : 'people'} linked`
				].join(' · ')
			: ''
	);
	let provider = $derived(data.connection?.provider ?? 'google');
</script>

<svelte:head><title>Company sign-in · {data.tenant.name}</title></svelte:head>

<h1 class="page-title">Company sign-in</h1>
<p class="mt-1 max-w-3xl text-sm text-slate-600">
	Let people sign in with their Google Workspace or Microsoft Entra account. Only email domains you prove you own can
	sign in. A company account opens this organisation only. Each person links it once while signed in with their
	password, or accepts an invitation with it.
</p>

<div class="mt-4 max-w-3xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'done' in form && typeof form.done === 'string'}<Alert tone="info" message={form.done} />{/if}
</div>

{#if !data.recent}
	<section class="mt-6 max-w-3xl panel" aria-label="Confirm it is you">
		<h2 class="section-title">Confirm it is you</h2>
		<p class="mt-1 text-sm text-slate-600">Changes here need your password. This lasts 10 minutes.</p>
		<form method="POST" action="?/reauth" class="mt-3 grid gap-3 sm:grid-cols-2">
			<label class="text-sm text-slate-700">
				Your password
				<input name="password" type="password" required autocomplete="current-password" class={input} />
			</label>
			{#if data.totp}
				<label class="text-sm text-slate-700">
					Authenticator code
					<input name="code" required inputmode="numeric" autocomplete="one-time-code" maxlength={6} class={input} />
				</label>
			{/if}
			<div class="sm:col-span-2"><Button type="submit">Confirm</Button></div>
		</form>
	</section>
{/if}

<section class="mt-6 max-w-3xl panel" aria-label="Connection">
	<h2 class="section-title">Connection</h2>
	<p class="mt-1 text-sm text-slate-600">
		Register this redirect address with your provider: <code class="break-all" data-testid="redirect-uri">
			{data.redirectUri}
		</code>
	</p>
	<form method="POST" action="?/save" class="mt-3 grid gap-3 sm:grid-cols-2">
		<label class="text-sm text-slate-700">
			Provider
			<select name="provider" bind:value={provider} class={input}>
				<option value="google">Google Workspace</option>
				<option value="entra">Microsoft Entra</option>
			</select>
		</label>
		<label class="text-sm text-slate-700">
			Client ID
			<input name="clientId" required maxlength={200} value={c?.clientId ?? ''} class={input} />
		</label>
		<label class="text-sm text-slate-700">
			Client secret
			<input
				name="clientSecret"
				type="password"
				maxlength={500}
				required={!c}
				autocomplete="off"
				placeholder={c ? 'Leave empty to keep the saved secret' : ''}
				class={input}
			/>
		</label>
		{#if provider === 'entra'}
			<label class="text-sm text-slate-700">
				Directory (tenant) ID
				<input name="entraTenantId" required value={c?.entraTenantId ?? ''} class={input} />
			</label>
		{/if}
		<div class="sm:col-span-2"><Button type="submit" disabled={!data.recent}>Save connection</Button></div>
	</form>
	{#if c}
		<p class="mt-3 text-sm text-slate-600" data-testid="sso-state">{stateLine}</p>
		<div class="mt-3 flex flex-wrap gap-2">
			<form method="POST" action="?/state">
				<input type="hidden" name="active" value={c.active ? 'off' : 'on'} />
				<Button type="submit" variant="secondary" disabled={!data.recent}>
					{c.active ? 'Turn off company sign-in' : 'Turn on company sign-in'}
				</Button>
			</form>
			{#if c.active}
				<form method="POST" action="?/state">
					<input type="hidden" name="enforce" value={c.enforce ? 'off' : 'on'} />
					<Button type="submit" variant="secondary" disabled={!data.recent}>
						{c.enforce ? 'Stop requiring it' : 'Require it for everyone but the owner'}
					</Button>
				</form>
			{/if}
		</div>
	{/if}
</section>

{#if c}
	<section class="mt-6 max-w-3xl panel" aria-label="Email domains">
		<h2 class="section-title">Email domains</h2>
		<p class="mt-1 text-sm text-slate-600">
			Add a TXT record on each domain with the value <code class="break-all" data-testid="txt-value">
				hrms-sso-verify={c.verifyToken}
			</code>, then check it.
		</p>
		<form method="POST" action="?/domain" class="mt-3 flex flex-wrap items-end gap-2">
			<label class="text-sm text-slate-700">
				Domain
				<input name="domain" required maxlength={253} placeholder="example.com" class={input} />
			</label>
			<Button type="submit" disabled={!data.recent}>Add domain</Button>
		</form>
		<ul class="mt-3 divide-y divide-slate-100 text-sm">
			{#each data.domains as d (d.id)}
				<li class="flex flex-wrap items-center gap-2 py-2" data-testid="sso-domain">
					<span class="break-all">{d.domain}</span>
					<span class="text-slate-500">{d.verifiedAt ? 'Verified' : 'Not verified'}</span>
					<span class="flex flex-wrap gap-2 sm:ml-auto">
						{#if !d.verifiedAt}
							<form method="POST" action="?/verify">
								<input type="hidden" name="domainId" value={d.id} />
								<Button type="submit" variant="secondary" disabled={!data.recent}>Check {d.domain}</Button>
							</form>
						{/if}
						<form method="POST" action="?/remove">
							<input type="hidden" name="domainId" value={d.id} />
							<Button type="submit" variant="secondary" disabled={!data.recent}>Remove {d.domain}</Button>
						</form>
					</span>
				</li>
			{/each}
		</ul>
	</section>
{/if}

{#if c}
	<section class="mt-6 max-w-3xl panel" aria-label="Provisioning (SCIM)">
		<h2 class="section-title">Provisioning (SCIM)</h2>
		<p class="mt-1 text-sm text-slate-600">
			Let your identity provider add and deactivate people here. It only adds people in verified domains, never changes
			owners, and never turns back on someone HR or an exit turned off. Base URL:
			<code class="break-all" data-testid="scim-url">{data.scimUrl}</code>
		</p>
		{#if form && 'scimToken' in form && typeof form.scimToken === 'string'}
			<p class="mt-3 text-sm text-slate-700">Token (shown once):</p>
			<code class="mt-1 block break-all rounded bg-slate-100 p-2 text-sm" data-testid="scim-token">
				{form.scimToken}
			</code>
		{/if}
		<p class="mt-3 text-sm text-slate-600" data-testid="scim-state">
			{c.scimPrefix ? `Token hrs_${c.scimPrefix}_… is active.` : 'No token yet.'}
		</p>
		<div class="mt-3 flex flex-wrap gap-2">
			<form method="POST" action="?/scim">
				<Button type="submit" variant="secondary" disabled={!data.recent}>
					{c.scimPrefix ? 'Replace token' : 'Create token'}
				</Button>
			</form>
			{#if c.scimPrefix}
				<form method="POST" action="?/scimRevoke">
					<Button type="submit" variant="secondary" disabled={!data.recent}>Revoke token</Button>
				</form>
			{/if}
		</div>
	</section>
{/if}
