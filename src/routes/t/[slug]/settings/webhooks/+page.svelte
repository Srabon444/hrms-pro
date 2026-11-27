<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const input = 'input mt-1 block w-full';
	const when = (d: Date | string) => new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
	const LABELS: Record<string, string> = {
		'employee.created': 'Employee added',
		'employee.updated': 'Employee changed',
		'leave_request.created': 'Leave requested',
		'leave_request.updated': 'Leave approved, declined or cancelled'
	};
	const STATUS: Record<string, string> = { pending: 'Waiting to retry', delivered: 'Delivered', failed: 'Failed' };
	const urlOf = (id: string) => data.endpoints.find((e) => e.id === id)?.url ?? 'a deleted endpoint';
</script>

<svelte:head><title>Webhooks · {data.tenant.name}</title></svelte:head>

<h1 class="page-title">Webhooks</h1>
<p class="mt-1 max-w-3xl text-sm text-slate-600">
	A webhook tells another system when something changes. We send a signed POST with the event name and ids, never
	personal details; read the record through the REST API. Check the <code>X-HRMS-Signature</code> header (<code>
		t=&lt;seconds&gt;,v1=&lt;HMAC-SHA256 of "t.body"&gt;
	</code>) and reject anything older than five minutes. A failed delivery is tried 8 times over about two days. After 50
	failures in a row the endpoint turns off and people who manage API access are told.
</p>

<div class="mt-4 max-w-3xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'done' in form && typeof form.done === 'string'}<Alert tone="info" message={form.done} />{/if}
</div>

{#if form && 'secret' in form && typeof form.secret === 'string'}
	<section class="mt-6 max-w-3xl panel" aria-label="Signing secret">
		<h2 class="section-title">Copy the signing secret now</h2>
		<p class="mt-1 text-sm text-slate-600">It is shown only once. Use it to check each request's signature.</p>
		<label class="mt-3 block text-sm text-slate-700">
			Signing secret
			<input readonly value={form.secret} class={input} onfocus={(e) => e.currentTarget.select()} />
		</label>
	</section>
{/if}

<section class="mt-6 max-w-3xl panel" aria-label="New endpoint">
	<h2 class="section-title">New endpoint</h2>
	{#if data.endpoints.length >= data.max}
		<p class="mt-1 text-sm text-slate-600">You have {data.max} endpoints, the most allowed. Delete one first.</p>
	{:else if !data.recent}
		<p class="mt-1 text-sm text-slate-600">
			Confirm it is you before adding an endpoint or making a new secret. This lasts 10 minutes.
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
		<form method="POST" action="?/create" class="mt-3 grid gap-3">
			<label class="text-sm text-slate-700">
				Address
				<input
					name="url"
					type="url"
					required
					maxlength={500}
					pattern="https://.*"
					placeholder="https://example.com/hooks/hrms"
					class={input}
				/>
			</label>
			<fieldset>
				<legend class="text-sm text-slate-700">Send these events</legend>
				<div class="mt-1 grid gap-2 sm:grid-cols-2">
					{#each data.events as ev (ev)}
						<label class="flex items-center gap-2 text-sm text-slate-700">
							<input type="checkbox" name="events" value={ev} checked />
							{LABELS[ev]}
						</label>
					{/each}
				</div>
			</fieldset>
			<div><Button type="submit">Add endpoint</Button></div>
		</form>
	{/if}
</section>

{#each data.endpoints as e (e.id)}
	<section class="mt-6 max-w-3xl panel" aria-label={e.url}>
		<h2 class="section-title break-all">{e.url}</h2>
		<p class="mt-1 text-sm text-slate-600" data-testid="webhook-state">
			{e.active ? 'On' : `Off${e.disabledAt ? ` since ${when(e.disabledAt)}` : ''}`} · {e.failureCount} failures in a row
		</p>
		<p class="mt-1 text-sm text-slate-600">Sends {e.events.map((x) => LABELS[x] ?? x).join(', ')}.</p>
		<div class="mt-3 flex flex-wrap gap-2">
			<form method="POST" action="?/toggle">
				<input type="hidden" name="endpointId" value={e.id} />
				<input type="hidden" name="active" value={e.active ? 'off' : 'on'} />
				<Button type="submit" variant="secondary">{e.active ? 'Turn off' : 'Turn on'}</Button>
			</form>
			{#if data.recent}
				<form method="POST" action="?/rotate">
					<input type="hidden" name="endpointId" value={e.id} />
					<Button type="submit" variant="secondary">New secret</Button>
				</form>
			{/if}
			<form method="POST" action="?/remove">
				<input type="hidden" name="endpointId" value={e.id} />
				<Button type="submit" variant="secondary">Delete</Button>
			</form>
		</div>
	</section>
{/each}

{#if data.deliveries.length}
	<section class="mt-6 max-w-3xl panel" aria-label="Recent deliveries">
		<h2 class="section-title">Recent deliveries</h2>
		<ul class="mt-2 divide-y divide-slate-100 text-sm">
			{#each data.deliveries as d (d.id)}
				<li class="py-2" data-testid="webhook-delivery">
					<span class="font-medium">{LABELS[d.event] ?? d.event}</span> · {STATUS[d.status]} · {d.attempts}
					tries{d.lastStatus ? ` · answered ${d.lastStatus}` : ''}
					<span class="block break-all text-slate-500">{urlOf(d.endpointId)} · {when(d.createdAt)}</span>
					{#if d.lastError && d.status !== 'delivered'}<span class="block text-slate-500">{d.lastError}</span>{/if}
				</li>
			{/each}
		</ul>
	</section>
{/if}
