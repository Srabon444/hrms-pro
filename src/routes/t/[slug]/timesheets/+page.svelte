<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import Field from '#lib/components/ui/Field.svelte';
	import { hoursOf, TIMESHEET_STATUS_LABELS } from '#lib/project-labels.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const w = $derived(data.week);
	const values = $derived((form && 'values' in form ? form.values : {}) as Record<string, string>);
	const input = 'mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm';
	const total = $derived(w ? w.entries.reduce((s, e) => s + e.minutes, 0) : 0);
	const base = $derived(`/t/${data.tenant.slug}/timesheets`);
</script>

<svelte:head><title>Timesheets · {data.tenant.name}</title></svelte:head>

<h1 class="text-2xl font-semibold text-slate-900">Timesheets</h1>

<div class="mt-4 max-w-4xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'done' in form}<Alert tone="info" message={form.done} />{/if}
</div>

{#if data.waiting.length}
	<section class="mt-4 max-w-4xl" aria-label="Waiting for you">
		<h2 class="font-semibold text-slate-900">Waiting for you</h2>
		<ul class="mt-2 space-y-1 text-sm">
			{#each data.waiting as t (t.id)}
				<li><a class="text-indigo-700 underline" href={`${base}/${t.id}`}>{t.title}</a></li>
			{/each}
		</ul>
	</section>
{/if}

{#if w}
	<section class="mt-6 max-w-4xl" aria-label="My week">
		<h2 class="font-semibold text-slate-900">
			Week of {w.week} · {hoursOf(total)} h{w.sheet ? ` · ${TIMESHEET_STATUS_LABELS[w.sheet.status]}` : ''}
		</h2>
		<nav class="mt-1 flex gap-3 text-sm" aria-label="Weeks">
			<a class="text-indigo-700 underline" href={`?week=${w.previous}`}>Previous week</a>
			{#if w.next}<a class="text-indigo-700 underline" href={`?week=${w.next}`}>Next week</a>{/if}
		</nav>
		{#if w.sheet?.status === 'rejected' && w.sheet.decisionNote}
			<p class="mt-2 text-sm text-amber-800">Sent back: {w.sheet.decisionNote}</p>
		{/if}
		{#if w.entries.length}
			<table class="mt-3 w-full text-left text-sm">
				<thead class="text-slate-500">
					<tr><th class="py-2">Date</th><th>Project</th><th>Hours</th><th>Note</th><th></th></tr>
				</thead>
				<tbody>
					{#each w.entries as e (e.id)}
						<tr class="border-t border-slate-200" data-testid="time-entry">
							<td class="py-2">{e.workDate}</td>
							<td>{e.code} · {e.project}</td>
							<td>{hoursOf(e.minutes)}</td>
							<td>{e.note || '—'}</td>
							<td>
								{#if w.canEdit}
									<form method="POST" action="?/remove">
										<input type="hidden" name="entryId" value={e.id} />
										<Button type="submit" variant="secondary">Remove {e.code} on {e.workDate}</Button>
									</form>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{:else}
			<p class="mt-2 text-sm text-slate-600">No time logged this week.</p>
		{/if}
	</section>

	{#if w.canEdit}
		{#if w.projects.length}
			<section class="mt-6 max-w-4xl rounded-xl bg-white p-6 ring-1 ring-slate-200" aria-label="Log time">
				<h2 class="font-semibold text-slate-900">Log time</h2>
				<form method="POST" action="?/log" class="mt-3 grid gap-3 sm:grid-cols-4">
					<label class="block text-sm font-medium text-slate-700">
						Project
						<select name="projectId" required class={input}>
							{#each w.projects as p (p.id)}
								<option value={p.id} selected={values.projectId === p.id}>{p.code} · {p.name}</option>
							{/each}
						</select>
					</label>
					<label class="block text-sm font-medium text-slate-700">
						Date
						<select name="workDate" required class={input}>
							{#each w.days as d (d)}<option value={d} selected={(values.workDate ?? w.today) === d}>{d}</option>{/each}
						</select>
					</label>
					<Field
						label="Hours"
						name="hours"
						inputmode="decimal"
						pattern={'\\d{1,2}(\\.\\d{1,2})?'}
						required
						value={values.hours ?? ''}
					/>
					<Field label="Note" name="note" maxlength={300} value={values.note ?? ''} />
					<div><Button type="submit">Log time</Button></div>
				</form>
			</section>
		{:else}
			<p class="mt-6 text-sm text-slate-600">You are not on any active project yet.</p>
		{/if}
		{#if w.entries.length}
			<form method="POST" action="?/submit" class="mt-4">
				<input type="hidden" name="weekStart" value={w.week} />
				<Button type="submit">Submit week for approval</Button>
			</form>
		{/if}
	{/if}

	{#if w.recent.length}
		<section class="mt-6 max-w-4xl" aria-label="Recent weeks">
			<h2 class="font-semibold text-slate-900">Recent weeks</h2>
			<ul class="mt-2 space-y-1 text-sm">
				{#each w.recent as r (r.id)}
					<li>
						<a class="text-indigo-700 underline" href={`?week=${r.weekStart}`}>Week of {r.weekStart}</a>
						<span class="text-slate-500">· {TIMESHEET_STATUS_LABELS[r.status]}</span>
					</li>
				{/each}
			</ul>
		</section>
	{/if}
{/if}
