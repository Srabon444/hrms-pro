<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import { hoursOf, TIMESHEET_STATUS_LABELS } from '#lib/project-labels.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const v = $derived(data.view);
	const total = $derived(v.entries.reduce((s, e) => s + e.minutes, 0));
	const input = 'mt-1 block w-full input';
</script>

<svelte:head><title>{v.name} · Timesheets · {data.tenant.name}</title></svelte:head>

<a class="text-sm text-brand-700 underline" href={`/t/${data.tenant.slug}/timesheets`}>Timesheets</a>
<h1 class="page-title mt-2">{v.name} · week of {v.sheet.weekStart}</h1>
<p class="text-sm text-slate-600">{TIMESHEET_STATUS_LABELS[v.sheet.status]} · {hoursOf(total)} h</p>
{#if v.sheet.decisionNote}<p class="mt-1 text-sm text-slate-600">Note: {v.sheet.decisionNote}</p>{/if}

<div class="mt-4 max-w-4xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'done' in form}<Alert tone="info" message={form.done} />{/if}
</div>

<table class="data-table mt-4 max-w-4xl">
	<thead>
		<tr><th class="py-2">Date</th><th>Project</th><th>Hours</th><th>Note</th></tr>
	</thead>
	<tbody>
		{#each v.entries as e (e.id)}
			<tr class="border-t border-slate-200" data-testid="time-entry">
				<td class="py-2">{e.workDate}</td>
				<td>{e.code} · {e.project}</td>
				<td>{hoursOf(e.minutes)}</td>
				<td>{e.note || '—'}</td>
			</tr>
		{/each}
	</tbody>
</table>

{#if v.canDecide}
	<section class="mt-6 max-w-4xl panel" aria-label="Decide">
		<form method="POST" action="?/decide" class="space-y-3">
			<label class="block text-sm font-medium text-slate-700">
				Note (needed to send back)
				<input name="note" maxlength="300" class={input} />
			</label>
			<div class="flex gap-2">
				<Button type="submit" name="decision" value="approved">Approve timesheet</Button>
				<Button type="submit" name="decision" value="rejected" variant="secondary">Send back</Button>
			</div>
		</form>
	</section>
{/if}
