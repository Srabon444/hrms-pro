<script lang="ts">
	let {
		a,
		slug
	}: {
		a: {
			id: string;
			title: string;
			body: string;
			pinned: boolean;
			publishOn: string;
			target: string | null;
			files: { id: string; filename: string }[];
			reactions: number;
			comments: number;
		};
		slug: string;
	} = $props();
	const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
	const social = $derived(`${plural(a.reactions, 'reaction')} · ${plural(a.comments, 'comment')}`);
</script>

<article
	class={['rounded-xl p-5 ring-1', a.pinned ? 'bg-amber-50 ring-amber-200' : 'bg-white ring-slate-200']}
	data-testid="announcement"
>
	<h3 class="font-semibold text-slate-900">{a.pinned ? '📌 ' : ''}{a.title}</h3>
	<p class="text-xs text-slate-500">{a.publishOn}{a.target ? ` · ${a.target}` : ''}</p>
	<p class="mt-2 text-sm whitespace-pre-wrap text-slate-800">{a.body}</p>
	{#if a.files.length}
		<ul class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
			{#each a.files as f (f.id)}
				<li data-testid="announcement-file">
					<a href="/t/{slug}/files/{f.id}" class="break-all text-brand-700 hover:underline">{f.filename}</a>
				</li>
			{/each}
		</ul>
	{/if}
	<p class="mt-3 text-sm">
		<a
			class="text-brand-700 underline"
			href="/t/{slug}/announcements/{a.id}/comments"
			data-testid="announcement-social"
		>
			{social}
		</a>
	</p>
</article>
