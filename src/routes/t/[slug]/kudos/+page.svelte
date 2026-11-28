<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const values = $derived((form && 'values' in form ? form.values : {}) as Record<string, string>);
	const most = $derived(Math.max(1, ...data.chart.months.flatMap((m) => m.counts)));
	const when = (d: Date | string) => new Date(d).toISOString().slice(0, 10);
</script>

<svelte:head><title>Kudos · {data.tenant.name}</title></svelte:head>

<h1 class="page-title">Kudos</h1>

<div class="mt-4 max-w-3xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'done' in form && typeof form.done === 'string'}<Alert tone="info" message={form.done} />{/if}
</div>

<section class="mt-4 max-w-3xl panel" aria-label="Give kudos">
	<h2 class="section-title">Give kudos</h2>
	<form method="POST" action="?/give" class="mt-3 space-y-3">
		<label class="block text-sm font-medium text-slate-700">
			Who to thank (up to 10)
			<select name="recipients" multiple required size="5" class="mt-1 block w-full input">
				{#each data.people as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
			</select>
		</label>
		{#if data.values.length}
			<label class="block text-sm font-medium text-slate-700">
				Value
				<select name="valueTag" class="mt-1 block w-full input">
					<option value="">No value</option>
					{#each data.values as v (v)}<option value={v} selected={values.valueTag === v}>{v}</option>{/each}
				</select>
			</label>
		{/if}
		<label class="block text-sm font-medium text-slate-700">
			Message
			<textarea name="message" required maxlength={500} rows="3" class="mt-1 block w-full input"
				>{values.message ?? ''}</textarea
			>
		</label>
		<Button type="submit">Send kudos</Button>
	</form>
</section>

<section class="mt-6 max-w-3xl space-y-3" aria-label="Kudos wall">
	<h2 class="section-title">Wall</h2>
	{#each data.wall as k (k.id)}
		<article class={['panel', k.hidden && 'opacity-60']} data-testid="kudos">
			<p class="text-sm text-slate-900">
				<span class="font-semibold">{k.from}</span> thanked
				<span class="font-semibold">{k.to.join(', ')}</span>
				{#if k.valueTag}<span class="ml-1 rounded bg-brand-50 px-2 py-0.5 text-xs text-brand-700">
						{k.valueTag}
					</span>{/if}
			</p>
			<p class="mt-1 text-sm break-words whitespace-pre-line text-slate-700">{k.message}</p>
			<div class="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
				<span>{when(k.createdAt)}{k.hidden ? ' · hidden' : ''}</span>
				{#if data.moderator}
					<form method="POST" action={k.hidden ? '?/show' : '?/hide'}>
						<input type="hidden" name="kudosId" value={k.id} />
						<Button type="submit" variant="secondary">{k.hidden ? 'Show' : 'Hide'}</Button>
					</form>
				{/if}
			</div>
		</article>
	{:else}
		<p class="text-sm text-slate-600">No kudos yet. Be the first to thank someone.</p>
	{/each}
</section>

<section class="mt-6 max-w-3xl panel" aria-label="Kudos by value">
	<h2 class="section-title">Kudos by value, last {data.chart.months.length || 0} months</h2>
	{#if data.chart.months.length}
		<div class="mt-3 space-y-3">
			{#each data.chart.months as m (m.month)}
				<div data-testid="kudos-month">
					<p class="text-xs font-medium text-slate-600">{m.month}</p>
					<ul class="mt-1 space-y-1 text-sm">
						{#each data.chart.values as v, i (v)}
							{#if m.counts[i]}
								<li class="flex items-center gap-2">
									<span class="w-28 shrink-0 truncate text-slate-700">{v}</span>
									<span class="h-2 rounded bg-brand-600" style={`width: ${(m.counts[i] / most) * 60}%`}></span>
									<span class="text-xs text-slate-500">{m.counts[i]}</span>
								</li>
							{/if}
						{/each}
					</ul>
				</div>
			{/each}
		</div>
	{:else}
		<p class="mt-2 text-sm text-slate-600">Nothing to show yet.</p>
	{/if}
</section>

{#if data.moderator}
	<section class="mt-6 max-w-3xl panel" aria-label="Company values">
		<h2 class="section-title">Company values</h2>
		<form method="POST" action="?/values" class="mt-3 space-y-3">
			<label class="block text-sm font-medium text-slate-700">
				Values people can tag, one per line (up to 20)
				<textarea name="values" rows="5" class="mt-1 block w-full input"
					>{values.values ?? data.values.join('\n')}</textarea
				>
			</label>
			<Button type="submit" variant="secondary">Save values</Button>
		</form>
	</section>
{/if}
