<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const values = $derived((form && 'values' in form ? form.values : {}) as Record<string, string>);
	const mt = $derived(data.meeting);
	const STATUS: Record<string, string> = { scheduled: 'Scheduled', done: 'Done', cancelled: 'Cancelled' };
	let kind = $state('agenda');
</script>

<svelte:head><title>1:1 · {data.tenant.name}</title></svelte:head>

<a class="text-sm text-brand-700 underline" href={`/t/${data.tenant.slug}/one-on-ones`}>1:1s</a>
<h1 class="page-title mt-2">{mt.managerName} and {mt.employeeName}</h1>
<p class="text-sm text-slate-600">{mt.scheduledFor} · {STATUS[mt.status]}</p>

<div class="mt-4 max-w-3xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'done' in form && typeof form.done === 'string'}<Alert tone="info" message={form.done} />{/if}
</div>

{#snippet row(i: { id: string; text: string; owner: string; done?: boolean }, action: boolean, from?: string)}
	<li class="panel flex flex-wrap items-start justify-between gap-2" data-testid={from ? 'carried' : 'item'}>
		<div class="min-w-0 text-sm">
			<p class={['break-words text-slate-900', i.done && 'line-through text-slate-500']}>{i.text}</p>
			{#if i.owner || from}
				<p class="text-xs text-slate-500">{i.owner}{i.owner && from ? ' · ' : ''}{from ? `from ${from}` : ''}</p>
			{/if}
		</div>
		{#if data.participant}
			<div class="flex gap-2">
				{#if action}
					<form method="POST" action="?/toggle">
						<input type="hidden" name="itemId" value={i.id} />
						<Button type="submit" variant="secondary">{i.done ? 'Reopen' : 'Done'}</Button>
					</form>
				{/if}
				{#if !from}
					<form method="POST" action="?/remove">
						<input type="hidden" name="itemId" value={i.id} />
						<Button type="submit" variant="secondary">Remove</Button>
					</form>
				{/if}
			</div>
		{/if}
	</li>
{/snippet}

<section class="mt-4 max-w-3xl" aria-label="Agenda">
	<h2 class="section-title">Agenda</h2>
	<ul class="mt-2 space-y-2">
		{#each data.items.filter((i) => i.kind === 'agenda') as i (i.id)}{@render row(i, false)}{:else}
			<li class="text-sm text-slate-600">Nothing on the agenda yet.</li>
		{/each}
	</ul>
</section>

<section class="mt-6 max-w-3xl" aria-label="Actions">
	<h2 class="section-title">Actions</h2>
	<ul class="mt-2 space-y-2">
		{#each data.carried as i (i.id)}{@render row(i, true, i.from)}{/each}
		{#each data.items.filter((i) => i.kind === 'action') as i (i.id)}{@render row(i, true)}{/each}
		{#if !data.carried.length && !data.items.some((i) => i.kind === 'action')}
			<li class="text-sm text-slate-600">No actions.</li>
		{/if}
	</ul>
</section>

{#if data.canEdit}
	<section class="mt-6 max-w-3xl panel" aria-label="Add item">
		<h2 class="section-title">Add item</h2>
		<form method="POST" action="?/item" class="mt-3 space-y-3">
			<label class="block text-sm font-medium text-slate-700">
				Type
				<select name="kind" bind:value={kind} class="mt-1 block w-full input">
					<option value="agenda">Agenda</option>
					<option value="action">Action</option>
				</select>
			</label>
			<label class="block text-sm font-medium text-slate-700">
				Item
				<input name="text" required maxlength={500} value={values.text ?? ''} class="mt-1 block w-full input" />
			</label>
			{#if kind === 'action'}
				<label class="block text-sm font-medium text-slate-700">
					Owner
					<select name="ownerEmployeeId" class="mt-1 block w-full input">
						<option value="">No owner</option>
						<option value={mt.managerEmployeeId}>{mt.managerName}</option>
						<option value={mt.employeeId}>{mt.employeeName}</option>
					</select>
				</label>
			{/if}
			<Button type="submit">Add</Button>
		</form>
	</section>
{/if}

{#if data.privateNote !== null}
	<section class="mt-6 max-w-3xl panel" aria-label="Private note">
		<h2 class="section-title">Private note</h2>
		<p class="mt-1 text-xs text-slate-500">Only you can read this note. HR and the other person never see it.</p>
		<form method="POST" action="?/note" class="mt-3 space-y-3">
			<label class="block text-sm font-medium text-slate-700">
				My note
				<textarea name="note" rows="4" maxlength={4000} class="mt-1 block w-full input"
					>{values.note ?? data.privateNote}</textarea
				>
			</label>
			<Button type="submit" variant="secondary">Save note</Button>
		</form>
	</section>
{/if}

{#if data.participant && mt.status === 'scheduled'}
	<div class="mt-6 flex max-w-3xl flex-wrap gap-2">
		<form method="POST" action="?/done"><Button type="submit">Mark done</Button></form>
		<form method="POST" action="?/cancel"><Button type="submit" variant="secondary">Cancel 1:1</Button></form>
	</div>
{/if}
