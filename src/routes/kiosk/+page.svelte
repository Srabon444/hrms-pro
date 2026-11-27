<script lang="ts">
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '$app/forms';
	import Alert from '#lib/components/ui/Alert.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	type Punched = { firstName: string; time: string; kind: string };
	let done = $state<Punched | null>(null);
	let message = $state<string | null>(null);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const what: Record<string, string> = {
		'': 'Punch recorded',
		break_start: 'Break started',
		break_end: 'Welcome back'
	};

	const submit: SubmitFunction = () => {
		clearTimeout(timer);
		return async ({ result, update }) => {
			if (result.type === 'success' && result.data?.punched) {
				done = result.data.punched as Punched;
				message = null;
				await update({ reset: true, invalidateAll: false });
				timer = setTimeout(() => (done = null), 6000);
				return;
			}
			done = null;
			message =
				result.type === 'failure' && typeof result.data?.message === 'string'
					? result.data.message
					: 'Something went wrong. Try again.';
			await update({ reset: false, invalidateAll: false });
		};
	};
	const big = 'w-full rounded-xl px-4 py-4 text-lg font-semibold';
</script>

<svelte:head>
	<title>Kiosk</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<main class="grid min-h-screen place-items-center bg-slate-50 px-4 py-8">
	<div class="w-full max-w-md">
		{#if !data.kiosk}
			<div class="panel space-y-2">
				<h1 class="page-title">Kiosk</h1>
				<p class="text-sm text-slate-600">
					This browser is not set up as a kiosk. Ask HR for a pairing link and open it here.
				</p>
			</div>
		{:else}
			<div class="panel space-y-4" aria-label="Kiosk">
				<div>
					<h1 class="page-title">{data.kiosk.tenantName}</h1>
					<p class="text-sm text-slate-600">{data.kiosk.name} · {data.kiosk.siteName}</p>
				</div>
				{#if !data.kiosk.onNetwork}
					<Alert message="This kiosk is not on its office network, so it cannot take punches." />
				{/if}
				{#if done}
					<p role="status" class="rounded-xl bg-brand-50 px-4 py-6 text-center text-xl font-semibold text-brand-800">
						{what[done.kind] ?? what['']}, {done.firstName}. {done.time}
					</p>
				{/if}
				<Alert {message} />
				<form method="POST" use:enhance={submit} class="space-y-3" autocomplete="off">
					<label class="block text-sm text-slate-700">
						Employee code
						<input
							name="code"
							required
							maxlength={40}
							autocapitalize="characters"
							spellcheck="false"
							class="input mt-1 block w-full text-lg"
						/>
					</label>
					<label class="block text-sm text-slate-700">
						PIN
						<input
							name="pin"
							type="password"
							required
							inputmode="numeric"
							pattern={'\\d{6,8}'}
							minlength={6}
							maxlength={8}
							autocomplete="off"
							class="input mt-1 block w-full text-lg tracking-widest"
						/>
					</label>
					<button type="submit" name="kind" value="" class="{big} bg-brand-600 text-white hover:bg-brand-700">
						Punch in or out
					</button>
					<div class="grid grid-cols-2 gap-3">
						<button
							type="submit"
							name="kind"
							value="break_start"
							class="{big} border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
						>
							Start break
						</button>
						<button
							type="submit"
							name="kind"
							value="break_end"
							class="{big} border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
						>
							End break
						</button>
					</div>
				</form>
			</div>
		{/if}
	</div>
</main>
