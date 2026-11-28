<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const values = $derived((form && 'values' in form ? form.values : {}) as Record<string, string>);
	const a = $derived(data.announcement);
	const REACTIONS: Record<string, string> = {
		like: '👍 Like',
		love: '❤️ Love',
		celebrate: '🎉 Celebrate',
		insightful: '💡 Insightful',
		funny: '😄 Funny',
		support: '🙏 Support'
	};
	const when = (d: Date | string) => new Date(d).toISOString().slice(0, 16).replace('T', ' ');
</script>

<svelte:head><title>{a.title} · {data.tenant.name}</title></svelte:head>

<a class="text-sm text-brand-700 underline" href={`/t/${data.tenant.slug}/announcements`}>Announcements</a>
<h1 class="page-title mt-2 break-words">{a.title}</h1>
<p class="text-xs text-slate-500">{a.publishOn}</p>
<p class="mt-2 max-w-3xl text-sm break-words whitespace-pre-wrap text-slate-800">{a.body}</p>

<div class="mt-4 max-w-3xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'done' in form && typeof form.done === 'string'}<Alert tone="info" message={form.done} />{/if}
</div>

<section class="mt-4 max-w-3xl" aria-label="Reactions">
	<div class="flex flex-wrap gap-2">
		{#each data.reactions as r (r.kind)}
			{#if data.canWrite}
				<form method="POST" action="?/react">
					<input type="hidden" name="kind" value={r.kind} />
					<button
						type="submit"
						aria-pressed={r.mine}
						class={[
							'rounded-full border px-3 py-1 text-sm',
							r.mine ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-300 text-slate-700'
						]}
					>
						{REACTIONS[r.kind]} <span data-testid="reaction-count">{r.count}</span>
					</button>
				</form>
			{:else if r.count}
				<span class="rounded-full border border-slate-300 px-3 py-1 text-sm text-slate-700">
					{REACTIONS[r.kind]}
					{r.count}
				</span>
			{/if}
		{/each}
	</div>
</section>

<section class="mt-6 max-w-3xl space-y-3" aria-label="Comments">
	<h2 class="section-title">Comments</h2>
	{#each data.comments as c (c.id)}
		<article class={['panel', c.hidden && 'opacity-60']} data-testid="comment">
			<p class="text-xs text-slate-500">
				<span class="font-medium text-slate-800">{c.author}</span> · {when(c.createdAt)}{c.hidden ? ' · hidden' : ''}
			</p>
			<p class="mt-1 text-sm break-words whitespace-pre-line text-slate-800">{c.body}</p>
			{#if c.mentions.length}<p class="mt-1 text-xs text-slate-500">Mentions: {c.mentions.join(', ')}</p>{/if}
			{#if c.mine || data.manager}
				<div class="mt-2 flex flex-wrap gap-2">
					{#if c.mine}
						<form method="POST" action="?/delete">
							<input type="hidden" name="commentId" value={c.id} />
							<Button type="submit" variant="secondary">Delete</Button>
						</form>
					{/if}
					{#if data.manager}
						<form method="POST" action={c.hidden ? '?/show' : '?/hide'}>
							<input type="hidden" name="commentId" value={c.id} />
							<Button type="submit" variant="secondary">{c.hidden ? 'Show' : 'Hide'}</Button>
						</form>
					{/if}
				</div>
			{/if}
		</article>
	{:else}
		<p class="text-sm text-slate-600">No comments yet.</p>
	{/each}

	{#if data.canWrite}
		<form method="POST" action="?/comment" class="panel space-y-3" aria-label="New comment">
			<label class="block text-sm font-medium text-slate-700">
				Your comment
				<textarea name="body" required maxlength={2000} rows="3" class="mt-1 block w-full input"
					>{values.body ?? ''}</textarea
				>
			</label>
			{#if data.mentionable.length}
				<label class="block text-sm font-medium text-slate-700">
					Mention people (up to 10)
					<select name="mentions" multiple size="4" class="mt-1 block w-full input">
						{#each data.mentionable as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
					</select>
				</label>
			{/if}
			<Button type="submit">Post comment</Button>
		</form>
	{/if}
</section>
