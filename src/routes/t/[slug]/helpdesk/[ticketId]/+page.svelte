<script lang="ts">
	import Attachments from '#lib/components/Attachments.svelte';
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import { TICKET_PRIORITY_LABELS, TICKET_STATUS_LABELS } from '#lib/helpdesk-labels.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const v = $derived(data.view);
	const t = $derived(v.ticket);
	const open = $derived(t.status !== 'closed');
	const input = 'mt-1 block w-full input';
	const when = (d: Date) => d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
</script>

<svelte:head><title>#{t.number} · Helpdesk · {data.tenant.name}</title></svelte:head>

<a class="text-sm text-brand-700 underline" href={`/t/${data.tenant.slug}/helpdesk`}>Helpdesk</a>
<h1 class="page-title mt-2">#{t.number} · {t.subject}</h1>
<p class="text-sm text-slate-600">
	{v.category}{v.confidential ? ' (confidential)' : ''} · from {v.requester} · {TICKET_PRIORITY_LABELS[t.priority]} ·
	<span data-testid="ticket-status">{TICKET_STATUS_LABELS[t.status]}</span>
	· handled by {v.assignee ?? 'nobody yet'} ·
	<span class={v.overdue ? 'font-medium text-red-700' : ''}>due {when(t.slaDueAt)}{v.overdue ? ' (late)' : ''}</span>
</p>

<div class="mt-4 max-w-4xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'done' in form}<Alert tone="info" message={form.done} />{/if}
</div>

<section class="mt-4 max-w-4xl panel" aria-label="Description">
	<p class="text-sm whitespace-pre-wrap text-slate-800">{t.description}</p>
</section>

{#if v.isRequester && t.status === 'resolved'}
	<section class="mt-4 flex max-w-4xl flex-wrap items-center gap-3" aria-label="Confirm the fix">
		<p class="text-sm text-slate-700">Is it fixed?</p>
		<form method="POST" action="?/requester">
			<input type="hidden" name="action" value="close" />
			<Button type="submit">Yes, close it</Button>
		</form>
		<form method="POST" action="?/requester">
			<input type="hidden" name="action" value="reopen" />
			<Button type="submit" variant="secondary">No, reopen</Button>
		</form>
	</section>
{/if}

{#if v.agent && open}
	<section class="mt-4 max-w-4xl panel" aria-label="Handle ticket">
		<h2 class="section-title">Handle</h2>
		<form method="POST" action="?/update" class="mt-3 grid gap-3 sm:grid-cols-4">
			<label class="block text-sm font-medium text-slate-700">
				Status
				<select name="status" class={input}>
					{#each Object.entries(TICKET_STATUS_LABELS) as [value, label] (value)}
						<option {value} selected={t.status === value}>{label}</option>
					{/each}
				</select>
			</label>
			<label class="block text-sm font-medium text-slate-700">
				Priority
				<select name="priority" class={input}>
					{#each Object.entries(TICKET_PRIORITY_LABELS) as [value, label] (value)}
						<option {value} selected={t.priority === value}>{label}</option>
					{/each}
				</select>
			</label>
			<label class="block text-sm font-medium text-slate-700">
				Handled by
				<select name="assignee" class={input}>
					<option value="">Nobody</option>
					{#each v.agents as a (a.id)}
						<option value={a.id} selected={t.assigneeMembershipId === a.id}>{a.name}</option>
					{/each}
				</select>
			</label>
			<div class="self-end"><Button type="submit">Save</Button></div>
		</form>
	</section>
{/if}

{#if data.attachments}
	<Attachments slug={data.tenant.slug} attachments={data.attachments} {form} />
{/if}

<section class="mt-4 max-w-4xl" aria-label="Conversation">
	<h2 class="section-title">Conversation</h2>
	{#each v.comments as c (c.id)}
		<article
			class={['mt-3 rounded-lg p-4 ring-1', c.internal ? 'bg-amber-50 ring-amber-200' : 'bg-white ring-slate-200']}
			data-testid="ticket-comment"
		>
			<p class="text-xs text-slate-500">
				{c.author ?? 'Former member'} · {when(c.at)}{c.internal ? ' · internal note' : ''}
			</p>
			<p class="mt-1 text-sm whitespace-pre-wrap text-slate-800">{c.body}</p>
			{#if c.files.length}
				<ul class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
					{#each c.files as f (f.id)}
						<li data-testid="comment-file">
							<a href="/t/{data.tenant.slug}/files/{f.id}" class="break-all text-brand-700 hover:underline">
								{f.filename}
							</a>
						</li>
					{/each}
				</ul>
			{/if}
		</article>
	{:else}
		<p class="mt-2 text-sm text-slate-600">No comments yet.</p>
	{/each}
	{#if open}
		<form method="POST" action="?/comment" enctype="multipart/form-data" class="mt-4 space-y-2">
			<label class="block text-sm font-medium text-slate-700">
				Comment
				<textarea name="body" required maxlength="5000" rows="3" class={input}></textarea>
			</label>
			{#if v.agent}
				<label class="flex items-center gap-2 text-sm text-slate-700">
					<input type="checkbox" name="internal" />
					Internal note (hidden from the requester)
				</label>
			{/if}
			<label class="block text-sm text-slate-700">
				Attach files <span class="text-slate-500">(optional, up to 5)</span>
				<input
					name="files"
					type="file"
					multiple
					accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp"
					class="mt-1 block w-full text-sm"
				/>
			</label>
			<Button type="submit">Add comment</Button>
		</form>
	{/if}
</section>
