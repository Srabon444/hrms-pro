<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import Field from '#lib/components/ui/Field.svelte';
	import { scoreLabel } from '#lib/domain/performance/score.ts';
	import { STAGE_LABELS } from '#lib/performance-labels.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const r = $derived(data.view.review);
	const goals = $derived(data.view.goals);
	const allowed = $derived(data.view.allowed);
	const weightLeft = $derived(100 - goals.reduce((sum, g) => sum + g.weight, 0));
	const input = 'mt-1 block w-full input';
	const ratings = [1, 2, 3, 4, 5];
</script>

<svelte:head><title>{r.name} · {r.cycleName} · {data.tenant.name}</title></svelte:head>

<a class="text-sm text-brand-700 underline" href={`/t/${data.tenant.slug}/performance/${r.cycleId}`}>{r.cycleName}</a>
<h1 class="page-title mt-2">{r.name} · {STAGE_LABELS[r.stage]}</h1>
{#if r.score !== null}<p class="mt-1 text-sm text-slate-700">Score {scoreLabel(r.score)} out of 5</p>{/if}
{#if r.own && r.stage === 'done' && !r.shared}
	<p class="mt-1 text-sm text-slate-600">HR has finalised this review and will share the result with you.</p>
{/if}

<div class="mt-4 max-w-3xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'done' in form}<Alert tone="info" message={form.done} />{/if}
</div>

<section class="mt-4 max-w-3xl" aria-label="Goals">
	<h2 class="section-title">Goals</h2>
	{#if goals.length}
		<ul class="mt-2 space-y-3">
			{#each goals as g (g.id)}
				<li class="rounded-xl bg-white p-4 text-sm ring-1 ring-slate-200" data-testid="goal">
					<p class="font-medium text-slate-900">{g.title} · weight {g.weight}</p>
					{#if g.target}<p class="text-slate-600">Target: {g.target}</p>{/if}
					{#if g.actual}<p class="text-slate-600">Result: {g.actual}</p>{/if}
					{#if g.selfRating !== null}<p>Self rating {g.selfRating}/5</p>{/if}
					{#if g.managerRating !== null}<p>Manager rating {g.managerRating}/5</p>{/if}
					{#if allowed.goals}
						<form method="POST" action="?/remove" class="mt-2">
							<input type="hidden" name="goalId" value={g.id} />
							<Button type="submit" variant="secondary">Remove {g.title}</Button>
						</form>
					{/if}
				</li>
			{/each}
		</ul>
	{:else}
		<p class="mt-2 text-sm text-slate-600">No goals yet.</p>
	{/if}
</section>

{#if allowed.goals}
	<section class="mt-6 max-w-3xl panel" aria-label="Add goal">
		<h2 class="section-title">Add goal</h2>
		<p class="mt-1 text-sm text-slate-600">Weights must add up to 100 before the self review. {weightLeft} left.</p>
		<form method="POST" action="?/goal" class="mt-3 grid gap-3 sm:grid-cols-2">
			<Field label="Goal" name="title" required maxlength={120} />
			<Field label="Target" name="target" maxlength={200} />
			<Field
				label="Weight"
				name="weight"
				type="number"
				min="1"
				max={String(Math.max(1, weightLeft))}
				step="1"
				required
			/>
			<div><Button type="submit">Add goal</Button></div>
		</form>
	</section>
{/if}

{#if allowed.self && goals.length}
	<section class="mt-6 max-w-3xl panel" aria-label="Self review">
		<h2 class="section-title">Self review</h2>
		<form method="POST" action="?/self" class="mt-3 space-y-4">
			{#each goals as g (g.id)}
				<fieldset class="grid gap-3 sm:grid-cols-2">
					<legend class="text-sm font-medium text-slate-900">{g.title}</legend>
					<Field label={`Result for ${g.title}`} name={`actual.${g.id}`} maxlength={200} />
					<label class="block text-sm font-medium text-slate-700">
						Your rating for {g.title}
						<select name={`rating.${g.id}`} required class={input}>
							<option value="">Choose</option>
							{#each ratings as n (n)}<option value={n}>{n}</option>{/each}
						</select>
					</label>
				</fieldset>
			{/each}
			<label class="block text-sm font-medium text-slate-700">
				Comments
				<textarea name="comments" rows="3" maxlength="4000" class={input}></textarea>
			</label>
			<Button type="submit">Send self review</Button>
		</form>
	</section>
{/if}

{#if r.selfComments}
	<section class="mt-6 max-w-3xl" aria-label="Self comments">
		<h2 class="section-title">Self comments</h2>
		<p class="mt-1 text-sm whitespace-pre-line">{r.selfComments}</p>
	</section>
{/if}

{#if allowed.manager}
	<section class="mt-6 max-w-3xl panel" aria-label="Manager review">
		<h2 class="section-title">Manager review</h2>
		<form method="POST" action="?/manager" class="mt-3 space-y-4">
			{#each goals as g (g.id)}
				<label class="block text-sm font-medium text-slate-700">
					Rating for {g.title}
					<select name={`rating.${g.id}`} required class={input}>
						<option value="">Choose</option>
						{#each ratings as n (n)}<option value={n}>{n}</option>{/each}
					</select>
				</label>
			{/each}
			<label class="block text-sm font-medium text-slate-700">
				Comments
				<textarea name="comments" rows="3" maxlength="4000" class={input}></textarea>
			</label>
			<Button type="submit">Send rating</Button>
		</form>
	</section>
{/if}

{#if r.managerComments}
	<section class="mt-6 max-w-3xl" aria-label="Manager comments">
		<h2 class="section-title">Manager comments</h2>
		<p class="mt-1 text-sm whitespace-pre-line">{r.managerComments}</p>
	</section>
{/if}

{#if allowed.finalise}
	<section class="mt-6 max-w-3xl panel" aria-label="Finalise">
		<h2 class="section-title">Finalise</h2>
		<form method="POST" action="?/finalise" class="mt-3 space-y-3">
			<label class="flex items-center gap-2 text-sm">
				<input type="checkbox" name="share" /> Share the result with {r.name} now
			</label>
			<Button type="submit">Finalise review</Button>
		</form>
	</section>
{/if}

{#if allowed.share}
	<form method="POST" action="?/share" class="mt-6">
		<Button type="submit">Share with {r.name}</Button>
	</form>
{/if}
