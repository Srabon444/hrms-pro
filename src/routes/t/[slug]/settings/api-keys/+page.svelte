<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const input = 'input mt-1 block w-full';
	const when = (d: Date | string | null) =>
		d ? new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never';
	const LABELS: Record<string, string> = {
		'employee.read': 'Employees',
		'leave.read': 'Leave requests',
		'attendance.read': 'Attendance days',
		'schedule.read': 'Roster',
		'calendar.read': 'Events'
	};
	const SCOPE_LABELS: Record<string, string> = {
		own: 'only me',
		team: 'my team',
		department: 'my department',
		all: 'everyone'
	};
	const state = (k: (typeof data.keys)[number]) =>
		k.revokedAt ? 'Revoked' : k.expired ? 'Expired' : `Works until ${when(k.expiresAt)}`;
	const grantText = (g: Record<string, string>) =>
		Object.entries(g)
			.map(([p, s]) => `${LABELS[p] ?? p} (${SCOPE_LABELS[s] ?? s})`)
			.join(', ');
</script>

<svelte:head><title>API keys · {data.tenant.name}</title></svelte:head>

<h1 class="page-title">API keys</h1>
<p class="mt-1 max-w-3xl text-sm text-slate-600">
	A key lets another system read data through the REST API at <code>/api/v1</code>. A key never reads more than its
	creator can read today: if you lose access, the key loses it too. Changing or resetting your password, or turning off
	two-factor sign-in, revokes the keys you made. See
	<a class="text-brand-700 underline" href="/api/v1/openapi.json">the API description</a>.
</p>

<div class="mt-4 max-w-3xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'done' in form && typeof form.done === 'string'}<Alert tone="info" message={form.done} />{/if}
</div>

{#if form && 'key' in form && typeof form.key === 'string'}
	<section class="mt-6 max-w-3xl panel" aria-label="New key">
		<h2 class="section-title">Copy your new key now</h2>
		<p class="mt-1 text-sm text-slate-600">It is shown only once. Send it as <code>Authorization: Bearer</code>.</p>
		<label class="mt-3 block text-sm text-slate-700">
			API key
			<input readonly value={form.key} class={input} onfocus={(e) => e.currentTarget.select()} />
		</label>
	</section>
{/if}

<section class="mt-6 max-w-3xl panel" aria-label="New API key">
	<h2 class="section-title">New API key</h2>
	{#if !data.recent}
		<p class="mt-1 text-sm text-slate-600">Confirm it is you before making a key. This lasts 10 minutes.</p>
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
	{:else}
		<form method="POST" action="?/create" class="mt-3 grid gap-3 sm:grid-cols-2">
			<label class="text-sm text-slate-700">
				Name
				<input name="name" required maxlength={60} class={input} />
			</label>
			<label class="text-sm text-slate-700">
				Works for
				<select name="days" class={input} value="90">
					{#each data.days as d (d)}<option value={String(d)}>{d === 365 ? '1 year' : `${d} days`}</option>{/each}
				</select>
			</label>
			<fieldset class="sm:col-span-2">
				<legend class="text-sm text-slate-700">What it can read</legend>
				<div class="mt-1 grid gap-3 sm:grid-cols-2">
					{#each data.grantable as g (g.permission)}
						<label class="text-sm text-slate-700">
							{LABELS[g.permission]}
							<select name={`grant.${g.permission}`} class={input} disabled={!g.scopes.length}>
								<option value="">No access</option>
								{#each g.scopes as s (s)}<option value={s}>{SCOPE_LABELS[s]}</option>{/each}
							</select>
						</label>
					{/each}
				</div>
			</fieldset>
			<div class="sm:col-span-2"><Button type="submit">Make key</Button></div>
		</form>
	{/if}
</section>

{#each data.keys as k (k.id)}
	<section class="mt-6 max-w-3xl panel" aria-label={k.name}>
		<h2 class="section-title">{k.name}</h2>
		<p class="mt-1 text-sm text-slate-600" data-testid="api-key-state">
			<code>hrp_{k.prefix}_…</code> · {state(k)} · last used {k.lastUsedAt
				? new Date(k.lastUsedAt).toLocaleDateString(undefined, { dateStyle: 'medium' })
				: 'never'}
		</p>
		<p class="mt-1 text-sm text-slate-600">Reads {grantText(k.grants)}. Made by {k.createdBy}.</p>
		{#if !k.revokedAt}
			<form method="POST" action="?/revoke" class="mt-3">
				<input type="hidden" name="keyId" value={k.id} />
				<Button type="submit" variant="secondary">Revoke {k.name}</Button>
			</form>
		{/if}
	</section>
{/each}
