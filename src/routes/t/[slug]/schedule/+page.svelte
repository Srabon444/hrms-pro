<script lang="ts">
	import { enhance } from '$app/forms';
	import Alert from '#lib/components/ui/Alert.svelte';
	import Badge from '#lib/components/ui/Badge.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import { WEEKDAYS } from '#lib/day-month.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const w = $derived(data.week);
	type Row = (typeof data.week.rows)[number];
	type Cell = Row['cells'][number];
	let picked = $state<{ row: Row; cell: Cell } | null>(null);
	let kind = $state('work');
	let when = $state('weekday');
	const day = (d: string) =>
		new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', {
			weekday: 'short',
			day: 'numeric',
			month: 'short',
			timeZone: 'UTC'
		});
	const link = 'rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-slate-700 no-underline hover:bg-slate-50';
	const act = (name: string) => `?week=${w.start}&/${name}`;
	const pick = (row: Row, cell: Cell) => {
		picked = { row, cell };
		kind = cell.entry?.kind ?? 'work';
	};
	const done = () => {
		return async ({ result, update }: { result: { type: string }; update: () => Promise<void> }) => {
			if (result.type === 'success') picked = null;
			await update();
		};
	};
	const published = $derived(form && 'published' in form ? form.published : null);
</script>

<svelte:head><title>Schedule · {data.tenant.name}</title></svelte:head>

<h1 class="page-title">Schedule</h1>
<p class="mt-1 max-w-3xl text-sm text-slate-600">
	The published schedule decides who works which shift each day. Drafts stay hidden from staff until they are published.
</p>

<div class="mt-4 max-w-3xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'saved' in form}<Alert tone="info" message="Schedule saved." />{/if}
	{#if form && 'removed' in form}<Alert tone="info" message="Schedule entry removed." />{/if}
	{#if form && 'copied' in form}<Alert
			tone="info"
			message="{form.copied} entries copied from last week as drafts."
		/>{/if}
	{#if published}
		<Alert tone="info" message="{published.published} entries published." />
		{#if published.noRest.length}
			<Alert message="No rest day this week for {published.noRest.join(', ')}." />
		{/if}
	{/if}
	{#if form && 'availabilitySaved' in form}<Alert tone="info" message="Unavailable time added." />{/if}
	{#if form && 'availabilityRemoved' in form}<Alert tone="info" message="Unavailable time removed." />{/if}
</div>

<nav class="mt-4 flex flex-wrap items-center gap-2 text-sm" aria-label="Week">
	<a class={link} href="?week={w.prev}">Previous week</a>
	<a class={link} href="?week={w.today}">This week</a>
	<a class={link} href="?week={w.next}">Next week</a>
	<span class="text-slate-600" data-testid="week-range">{day(w.days[0].date)} – {day(w.days[6].date)}</span>
</nav>

{#if w.canManage}
	<div class="mt-3 flex flex-wrap gap-2">
		<form method="POST" action={act('copy')} use:enhance>
			<input type="hidden" name="week" value={w.start} />
			<Button type="submit" variant="secondary">Copy last week</Button>
		</form>
		<form method="POST" action={act('publish')} use:enhance>
			<input type="hidden" name="week" value={w.start} />
			<Button type="submit" disabled={!w.drafts}>Publish {w.drafts} drafts</Button>
		</form>
	</div>
{/if}

<div class="mt-4 max-w-full overflow-x-auto rounded-xl bg-white ring-1 ring-slate-200" data-testid="schedule-grid">
	<table class="min-w-[56rem] text-sm">
		<thead>
			<tr class="border-b border-slate-200 text-left text-xs text-slate-500">
				<th class="sticky left-0 bg-white p-2 font-medium">Person</th>
				{#each w.days as d (d.date)}
					<th class="p-2 font-medium" class:bg-amber-50={d.holiday}>
						{day(d.date)}
						{#if d.holiday}<span class="block font-normal text-amber-800">{d.holiday}</span>{/if}
					</th>
				{/each}
			</tr>
		</thead>
		<tbody>
			{#each w.rows as row (row.id)}
				<tr class="border-b border-slate-100 align-top">
					<th class="sticky left-0 bg-white p-2 text-left font-medium [overflow-wrap:anywhere]">
						{row.name}<span class="block text-xs font-normal text-slate-500">{row.code}</span>
					</th>
					{#each row.cells as cell (cell.date)}
						{#snippet body()}
							{#if cell.entry}
								<span class="block font-medium">{cell.entry.kind === 'off' ? 'Day off' : cell.entry.shift}</span>
								{#if cell.entry.status === 'draft'}<Badge status="pending" label="Draft" />{/if}
							{:else if cell.rest}
								<span class="block text-slate-400">Rest</span>
							{:else if cell.usual}
								<span class="block text-slate-400">{cell.usual}</span>
							{/if}
							{#if cell.leave}<Badge status={cell.leave} label="Leave {cell.leave}" />{/if}
							{#each cell.unavailable as u (u.from + u.to)}
								<span class="block text-xs text-slate-500">Unavailable {u.from}–{u.to}</span>
							{/each}
							{#each cell.conflicts as c (c)}<span class="block text-xs text-red-700">{c}</span>{/each}
						{/snippet}
						<td class="min-w-28 p-1" class:bg-slate-50={cell.rest && !cell.entry}>
							{#if row.canManage}
								<button
									type="button"
									class="w-full rounded-lg p-1 text-left hover:bg-brand-50"
									aria-label="{row.name} {cell.date}"
									onclick={() => pick(row, cell)}
								>
									{@render body()}
								</button>
							{:else}
								<div class="p-1">{@render body()}</div>
							{/if}
						</td>
					{/each}
				</tr>
			{:else}
				<tr><td colspan="8" class="p-4 text-slate-500">Nobody to schedule this week.</td></tr>
			{/each}
		</tbody>
	</table>
</div>
{#if w.truncated}<p class="mt-2 text-xs text-slate-500">Showing the first {w.rows.length} people.</p>{/if}

{#if picked}
	{@const p = picked}
	<section class="mt-6 max-w-3xl panel" aria-label="Edit schedule">
		<h2 class="section-title">{p.row.name} · {day(p.cell.date)}</h2>
		<form method="POST" action={act('save')} use:enhance={done} class="mt-3 grid gap-3 sm:grid-cols-2">
			<input type="hidden" name="employeeId" value={p.row.id} />
			<input type="hidden" name="date" value={p.cell.date} />
			<label class="text-sm text-slate-700">
				Day
				<select name="kind" bind:value={kind} class="input mt-1 block w-full">
					<option value="work">Works a shift</option>
					<option value="off">Day off</option>
				</select>
			</label>
			{#if kind === 'work'}
				<label class="text-sm text-slate-700">
					Shift
					<select name="shiftId" required class="input mt-1 block w-full" value={p.cell.entry?.shiftId ?? ''}>
						<option value="" disabled>Choose a shift</option>
						{#each w.shifts as s (s.id)}<option value={s.id}>{s.name}</option>{/each}
					</select>
				</label>
			{/if}
			<label class="text-sm text-slate-700 sm:col-span-2">
				Note
				<input name="note" maxlength={200} value={p.cell.entry?.note ?? ''} class="input mt-1 block w-full" />
			</label>
			<div class="flex gap-2 sm:col-span-2">
				<Button type="submit">Save</Button>
				<Button type="button" variant="secondary" onclick={() => (picked = null)}>Close</Button>
			</div>
		</form>
		{#if p.cell.entry}
			<form method="POST" action={act('remove')} use:enhance={done} class="mt-3">
				<input type="hidden" name="entryId" value={p.cell.entry.id} />
				<Button type="submit" variant="secondary">Remove from schedule</Button>
			</form>
		{/if}
	</section>
{/if}

{#if data.availability}
	<section class="mt-6 max-w-3xl panel" aria-label="My unavailable times">
		<h2 class="section-title">My unavailable times</h2>
		<p class="mt-1 text-sm text-slate-600">Managers see these when they plan the schedule.</p>
		<ul class="mt-3 space-y-2 text-sm">
			{#each data.availability as a (a.id)}
				<li class="flex flex-wrap items-center gap-2">
					<span>
						{a.date ? day(a.date) : `Every ${WEEKDAYS[a.weekday ?? 0]}`}, {a.fromTime.slice(0, 5)}–{a.toTime.slice(
							0,
							5
						)}
						{#if a.note}<span class="text-slate-500">· {a.note}</span>{/if}
					</span>
					<form method="POST" action={act('removeAvailability')} use:enhance>
						<input type="hidden" name="availabilityId" value={a.id} />
						<Button type="submit" variant="secondary">Remove</Button>
					</form>
				</li>
			{:else}
				<li class="text-slate-500">None yet.</li>
			{/each}
		</ul>
		<form method="POST" action={act('addAvailability')} use:enhance class="mt-4 grid gap-3 sm:grid-cols-2">
			<label class="text-sm text-slate-700">
				Repeats
				<select name="when" bind:value={when} class="input mt-1 block w-full">
					<option value="weekday">Every week</option>
					<option value="date">One date</option>
				</select>
			</label>
			{#if when === 'weekday'}
				<label class="text-sm text-slate-700">
					Weekday
					<select name="weekday" class="input mt-1 block w-full">
						{#each WEEKDAYS as d, i (d)}<option value={String(i)}>{d}</option>{/each}
					</select>
				</label>
			{:else}
				<label class="text-sm text-slate-700">
					Date
					<input type="date" name="date" required min="2000-01-01" max="2099-12-31" class="input mt-1 block w-full" />
				</label>
			{/if}
			<label class="text-sm text-slate-700">
				From
				<input type="time" name="fromTime" required class="input mt-1 block w-full" />
			</label>
			<label class="text-sm text-slate-700">
				To
				<input type="time" name="toTime" required class="input mt-1 block w-full" />
			</label>
			<label class="text-sm text-slate-700 sm:col-span-2">
				Note
				<input name="note" maxlength={200} class="input mt-1 block w-full" />
			</label>
			<div class="sm:col-span-2"><Button type="submit">Add unavailable time</Button></div>
		</form>
	</section>
{/if}
