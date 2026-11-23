<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const input = 'mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm';
	type Values = { id?: string; name?: string; slaHours?: number; confidential?: boolean; active?: boolean };
</script>

<svelte:head><title>Helpdesk setup · {data.tenant.name}</title></svelte:head>

{#snippet fields(c: Values, locked: boolean)}
	<input type="hidden" name="categoryId" value={c.id ?? ''} />
	<label class="block text-sm text-slate-700">
		Name
		<input name="name" required maxlength="60" value={c.name ?? ''} disabled={locked} class={input} />
	</label>
	<label class="block text-sm text-slate-700">
		Resolve within (hours)
		<input
			name="slaHours"
			type="number"
			min="1"
			max="720"
			required
			value={c.slaHours ?? 24}
			disabled={locked}
			class={input}
		/>
	</label>
	<label class="flex items-center gap-2 text-sm text-slate-700">
		<input type="checkbox" name="confidential" checked={!!c.confidential} disabled={locked || !data.canConfidential} />
		Confidential (only the requester and confidential handlers see it)
	</label>
	<label class="flex items-center gap-2 text-sm text-slate-700">
		<input type="checkbox" name="active" checked={c.active ?? true} disabled={locked} />
		Open for new tickets
	</label>
{/snippet}

<h1 class="text-2xl font-semibold text-slate-900">Helpdesk setup</h1>
<p class="mt-1 max-w-3xl text-sm text-slate-600">
	Categories decide who can see a ticket and how long the helpdesk has to resolve it.
</p>

<div class="mt-4 max-w-3xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'done' in form}<Alert tone="info" message={form.done} />{/if}
</div>

{#each data.categories as c (c.id)}
	{@const locked = c.confidential && !data.canConfidential}
	<section class="mt-4 max-w-3xl rounded-xl bg-white p-6 ring-1 ring-slate-200" aria-label={c.name}>
		<h2 class="font-semibold text-slate-900">
			{c.name}
			<span class="ml-2 text-xs font-normal text-slate-500">
				{c.slaHours} h{c.confidential ? ' · confidential' : ''}{c.active ? '' : ' · closed'}
			</span>
		</h2>
		<form method="POST" action="?/save" class="mt-3 grid gap-3 sm:grid-cols-2">
			{@render fields(c, locked)}
			{#if !locked}<div class="sm:col-span-2"><Button type="submit">Save {c.name}</Button></div>{/if}
		</form>
	</section>
{/each}

<section class="mt-6 max-w-3xl rounded-xl bg-white p-6 ring-1 ring-slate-200" aria-label="New category">
	<h2 class="font-semibold text-slate-900">New category</h2>
	<form method="POST" action="?/save" class="mt-3 grid gap-3 sm:grid-cols-2">
		{@render fields({}, false)}
		<div class="sm:col-span-2"><Button type="submit">Add category</Button></div>
	</form>
</section>
