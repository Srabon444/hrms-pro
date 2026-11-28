<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import Field from '#lib/components/ui/Field.svelte';
	import { page } from '$app/state';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const done = $derived(
		form && 'signed' in form ? 'Signed. Thank you.' : form && 'declined' in form ? 'You declined to sign.' : null
	);
	const sentTo = $derived(form && 'sent' in form ? (form.sent as string) : null);
	const ready = $derived(data.state === 'ready' && !done);
</script>

<svelte:head>
	<title>Sign {data.title} · {data.tenant}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<main class="mx-auto min-h-screen max-w-3xl bg-slate-50 px-4 py-10">
	<p class="text-sm text-slate-600">{data.tenant} asked {data.name} to sign</p>
	<h1 class="page-title mt-1">{data.title}</h1>

	<section class="mt-6 panel" aria-label="Document">
		<h2 class="section-title">Document</h2>
		<p class="mt-2 text-sm">
			<a class="text-brand-700 underline" href="{page.url.pathname}/document" target="_blank" rel="noreferrer">
				{data.fileName}
			</a>
			<span class="text-slate-500">· {Math.ceil(data.fileSize / 1024)} KB</span>
		</p>
		<p class="mt-2 text-xs break-all text-slate-600">SHA-256 <span class="font-mono">{data.sha256}</span></p>
		<p class="mt-3 text-xs text-slate-500">{data.legal}</p>
	</section>

	<section class="mt-6 panel" aria-label="Sign">
		<h2 class="section-title">Your signature</h2>
		<div class="mt-3 space-y-2">
			{#if done}<Alert tone="info" message={done} />{/if}
			{#if !ready && !done && data.message}<Alert tone="info" message={data.message} />{/if}
			<Alert message={form?.message} />
			{#if sentTo}<Alert
					tone="info"
					message={`We emailed a code to ${sentTo}. It works for ${data.otpMinutes} minutes.`}
				/>{/if}
		</div>
		{#if ready}
			<form method="POST" action="?/code" class="mt-3">
				<p class="text-sm text-slate-700">
					We email a 6 digit code to {data.email} to confirm it is you. {data.sendsLeft} codes and {data.attemptsLeft} tries
					left.
				</p>
				{#if data.sendsLeft > 0}
					<div class="mt-2">
						<Button type="submit" variant="secondary">
							{data.codeSent || sentTo ? 'Send a new code' : 'Email me a code'}
						</Button>
					</div>
				{/if}
			</form>
			<form method="POST" action="?/sign" class="mt-4 grid gap-3 border-t border-slate-100 pt-4">
				<Field
					label="Code from the email"
					name="code"
					required
					inputmode="numeric"
					maxlength={6}
					autocomplete="one-time-code"
				/>
				<Field label="Type your full name" name="typedName" required maxlength={200} autocomplete="name" />
				<label class="flex items-start gap-2 text-sm text-slate-700">
					<input name="consent" type="checkbox" required class="mt-1" />
					<span>{data.consent}</span>
				</label>
				<div><Button type="submit">Sign</Button></div>
			</form>
			<details class="mt-4 border-t border-slate-100 pt-4 text-sm">
				<summary class="cursor-pointer text-slate-700">Decline to sign</summary>
				<form method="POST" action="?/decline" class="mt-3 grid gap-3">
					<Field label="Code from the email" name="code" required inputmode="numeric" maxlength={6} />
					<Field label="Reason (optional)" name="reason" maxlength={500} />
					<div><Button type="submit" variant="danger">Decline</Button></div>
				</form>
			</details>
		{/if}
	</section>
</main>
