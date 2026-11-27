<script lang="ts">
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const cal = $derived(data.calendar);
	const weekday = (d: string, style: 'short' | 'long') =>
		new Date(`${d}T00:00:00Z`).toLocaleDateString('en', { weekday: style, timeZone: 'UTC' });
	const monthName = $derived(
		new Date(`${cal.month}-01T00:00:00Z`).toLocaleDateString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' })
	);
	const SESSION: Record<string, string> = { full: '', am: ' (morning)', pm: ' (afternoon)' };
	const busy = $derived(
		cal.days.filter((d) => d.inMonth && (d.out.length || d.holidays.length || d.events.length || d.shifts.length))
	);
	const feedUrl = $derived(form && 'feedUrl' in form ? form.feedUrl : null);
</script>

<svelte:head><title>Calendar · {data.tenant.name}</title></svelte:head>

<div class="flex flex-wrap items-center justify-between gap-3">
	<h1 class="page-title">Team calendar</h1>
	<nav class="flex items-center gap-2 text-sm" aria-label="Month">
		<a class="rounded border border-slate-300 px-2 py-1" href="?month={cal.prev}" data-testid="prev-month">
			← Previous
		</a>
		<span class="font-medium text-slate-900" data-testid="month">{monthName}</span>
		<a class="rounded border border-slate-300 px-2 py-1" href="?month={cal.next}" data-testid="next-month">Next →</a>
	</nav>
</div>

{#if cal.truncated}
	<p class="mt-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">
		Too many people are out this month to show everyone. Narrow it down from the leave reports.
	</p>
{/if}

<div class="mt-4 hidden md:block" data-testid="month-grid">
	<div class="grid grid-cols-7 gap-px rounded border border-slate-200 bg-slate-200 text-xs">
		{#each cal.days.slice(0, 7) as d (d.date)}
			<div class="bg-slate-50 px-2 py-1 font-medium text-slate-600">{weekday(d.date, 'short')}</div>
		{/each}
		{#each cal.days as d (d.date)}
			<div
				class={[
					'min-h-24 bg-white p-1.5',
					!d.inMonth && 'bg-slate-50 text-slate-400',
					d.date === cal.today && 'ring-2 ring-brand-500 ring-inset'
				]}
				data-testid="day"
				data-date={d.date}
			>
				<div class="font-medium">{Number(d.date.slice(8))}</div>
				{#each d.holidays as h (h)}<div class="truncate text-emerald-700" title={h}>🎉 {h}</div>{/each}
				{#each d.shifts as s, i (i)}<div class="truncate text-amber-800" title="My shift: {s.name}">
						{s.start}–{s.end}
						{s.name}
					</div>{/each}
				{#each d.events as e (e.id)}<div class="truncate text-brand-700" title={e.title}>
						{e.startTime ? `${e.startTime} ` : ''}{e.title}
					</div>{/each}
				{#each d.out.slice(0, 4) as o, i (i)}<div class="truncate text-slate-700" title="{o.name}: {o.type}">
						{o.name}{SESSION[o.session]}
					</div>{/each}
				{#if d.out.length > 4}<div class="text-slate-500">+{d.out.length - 4} more</div>{/if}
			</div>
		{/each}
	</div>
</div>

<ol class="mt-4 space-y-2 md:hidden" data-testid="agenda">
	{#each busy as d (d.date)}
		<li class="panel">
			<div class="text-sm font-semibold text-slate-900">{weekday(d.date, 'long')}, {d.date}</div>
			<ul class="mt-1 space-y-0.5 text-sm">
				{#each d.holidays as h (h)}<li class="text-emerald-700">🎉 {h}</li>{/each}
				{#each d.shifts as s, i (i)}<li class="text-amber-800">My shift: {s.name} {s.start}–{s.end}</li>{/each}
				{#each d.events as e (e.id)}<li class="text-brand-700">
						{e.startTime ? `${e.startTime} ` : ''}{e.title}
					</li>{/each}
				{#each d.out as o, i (i)}<li class="text-slate-700">{o.name}: {o.type}{SESSION[o.session]}</li>{/each}
			</ul>
		</li>
	{:else}
		<li class="text-sm text-slate-600">Nothing on this month.</li>
	{/each}
</ol>

<section class="mt-6 max-w-3xl panel" aria-label="Calendar subscription">
	<h2 class="section-title">Subscribe from your calendar app</h2>
	<p class="mt-1 text-sm text-slate-600">
		A private link with who is out, holidays and events. Anyone with the link can read it, so keep it to yourself.
	</p>
	{#if feedUrl}
		<label class="mt-3 block text-sm font-medium text-slate-700">
			Your link (shown once; copy it now)
			<input readonly value={feedUrl} class="mt-1 block w-full input font-mono text-xs" data-testid="feed-url" />
		</label>
	{:else if data.feed}
		<p class="mt-3 text-sm text-slate-700" data-testid="feed-status">
			Link starting {data.feed.prefix}… is on{data.feed.lastUsedAt
				? `, last read ${new Date(data.feed.lastUsedAt).toLocaleDateString('en')}`
				: ', not used yet'}.
		</p>
	{/if}
	<div class="mt-3 flex flex-wrap gap-2">
		<form method="POST" action="?/issueFeed">
			<Button type="submit">{data.feed ? 'Replace link' : 'Create link'}</Button>
		</form>
		{#if data.feed}
			<form method="POST" action="?/revokeFeed"><Button type="submit" variant="secondary">Turn off link</Button></form>
		{/if}
	</div>
</section>
