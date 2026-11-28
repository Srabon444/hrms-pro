<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import Field from '#lib/components/ui/Field.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const input = 'mt-1 block w-full input';
	const base = $derived(`/t/${data.tenant.slug}/signatures`);
	const values = $derived((form && 'values' in form ? form.values : {}) as Record<string, string>);
	const STATUS: Record<string, string> = {
		draft: 'Draft',
		pending: 'Waiting for signatures',
		completed: 'Signed by everyone',
		declined: 'Declined',
		cancelled: 'Cancelled',
		expired: 'Expired'
	};
	const MINE: Record<string, string> = { waiting: 'Not signed yet', signed: 'You signed', declined: 'You declined' };
</script>

<svelte:head><title>Signatures · {data.tenant.name}</title></svelte:head>

<h1 class="page-title">Signatures</h1>

<div class="mt-4 max-w-3xl"><Alert message={form?.message} /></div>

{#if data.mine.length || !data.manage}
	<section class="mt-4 max-w-3xl panel" aria-label="Documents for me">
		<h2 class="section-title">Documents for me</h2>
		{#if data.mine.length}
			<ul class="mt-3 divide-y divide-slate-100 text-sm">
				{#each data.mine as r (r.id)}
					<li class="flex flex-wrap items-center justify-between gap-2 py-2" data-testid="my-signature">
						<a class="font-medium text-brand-700 underline" href="{base}/{r.id}">{r.title}</a>
						<span class={r.myTurn ? 'font-medium text-amber-700' : 'text-slate-500'}>
							{r.myTurn ? 'Waiting for you' : `${MINE[r.myStatus]} · ${STATUS[r.status]}`}
						</span>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="mt-2 text-sm text-slate-600">Nothing has been sent to you for signature.</p>
		{/if}
	</section>
{/if}

{#if data.manage}
	<section class="mt-6 max-w-3xl panel" aria-label="New request">
		<h2 class="section-title">Send a document for signature</h2>
		<form method="POST" action="?/create" enctype="multipart/form-data" class="mt-3 grid gap-3 sm:grid-cols-2">
			<div class="sm:col-span-2">
				<Field label="Title" name="title" required maxlength={200} value={values.title ?? ''} />
			</div>
			<label class="block text-sm font-medium text-slate-700 sm:col-span-2">
				Document (PDF, up to 10 MB)
				<input name="file" type="file" accept="application/pdf,.pdf" required class={input} />
			</label>
			<Field
				label="Days to sign"
				name="expiresInDays"
				type="number"
				min={1}
				max={data.maxDays}
				required
				value={values.expiresInDays ?? '14'}
			/>
			{#if data.offers.length}
				<label class="block text-sm font-medium text-slate-700">
					Offer letter for (optional)
					<select name="offerId" class={input} value={values.offerId ?? ''}>
						<option value="">Not an offer letter</option>
						{#each data.offers as o (o.id)}<option value={o.id}>{o.candidate}</option>{/each}
					</select>
				</label>
			{/if}
			<p class="text-xs text-slate-500 sm:col-span-2">
				Add signers on the next page. People sign one after another in the order you add them. For an offer letter the
				candidate is added first, and the offer is marked accepted as soon as the candidate signs.
			</p>
			<div class="sm:col-span-2"><Button type="submit">Create request</Button></div>
		</form>
	</section>

	<section class="mt-6 max-w-3xl panel" aria-label="All requests">
		<h2 class="section-title">All requests</h2>
		{#if data.all.length}
			<ul class="mt-3 divide-y divide-slate-100 text-sm">
				{#each data.all as r (r.id)}
					<li class="flex flex-wrap items-center justify-between gap-2 py-2" data-testid="signature-request">
						<a class="font-medium text-brand-700 underline" href="{base}/{r.id}">{r.title}</a>
						<span class="text-slate-500">{STATUS[r.status]} · {r.signed}/{r.signers} signed</span>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="mt-2 text-sm text-slate-600">No requests yet.</p>
		{/if}
	</section>
{/if}
