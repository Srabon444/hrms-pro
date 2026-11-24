<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const input = 'mt-1 block w-full input';
	const verdict: Record<string, string> = { strong_no: 'Strong no', no: 'No', yes: 'Yes', strong_yes: 'Strong yes' };
	const when = (d: Date | string) => new Date(d).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
</script>

<svelte:head><title>My interviews · {data.tenant.name}</title></svelte:head>

<h1 class="page-title">My interviews</h1>

<div class="mt-4 max-w-3xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'done' in form}<Alert tone="info" message={form.done} />{/if}
</div>

{#if data.interviews.length}
	<ul class="mt-4 max-w-3xl space-y-3">
		{#each data.interviews as i (i.interviewId)}
			<li class="rounded-xl bg-white p-4 ring-1 ring-slate-200" aria-label={`${i.candidateName} · ${i.title}`}>
				<p class="font-medium text-slate-900">
					{#if data.canRead}
						<a class="text-brand-700 underline" href={`/t/${data.tenant.slug}/recruitment/candidates/${i.candidateId}`}>
							{i.candidateName}
						</a>
					{:else}{i.candidateName}{/if}
					· {i.title} · {i.openingTitle}
				</p>
				<p class="text-sm text-slate-600">
					{when(i.scheduledAt)} · {i.durationMinutes} min{i.location ? ` · ${i.location}` : ''}
				</p>
				{#if i.submittedAt}
					<p class="mt-2 text-sm">
						You rated {i.rating}/5 · {verdict[i.recommendation ?? '']}{i.comments ? ` · ${i.comments}` : ''}
					</p>
				{:else}
					<form method="POST" action="?/feedback" class="mt-3 grid gap-3 sm:grid-cols-2">
						<input type="hidden" name="interviewId" value={i.interviewId} />
						<label class="block text-sm font-medium text-slate-700">
							Rating
							<select name="rating" required class={input}>
								<option value="">Choose</option>
								{#each [5, 4, 3, 2, 1] as r (r)}<option value={r}>{r}</option>{/each}
							</select>
						</label>
						<label class="block text-sm font-medium text-slate-700">
							Recommendation
							<select name="recommendation" required class={input}>
								<option value="">Choose</option>
								{#each Object.entries(verdict) as [k, label] (k)}<option value={k}>{label}</option>{/each}
							</select>
						</label>
						<label class="block text-sm font-medium text-slate-700 sm:col-span-2">
							Comments
							<textarea name="comments" rows="3" maxlength="2000" class={input}></textarea>
						</label>
						<div><Button type="submit">Send feedback</Button></div>
					</form>
				{/if}
			</li>
		{/each}
	</ul>
{:else}
	<p class="mt-4 text-sm text-slate-600">No interviews assigned to you.</p>
{/if}
