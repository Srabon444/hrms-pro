<script lang="ts">
	import { enhance } from '$app/forms';
	import PolicyFields from '#lib/components/PolicyFields.svelte';
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const base = $derived(`/t/${data.tenant.slug}/policies`);
	const values = $derived((form && 'values' in form ? form.values : {}) as Record<string, string>);
</script>

<svelte:head><title>Policies · {data.tenant.name}</title></svelte:head>

<h1 class="page-title">Policies</h1>

<div class="mt-4 max-w-3xl"><Alert message={form && 'message' in form ? form.message : undefined} /></div>

{#if data.manager}
	<section class="mt-4 max-w-3xl panel" aria-label="New policy">
		<h2 class="section-title">New policy</h2>
		<form method="POST" action="?/create" enctype="multipart/form-data" class="mt-3 grid gap-3 sm:grid-cols-2">
			<PolicyFields v={values} fileRequired />
			<div class="sm:col-span-2"><Button type="submit">Publish policy</Button></div>
		</form>
	</section>
{/if}

<section class="mt-6 max-w-3xl space-y-3" aria-label="Company policies">
	{#each data.rows as p (p.id)}
		<article class="rounded-xl bg-white p-5 ring-1 ring-slate-200" data-testid="policy">
			<div class="flex flex-wrap items-baseline justify-between gap-2">
				<h2 class="section-title">
					{#if data.manager}<a class="text-brand-700 underline" href={`${base}/${p.id}`}>
							{p.title}
						</a>{:else}{p.title}{/if}
				</h2>
				<span class="text-xs text-slate-500">
					Version {p.version} · {p.publishedOn}{p.active ? '' : ' · Unpublished'}
				</span>
			</div>
			{#if p.description}<p class="mt-2 text-sm whitespace-pre-line text-slate-700">{p.description}</p>{/if}
			<div class="mt-3 flex flex-wrap items-center gap-3 text-sm">
				<a class="text-brand-700 underline" href={`${base}/${p.id}/file`}>Read the policy</a>
				{#if data.manager && p.requiresAck}
					<span class="text-slate-600" data-testid="policy-progress">{p.acked} of {data.staff} acknowledged</span>
				{/if}
				{#if p.active && p.requiresAck && data.canAck}
					{#if p.acknowledgedAt}
						<span class="text-emerald-700" data-testid="policy-acked">
							Acknowledged on {new Date(p.acknowledgedAt).toLocaleDateString()}
						</span>
					{:else}
						<form method="POST" action="?/acknowledge" use:enhance>
							<input type="hidden" name="policyId" value={p.id} />
							<input type="hidden" name="version" value={p.version} />
							<Button type="submit">I have read and accept it</Button>
						</form>
					{/if}
				{/if}
			</div>
		</article>
	{:else}
		<p class="text-sm text-slate-600">No policies yet.</p>
	{/each}
</section>
