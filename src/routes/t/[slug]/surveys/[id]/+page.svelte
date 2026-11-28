<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const values = $derived((form && 'values' in form ? form.values : {}) as Record<string, string>);
	const s = $derived(data.survey);
	const r = $derived(data.results);
	const STATE: Record<string, string> = { draft: 'Draft', open: 'Open', closed: 'Closed' };
	const base = $derived(`/t/${data.tenant.slug}/surveys/${s.id}`);
	const pct = (n: number, total: number) => (total ? Math.round((n / total) * 100) : 0);
	const labelOf = (kind: string, options: string[], i: number) =>
		kind === 'choice' ? options[i] : kind === 'scale' ? String(i + 1) : String(i);
</script>

<svelte:head><title>{s.title} · {data.tenant.name}</title></svelte:head>

<a class="text-sm text-brand-700 underline" href={`/t/${data.tenant.slug}/surveys`}>Surveys</a>
<h1 class="page-title mt-2 break-words">{s.title}</h1>
<p class="mt-1 text-sm text-slate-600" data-testid="survey-state">
	{STATE[s.state]} · {s.anonymous ? 'Anonymous' : 'Names recorded'}{s.closesOn ? ` · closes ${s.closesOn}` : ''}
</p>
{#if s.intro}<p class="mt-2 max-w-3xl text-sm whitespace-pre-line text-slate-700">{s.intro}</p>{/if}

<div class="mt-4 max-w-3xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'done' in form && typeof form.done === 'string'}<Alert tone="info" message={form.done} />{/if}
</div>

{#if data.manager}
	<section class="mt-4 max-w-3xl panel" aria-label="Manage survey">
		<h2 class="section-title">Manage</h2>
		<p class="mt-1 text-sm text-slate-600">
			{data.audience}
			{data.audience === 1 ? 'person' : 'people'} asked{s.state !== 'draft'
				? ` · ${r?.responses ?? 0} answered`
				: ''}{s.anonymous ? ` · groups under ${s.minGroupSize} hidden` : ''}
		</p>
		<div class="mt-3 flex flex-wrap gap-2">
			{#if s.state === 'draft'}
				<form method="POST" action="?/open"><Button type="submit">Open survey</Button></form>
			{/if}
			{#if s.state === 'open'}
				<form method="POST" action="?/remind">
					<Button type="submit" variant="secondary" disabled={s.remindersSent >= 2}>
						Remind people who have not answered ({2 - s.remindersSent} left)
					</Button>
				</form>
				<form method="POST" action="?/close"><Button type="submit" variant="secondary">Close survey</Button></form>
			{/if}
			<form method="POST" action="?/delete"><Button type="submit" variant="danger">Delete survey</Button></form>
		</div>
	</section>
{/if}

{#if data.canAnswer}
	<form method="POST" action="?/answer" class="mt-6 max-w-3xl space-y-4" aria-label="Your answers">
		{#if s.anonymous}
			<p class="text-sm text-slate-600">Your name is not stored with your answers.</p>
		{/if}
		{#each data.questions as q, i (q.id)}
			<fieldset class="panel" data-testid="answer">
				<legend class="text-sm font-medium text-slate-900">
					{i + 1}. {q.prompt}{q.required ? '' : ' (optional)'}
				</legend>
				{#if q.kind === 'text'}
					<textarea
						name={`q_${q.id}`}
						aria-label={q.prompt}
						required={q.required}
						maxlength={2000}
						rows="3"
						class="mt-2 block w-full input">{values[`q_${q.id}`] ?? ''}</textarea
					>
				{:else}
					<div class="mt-2 flex flex-wrap gap-2">
						{#each Array.from( { length: q.kind === 'scale' ? 5 : q.kind === 'enps' ? 11 : q.options.length } ) as _, v (v)}
							<label class="flex items-center gap-1 rounded border border-slate-300 px-2 py-1 text-sm">
								<input
									type="radio"
									name={`q_${q.id}`}
									value={String(q.kind === 'scale' ? v + 1 : v)}
									required={q.required}
									checked={values[`q_${q.id}`] === String(q.kind === 'scale' ? v + 1 : v)}
								/>
								{labelOf(q.kind, q.options, v)}
							</label>
						{/each}
					</div>
					{#if q.kind === 'enps'}<p class="mt-1 text-xs text-slate-500">
							0 = not at all likely, 10 = extremely likely
						</p>{/if}
					{#if q.kind === 'scale'}<p class="mt-1 text-xs text-slate-500">
							1 = strongly disagree, 5 = strongly agree
						</p>{/if}
				{/if}
			</fieldset>
		{/each}
		<Button type="submit">Send answers</Button>
	</form>
{:else if data.answered}
	<p class="mt-6 text-sm text-slate-600">You answered this survey. Thank you.</p>
{:else if !data.manager}
	<p class="mt-6 text-sm text-slate-600">This survey is not open for answers.</p>
{/if}

{#if data.manager && r}
	<section class="mt-6 max-w-3xl space-y-3" aria-label="Results">
		<div class="flex flex-wrap items-center justify-between gap-2">
			<h2 class="section-title">Results</h2>
			{#if r.ready}
				<nav class="flex flex-wrap gap-3 text-sm" aria-label="Break down by">
					<a class="text-brand-700 underline" href={base}>Overall</a>
					<a class="text-brand-700 underline" href={`${base}?by=department`}>By department</a>
					<a class="text-brand-700 underline" href={`${base}?by=branch`}>By branch</a>
				</nav>
			{/if}
		</div>
		{#if !r.ready}
			<p class="text-sm text-slate-600" data-testid="results-waiting">
				{r.reason === 'open'
					? 'Results of an anonymous survey show after it closes.'
					: `Too few answers to show results without identifying people (fewer than ${s.minGroupSize}).`}
			</p>
		{:else}
			{#each r.questions as q, i (q.id)}
				<article class="panel" data-testid="result">
					<h3 class="text-sm font-semibold text-slate-900">{i + 1}. {q.prompt}</h3>
					{#if q.kind === 'text'}
						<ul class="mt-2 space-y-2 text-sm text-slate-700">
							{#each q.texts as t, k (k)}
								<li class="rounded bg-slate-50 p-2 break-words whitespace-pre-line">
									{t.text}{#if t.name}<span class="block text-xs text-slate-500">{t.name}</span>{/if}
								</li>
							{:else}
								<li class="text-slate-500">No written answers.</li>
							{/each}
						</ul>
					{:else if q.hidden}
						<p class="mt-2 text-sm text-slate-600">Hidden: fewer than {s.minGroupSize} answers.</p>
					{:else}
						<p class="mt-1 text-sm text-slate-600" data-testid="result-summary">
							{q.total} answers{q.avg !== null ? ` · average ${q.avg}` : ''}{q.enps
								? ` · eNPS ${q.enps.score} (${q.enps.promoters}% promoters, ${q.enps.passives}% passives, ${q.enps.detractors}% detractors)`
								: ''}
						</p>
						<ul class="mt-2 space-y-1 text-sm">
							{#each q.dist as n, v (v)}
								<li class="flex items-center gap-2">
									<span class="w-28 shrink-0 truncate text-slate-700">{labelOf(q.kind, q.options, v)}</span>
									<span class="h-2 rounded bg-brand-600" style={`width: ${pct(n, q.total)}%`}></span>
									<span class="text-xs text-slate-500">{n}</span>
								</li>
							{/each}
						</ul>
						{#if q.slices.length}
							<table class="mt-3 w-full text-left text-sm">
								<thead class="text-xs text-slate-500">
									<tr>
										<th class="py-1">{r.dimension === 'branch' ? 'Branch' : 'Department'}</th><th>Answers</th><th>
											Result
										</th>
									</tr>
								</thead>
								<tbody>
									{#each q.slices as sl (sl.key)}
										<tr class="border-t border-slate-100" data-testid="slice">
											<td class="py-1 break-words">{sl.label}</td>
											{#if sl.hidden}
												<td colspan="2" class="text-slate-500">Hidden</td>
											{:else}
												<td>{sl.total}</td>
												<td>
													{sl.enps
														? `eNPS ${sl.enps.score}`
														: sl.avg !== null
															? `average ${sl.avg}`
															: sl.dist.join(' / ')}
												</td>
											{/if}
										</tr>
									{/each}
								</tbody>
							</table>
						{/if}
					{/if}
				</article>
			{/each}
		{/if}
	</section>
{/if}
