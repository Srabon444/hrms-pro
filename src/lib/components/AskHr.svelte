<script lang="ts">
	import Button from '#lib/components/ui/Button.svelte';

	type Source = { label: string; href: string };
	type Turn = { role: 'user' | 'assistant'; text: string; sources?: Source[] };

	let { slug }: { slug: string } = $props();

	const MAX_TURNS = 6;
	const MAX_CHARS = 8000;
	let turns = $state<Turn[]>([]);
	let question = $state('');
	let busy = $state(false);
	let problem = $state('');

	const history = () => {
		const recent = turns.slice(-MAX_TURNS).map(({ role, text }) => ({ role, text }));
		const from = (i: number, size: number): number =>
			i < 0 || size + recent[i].text.length > MAX_CHARS ? i + 1 : from(i - 1, size + recent[i].text.length);
		return recent.slice(from(recent.length - 1, 0));
	};

	async function ask(event: SubmitEvent) {
		event.preventDefault();
		const q = question.trim();
		if (!q || busy) return;
		const body = new FormData();
		body.set('question', q);
		body.set('history', JSON.stringify(history()));
		busy = true;
		problem = '';
		const res = await fetch(`/t/${slug}/assistant/ask`, { method: 'POST', body }).catch(() => null);
		const out = (await res?.json().catch(() => null)) as { answer?: string; sources?: Source[]; error?: string } | null;
		busy = false;
		if (!res?.ok || !out?.answer) {
			problem = res?.redirected
				? 'Your session ended. Sign in again.'
				: (out?.error ?? 'Ask HR is unavailable right now. Try again shortly.');
			return;
		}
		turns = [...turns, { role: 'user', text: q }, { role: 'assistant', text: out.answer, sources: out.sources ?? [] }];
		question = '';
	}
</script>

<div class="space-y-3">
	{#if turns.length}
		<ol class="space-y-3" aria-label="Conversation">
			{#each turns as t, i (i)}
				<li data-testid={t.role === 'user' ? 'ask-question' : 'ask-answer'}>
					{#if t.role === 'user'}
						<p class="font-medium text-slate-900">{t.text}</p>
					{:else}
						<p class="whitespace-pre-line text-slate-800">{t.text}</p>
						{#if t.sources?.length}
							<p class="mt-1 flex flex-wrap gap-2 text-xs">
								<span class="text-slate-500">Sources:</span>
								{#each t.sources as s (s.href)}
									<a class="text-brand-700 underline" href={`/t/${slug}/${s.href}`}>{s.label}</a>
								{/each}
							</p>
						{/if}
					{/if}
				</li>
			{/each}
		</ol>
	{/if}
	<form class="flex flex-wrap items-end gap-2" onsubmit={ask}>
		<label class="block min-w-0 flex-1">
			<span class="text-sm font-medium text-slate-700">Your question</span>
			<input
				class="mt-1 block w-full input"
				name="question"
				maxlength="500"
				autocomplete="off"
				placeholder="How many days of annual leave do I have left?"
				bind:value={question}
			/>
		</label>
		<Button type="submit" disabled={busy}>{busy ? 'Thinking…' : 'Ask'}</Button>
	</form>
	<p aria-live="polite" data-testid="ask-note" class="text-xs text-amber-700">{problem}</p>
	<p class="text-xs text-slate-500">
		Answers come from your own records and company policies. Check anything important with HR.
	</p>
</div>
