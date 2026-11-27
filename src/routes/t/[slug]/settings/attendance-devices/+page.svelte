<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const input = 'input mt-1 block w-full';
	const when = (d: Date | string) => new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
</script>

<svelte:head><title>Attendance devices · {data.tenant.name}</title></svelte:head>

<h1 class="page-title">Attendance devices</h1>
<p class="mt-1 max-w-3xl text-sm text-slate-600">
	A fingerprint or card reader sends punches to <code>POST /api/v1/punches</code> with its own key. It can send up to
	500 punches at a time, matched by the device user ID below or by employee code. Punches older than 31 days or ahead of
	the clock are refused. A punch in a month whose payroll is already approved is kept and listed here for you to check;
	an arrears run within the lookback pays the difference. See
	<a class="text-brand-700 underline" href="/api/v1/openapi.json">the API description</a>.
</p>

<div class="mt-4 max-w-3xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'done' in form && typeof form.done === 'string'}<Alert tone="info" message={form.done} />{/if}
</div>

{#if form && 'key' in form && typeof form.key === 'string'}
	<section class="mt-6 max-w-3xl panel" aria-label="Device key">
		<h2 class="section-title">Copy the device key now</h2>
		<p class="mt-1 text-sm text-slate-600">
			It is shown only once. The device sends it as <code>Authorization: Bearer</code>.
		</p>
		<label class="mt-3 block text-sm text-slate-700">
			Device key
			<input readonly value={form.key} class={input} onfocus={(e) => e.currentTarget.select()} />
		</label>
	</section>
{/if}

<section class="mt-6 max-w-3xl panel" aria-label="New device">
	<h2 class="section-title">New device</h2>
	{#if !data.recent}
		<p class="mt-1 text-sm text-slate-600">
			Confirm it is you before adding a device or making a new key. This lasts 10 minutes.
		</p>
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
				Work site
				<select name="siteId" class={input}>
					<option value="">None</option>
					{#each data.sites as s (s.id)}<option value={s.id}>{s.name}</option>{/each}
				</select>
			</label>
			<label class="text-sm text-slate-700">
				Serial number
				<input name="serial" maxlength={64} class={input} />
			</label>
			<div class="sm:col-span-2"><Button type="submit">Add device</Button></div>
		</form>
	{/if}
</section>

{#each data.devices as d (d.id)}
	<section class="mt-6 max-w-3xl panel" aria-label={d.name}>
		<h2 class="section-title">{d.name}</h2>
		<p class="mt-1 text-sm text-slate-600" data-testid="device-state">
			<code>hrd_{d.prefix}_…</code> · {d.revoked ? 'Switched off' : 'On'}{d.siteName ? ` · ${d.siteName}` : ''}{d.serial
				? ` · ${d.serial}`
				: ''} · last seen {d.lastSeenAt ? when(d.lastSeenAt) : 'never'}
		</p>
		{#if !d.revoked}
			<div class="mt-3 flex flex-wrap gap-2">
				{#if data.recent}
					<form method="POST" action="?/rotate">
						<input type="hidden" name="deviceId" value={d.id} />
						<Button type="submit" variant="secondary">New key for {d.name}</Button>
					</form>
				{/if}
				<form method="POST" action="?/revoke">
					<input type="hidden" name="deviceId" value={d.id} />
					<Button type="submit" variant="secondary">Switch off {d.name}</Button>
				</form>
			</div>
		{/if}
	</section>
{/each}

<section class="mt-6 max-w-3xl panel" aria-label="Device user IDs">
	<h2 class="section-title">Device user IDs</h2>
	<p class="mt-1 text-sm text-slate-600">
		The number a person is enrolled under on the device. Leave it empty to clear it. People without one are matched by
		employee code.
	</p>
	<form method="POST" action="?/user" class="mt-3 grid gap-3 sm:grid-cols-3">
		<label class="text-sm text-slate-700">
			Employee code
			<input name="code" required maxlength={40} class={input} />
		</label>
		<label class="text-sm text-slate-700">
			Device user ID
			<input name="deviceUserId" maxlength={32} pattern="[A-Za-z0-9_.\-]*" class={input} />
		</label>
		<div class="sm:self-end"><Button type="submit">Save</Button></div>
	</form>
	{#if data.users.length}
		<ul class="mt-3 divide-y divide-slate-100 text-sm" data-testid="device-users">
			{#each data.users as u (u.code)}
				<li class="py-2">{u.code} · {u.fullName} · <code>{u.deviceUserId}</code></li>
			{/each}
		</ul>
	{/if}
</section>

<section class="mt-6 max-w-3xl panel" aria-label="Punches to check">
	<h2 class="section-title">Punches to check</h2>
	{#if data.review.length}
		<p class="mt-1 text-sm text-slate-600">
			These came in after that month's payroll was approved. Check the attendance, run arrears if pay changes, then mark
			them as checked.
		</p>
		<form method="POST" action="?/review" class="mt-3">
			<ul class="divide-y divide-slate-100 text-sm">
				{#each data.review as p (p.id)}
					<li class="py-2">
						<label class="flex items-start gap-2">
							<input type="checkbox" name="punchId" value={p.id} checked />
							<span data-testid="review-punch">
								{p.code} · {p.fullName} · {when(p.at)} · {p.device ?? p.source}
							</span>
						</label>
					</li>
				{/each}
			</ul>
			<div class="mt-3"><Button type="submit">Mark as checked</Button></div>
		</form>
	{:else}
		<p class="mt-1 text-sm text-slate-600">Nothing to check.</p>
	{/if}
</section>
