<script lang="ts">
	let { a }: { a: { title: string; body: string; pinned: boolean; publishOn: string; target: string | null } } =
		$props();
</script>

<article
	class={['rounded-xl p-5 ring-1', a.pinned ? 'bg-amber-50 ring-amber-200' : 'bg-white ring-slate-200']}
	data-testid="announcement"
>
	<h3 class="font-semibold text-slate-900">{a.pinned ? '📌 ' : ''}{a.title}</h3>
	<p class="text-xs text-slate-500">{a.publishOn}{a.target ? ` · ${a.target}` : ''}</p>
	<p class="mt-2 text-sm whitespace-pre-wrap text-slate-800">{a.body}</p>
</article>
