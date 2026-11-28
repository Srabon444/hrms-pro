<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const values = $derived((form && 'values' in form ? form.values : {}) as Record<string, string>);
	const STATE: Record<string, string> = { draft: 'Draft', open: 'Open', closed: 'Closed' };
	const base = $derived(`/t/${data.tenant.slug}/surveys`);
</script>

<svelte:head><title>Surveys · {data.tenant.name}</title></svelte:head>

<div class="flex flex-wrap items-center justify-between gap-2">
	<h1 class="page-title">Surveys</h1>
	{#if data.manager}
		<div class="flex flex-wrap gap-2">
			<a class="text-sm text-brand-700 underline" href={`${base}/suggestions`}>Suggestions</a>
			<a class="text-sm text-brand-700 underline" href={`${base}/new`}>New survey</a>
		</div>
	{/if}
</div>

<div class="mt-4 max-w-3xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'suggested' in form}<Alert
			tone="info"
			message="Thank you. Your suggestion was sent without your name."
		/>{/if}
</div>

<section class="mt-4 max-w-3xl space-y-3" aria-label="Surveys for you">
	<h2 class="section-title">For you</h2>
	{#each data.mine as s (s.id)}
		<article class="panel flex flex-wrap items-center justify-between gap-2" data-testid="my-survey">
			<div>
				<h3 class="font-semibold text-slate-900">{s.title}</h3>
				<p class="text-sm text-slate-600">
					{s.anonymous ? 'Anonymous' : 'Your name is recorded'} · closes {s.closesOn}
				</p>
			</div>
			{#if s.answered}
				<span class="text-sm text-slate-500">Answered</span>
			{:else}
				<a class="text-sm font-medium text-brand-700 underline" href={`${base}/${s.id}`}>Answer {s.title}</a>
			{/if}
		</article>
	{:else}
		<p class="text-sm text-slate-600">No surveys for you right now.</p>
	{/each}
</section>

<section class="mt-6 max-w-3xl panel" aria-label="Suggestion box">
	<h2 class="section-title">Suggestion box</h2>
	<p class="mt-1 text-sm text-slate-600">
		Your name is never stored with a suggestion. HR sees suggestions only in groups of several, in random order.
	</p>
	<form method="POST" action="?/suggest" class="mt-3 space-y-3">
		<label class="block text-sm font-medium text-slate-700">
			Your suggestion
			<textarea name="suggestion" required maxlength={2000} rows="3" class="mt-1 block w-full input"
				>{values.suggestion ?? ''}</textarea
			>
		</label>
		<Button type="submit">Send suggestion</Button>
	</form>
</section>

{#if data.manager}
	<section class="mt-6 max-w-3xl space-y-3" aria-label="All surveys">
		<h2 class="section-title">All surveys</h2>
		{#each data.all as s (s.id)}
			<article class="panel flex flex-wrap items-center justify-between gap-2" data-testid="survey">
				<div class="min-w-0">
					<h3 class="font-semibold break-words text-slate-900">
						<a class="text-brand-700 underline" href={`${base}/${s.id}`}>{s.title}</a>
					</h3>
					<p class="text-sm text-slate-600">
						{STATE[s.state]} · {s.target ?? 'Everyone'} · {s.responses}
						{s.responses === 1 ? 'response' : 'responses'} · closes {s.closesOn}
					</p>
				</div>
			</article>
		{:else}
			<p class="text-sm text-slate-600">No surveys yet.</p>
		{/each}
	</section>
{/if}
