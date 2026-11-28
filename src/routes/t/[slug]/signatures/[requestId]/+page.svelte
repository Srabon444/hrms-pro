<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import Field from '#lib/components/ui/Field.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const input = 'mt-1 block w-full input';
	const r = $derived(data.request);
	const base = $derived(`/t/${data.tenant.slug}/signatures/${r.id}`);
	const values = $derived((form && 'values' in form ? form.values : {}) as Record<string, string>);
	let kind = $state<'person' | 'outside'>('person');
	const STATUS: Record<string, string> = {
		draft: 'Draft',
		pending: 'Waiting for signatures',
		completed: 'Signed by everyone',
		declined: 'Declined',
		cancelled: 'Cancelled',
		expired: 'Expired'
	};
	const SIGNER: Record<string, string> = { waiting: 'Not signed', signed: 'Signed', declined: 'Declined' };
	const at = (d: Date | null) => (d ? `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC` : '');
	const signerLine = (s: (typeof data.signers)[number]) =>
		[
			s.current ? 'Their turn' : SIGNER[s.status],
			s.signedAt && at(s.signedAt),
			s.method === 'email_otp' && 'email code',
			s.method === 'session' && 'signed in',
			s.ip,
			s.locked && 'locked after 5 wrong codes'
		]
			.filter(Boolean)
			.join(' · ');
</script>

<svelte:head><title>{r.title} · Signatures · {data.tenant.name}</title></svelte:head>

<a class="text-sm text-brand-700 underline" href="/t/{data.tenant.slug}/signatures">All signatures</a>
<h1 class="page-title mt-2">{r.title}</h1>
<p class="mt-1 text-sm text-slate-600" data-testid="request-status">
	{STATUS[r.status]}{r.status === 'pending' ? ` · until ${at(r.expiresAt)}` : ''}
</p>

<div class="mt-4 max-w-3xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'done' in form && typeof form.done === 'string'}<Alert tone="info" message={form.done} />{/if}
</div>

<section class="mt-4 max-w-3xl panel" aria-label="Document">
	<h2 class="section-title">Document</h2>
	<p class="mt-2 text-sm">
		<a class="text-brand-700 underline" href="{base}/original" data-sveltekit-reload>{r.fileName}</a>
		<span class="text-slate-500">· {Math.ceil(r.fileSize / 1024)} KB</span>
	</p>
	<p class="mt-2 text-xs break-all text-slate-600">SHA-256 <span class="font-mono">{r.sha256}</span></p>
	{#if r.status === 'completed'}
		<p class="mt-3 text-sm">
			<a class="text-brand-700 underline" href="{base}/certificate" data-sveltekit-reload>Certificate of completion</a>
		</p>
		<p class="mt-1 text-xs break-all text-slate-600">
			Certificate SHA-256 <span class="font-mono">{r.certificateSha256}</span>
		</p>
	{/if}
	{#if r.declineReason}<p class="mt-2 text-sm text-slate-700">Reason given: {r.declineReason}</p>{/if}
	<p class="mt-3 text-xs text-slate-500">{data.legal}</p>
</section>

{#if data.myTurn}
	<section class="mt-6 max-w-3xl panel" aria-label="Sign">
		<h2 class="section-title">Your signature</h2>
		<p class="mt-2 text-sm text-slate-700">Read the document first. You are signing the file with the SHA-256 above.</p>
		{#if !data.recent}
			<p class="mt-2 text-sm text-slate-700">Confirm it is you before signing.</p>
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
			<form method="POST" action="?/sign" class="mt-3 grid gap-3">
				<Field label="Type your full name" name="typedName" required maxlength={200} autocomplete="name" />
				<label class="flex items-start gap-2 text-sm text-slate-700">
					<input name="consent" type="checkbox" required class="mt-1" />
					<span>{data.consent}</span>
				</label>
				<div><Button type="submit">Sign</Button></div>
			</form>
		{/if}
		<form method="POST" action="?/decline" class="mt-4 grid gap-3 border-t border-slate-100 pt-4">
			<Field label="Reason for declining (optional)" name="reason" maxlength={500} />
			<div><Button type="submit" variant="danger">Decline to sign</Button></div>
		</form>
	</section>
{/if}

<section class="mt-6 max-w-3xl panel" aria-label="Signers">
	<h2 class="section-title">Signers</h2>
	{#if data.signers.length}
		<ol class="mt-3 divide-y divide-slate-100 text-sm">
			{#each data.signers as s, i (s.id)}
				<li class="flex flex-wrap items-start justify-between gap-2 py-2" data-testid="signer">
					<div class="min-w-0">
						<p class="font-medium">{i + 1}. {s.name}{s.email ? ` <${s.email}>` : ''}</p>
						<p class="text-slate-500">{signerLine(s)}</p>
						{#if s.userAgent}<p class="text-xs break-all text-slate-400">{s.userAgent}</p>{/if}
					</div>
					{#if data.manage && r.status === 'draft'}
						<form method="POST" action="?/removeSigner">
							<input type="hidden" name="signerId" value={s.id} />
							<Button type="submit" variant="secondary">Remove</Button>
						</form>
					{/if}
				</li>
			{/each}
		</ol>
	{:else}
		<p class="mt-2 text-sm text-slate-600">No signers yet.</p>
	{/if}

	{#if data.manage && r.status === 'draft' && data.signers.length < data.maxSigners}
		<form method="POST" action="?/addSigner" class="mt-4 grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-2">
			<fieldset class="flex gap-4 text-sm sm:col-span-2">
				<legend class="sr-only">Signer type</legend>
				<label class="flex items-center gap-2">
					<input type="radio" bind:group={kind} value="person" /> Someone here
				</label>
				<label class="flex items-center gap-2">
					<input type="radio" bind:group={kind} value="outside" /> Someone outside
				</label>
			</fieldset>
			{#if kind === 'person'}
				<label class="block text-sm font-medium text-slate-700 sm:col-span-2">
					Person
					<select name="employeeId" required class={input}>
						<option value="">Choose a person</option>
						{#each data.people as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
					</select>
				</label>
			{:else}
				<Field label="Name" name="name" required maxlength={200} value={values.name ?? ''} />
				<Field label="Email" name="email" type="email" required maxlength={254} value={values.email ?? ''} />
			{/if}
			<div class="sm:col-span-2"><Button type="submit" variant="secondary">Add signer</Button></div>
		</form>
	{/if}
</section>

{#if data.manage && (r.status === 'draft' || r.status === 'pending' || r.status === 'expired')}
	<div class="mt-6 flex max-w-3xl flex-wrap gap-3">
		{#if r.status === 'draft'}
			<form method="POST" action="?/send"><Button type="submit">Send for signature</Button></form>
		{:else if r.status === 'pending'}
			<form method="POST" action="?/resend">
				<Button type="submit" variant="secondary">Resend invite</Button>
			</form>
		{/if}
		<form method="POST" action="?/cancel"><Button type="submit" variant="danger">Cancel request</Button></form>
	</div>
{/if}
