<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const r = $derived(data.resignation);
	const short = $derived(r.requestedLastDay < r.noticeEnds);
	const field = 'mt-1 block w-full input';
</script>

<svelte:head><title>Resignation · {data.tenant.name}</title></svelte:head>

<a href="/t/{data.tenant.slug}/approvals" class="text-sm text-brand-600 hover:underline">Back to approvals</a>
<h1 class="page-title mt-2">Resignation from {r.employee.fullName}</h1>
<p class="text-sm text-slate-600">{r.employee.code} · submitted {r.submittedOn} · {r.status.replace('_', ' ')}</p>

<div class="mt-4 max-w-3xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'decided' in form}<Alert tone="info" message="Decision saved." />{/if}
</div>

<dl class="mt-4 max-w-3xl space-y-2 rounded-xl bg-white p-6 text-sm ring-1 ring-slate-200">
	<div class="flex gap-3">
		<dt class="w-28 shrink-0 text-slate-500 sm:w-40">Requested last day</dt>
		<dd data-testid="requested-last-day">{r.requestedLastDay}</dd>
	</div>
	<div class="flex gap-3">
		<dt class="w-28 shrink-0 text-slate-500 sm:w-40">Notice period</dt>
		<dd>{r.noticeDays} days, ends {r.noticeEnds}{short ? ' (requested day is earlier)' : ''}</dd>
	</div>
	{#if r.approvedLastDay}
		<div class="flex gap-3">
			<dt class="w-28 shrink-0 text-slate-500 sm:w-40">Agreed last day</dt>
			<dd>{r.approvedLastDay}</dd>
		</div>
	{/if}
	<div class="flex gap-3">
		<dt class="w-28 shrink-0 text-slate-500 sm:w-40">Reason</dt>
		<dd class="whitespace-pre-line">{r.reason}</dd>
	</div>
	{#if r.managerNote}
		<div class="flex gap-3">
			<dt class="w-28 shrink-0 text-slate-500 sm:w-40">Manager note</dt>
			<dd>{r.managerNote}</dd>
		</div>
	{/if}
	{#if r.decisionNote}
		<div class="flex gap-3">
			<dt class="w-28 shrink-0 text-slate-500 sm:w-40">HR note</dt>
			<dd>{r.decisionNote}</dd>
		</div>
	{/if}
</dl>

{#if r.stage}
	<form method="POST" class="mt-6 max-w-3xl space-y-3">
		{#if r.stage === 'hr'}
			<label class="block text-sm text-slate-700">
				Agreed last working day
				<input name="lastDay" type="date" min={r.submittedOn} value={r.requestedLastDay} class={field} />
			</label>
		{/if}
		<label class="block text-sm text-slate-700">
			Note
			<textarea name="note" maxlength={500} class={field}></textarea>
		</label>
		<div class="flex gap-3">
			<Button type="submit" name="decision" value="approve">
				{r.stage === 'manager' ? 'Agree and send to HR' : 'Accept'}
			</Button>
			<Button type="submit" name="decision" value="reject" variant="danger">Decline</Button>
		</div>
	</form>
{/if}
