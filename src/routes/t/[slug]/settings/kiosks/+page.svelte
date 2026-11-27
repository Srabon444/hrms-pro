<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const input = 'input mt-1 block w-full';
	type Values = Partial<(typeof data.kiosks)[number]>;
	const when = (d: Date | string | null) =>
		d ? new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never';
	const state = (k: (typeof data.kiosks)[number]) =>
		k.revoked
			? 'Switched off'
			: k.paired
				? `Paired · last used ${when(k.lastSeenAt)}`
				: k.pairing
					? 'Waiting for pairing'
					: 'Not paired';
</script>

<svelte:head><title>Kiosks · {data.tenant.name}</title></svelte:head>

{#snippet fields(v: Values)}
	<label class="text-sm text-slate-700">
		Name
		<input name="name" required maxlength={60} value={v.name ?? ''} class={input} />
	</label>
	<label class="text-sm text-slate-700">
		Work site
		<select name="siteId" required class={input} value={v.siteId ?? ''}>
			<option value="" disabled>Pick a site</option>
			{#each data.sites as s (s.id)}<option value={s.id}>{s.name}</option>{/each}
		</select>
	</label>
	<label class="text-sm text-slate-700 sm:col-span-2">
		Only on these networks (optional, one per line, like 203.0.113.0/24)
		<textarea name="ipCidrs" rows="2" maxlength={2000} class={input}>{(v.ipCidrs ?? []).join('\n')}</textarea>
	</label>
{/snippet}

<h1 class="page-title">Kiosks</h1>
<p class="mt-1 max-w-3xl text-sm text-slate-600">
	A kiosk is a shared tablet at a work site. Staff type their employee code and their own kiosk PIN to punch. Punches
	from a kiosk count as on site. Make a pairing link and open it on the tablet within 15 minutes.
</p>

<div class="mt-4 max-w-3xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'done' in form && typeof form.done === 'string'}<Alert tone="info" message={form.done} />{/if}
</div>

{#if !data.sites.length}
	<p class="mt-6 max-w-3xl panel text-sm text-slate-600">Add an active work site first. Every kiosk belongs to one.</p>
{/if}

{#each data.kiosks as k (k.id)}
	<section class="mt-6 max-w-3xl panel" aria-label={k.name}>
		<h2 class="section-title">{k.name}</h2>
		<p class="mt-1 text-sm text-slate-600" data-testid="kiosk-state">{k.siteName} · {state(k)}</p>
		{#if form && 'link' in form && form.kioskId === k.id}
			<label class="mt-3 block text-sm text-slate-700">
				Pairing link (shown once, works for 15 minutes)
				<input readonly value={form.link} class={input} onfocus={(e) => e.currentTarget.select()} />
			</label>
		{/if}
		<form method="POST" action="?/save" class="mt-3 grid gap-3 sm:grid-cols-2">
			<input type="hidden" name="kioskId" value={k.id} />
			{@render fields(k)}
			<div class="flex flex-wrap gap-2 sm:col-span-2">
				<Button type="submit">Save {k.name}</Button>
				<Button type="submit" variant="secondary" formaction="?/pair">New pairing link</Button>
				{#if !k.revoked}<Button type="submit" variant="secondary" formaction="?/revoke">Switch off</Button>{/if}
			</div>
		</form>
	</section>
{/each}

{#if data.sites.length}
	<section class="mt-6 max-w-3xl panel" aria-label="New kiosk">
		<h2 class="section-title">New kiosk</h2>
		<form method="POST" action="?/save" class="mt-3 grid gap-3 sm:grid-cols-2">
			{@render fields({ ipCidrs: [] })}
			<div class="sm:col-span-2"><Button type="submit">Add kiosk</Button></div>
		</form>
	</section>
{/if}

<section class="mt-6 max-w-3xl panel" aria-label="Reset a PIN">
	<h2 class="section-title">Reset a PIN</h2>
	<p class="mt-1 text-sm text-slate-600">
		Clears someone's kiosk PIN, for example when they forgot it. They set a new one from their attendance page.
	</p>
	<form method="POST" action="?/resetPin" class="mt-3 flex flex-wrap items-end gap-3">
		<label class="min-w-0 flex-1 text-sm text-slate-700">
			Employee code
			<input name="code" required maxlength={40} autocomplete="off" class={input} />
		</label>
		<Button type="submit" variant="secondary">Reset PIN</Button>
	</form>
</section>
