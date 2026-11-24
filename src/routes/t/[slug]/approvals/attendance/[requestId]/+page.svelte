<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const r = $derived(data.req);
	const field = 'mt-1 block w-full input';
</script>

<svelte:head><title>Attendance request · {data.tenant.name}</title></svelte:head>

<a href="/t/{data.tenant.slug}/approvals" class="text-sm text-brand-600 hover:underline">Back to approvals</a>
<h1 class="page-title mt-2">{r.label} for {r.employee.fullName}</h1>
<p class="text-sm text-slate-600">{r.employee.code} · {r.status}</p>

<div class="mt-4 max-w-3xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'decided' in form}<Alert tone="info" message="Decision saved." />{/if}
	{#if form && 'cancelled' in form}<Alert tone="info" message="Request cancelled." />{/if}
</div>

<dl class="mt-4 max-w-3xl space-y-2 rounded-xl bg-white p-6 text-sm ring-1 ring-slate-200">
	<div class="flex gap-3">
		<dt class="w-28 shrink-0 text-slate-500 sm:w-40">Day</dt>
		<dd>{r.date}</dd>
	</div>
	{#if r.punchAt}
		<div class="flex gap-3">
			<dt class="w-28 shrink-0 text-slate-500 sm:w-40">Punch</dt>
			<dd>{r.punchAt}</dd>
		</div>
	{/if}
	{#if r.minutes !== null}
		<div class="flex gap-3">
			<dt class="w-28 shrink-0 text-slate-500 sm:w-40">Minutes asked</dt>
			<dd>{r.minutes}{r.approvedMinutes !== null ? ` · ${r.approvedMinutes} approved` : ''}</dd>
		</div>
	{/if}
	<div class="flex gap-3">
		<dt class="w-28 shrink-0 text-slate-500 sm:w-40">Recorded</dt>
		<dd data-testid="request-day">
			{#if r.day}
				{r.day.status}{r.day.firstIn ? ` · ${r.day.firstIn} to ${r.day.lastOut ?? '—'}` : ''} · {r.day.workedMinutes} min
				worked{r.kind === 'overtime' ? ` · ${r.day.extraMinutes} min extra` : ''}
			{:else}
				Nothing yet
			{/if}
		</dd>
	</div>
	<div class="flex gap-3">
		<dt class="w-28 shrink-0 text-slate-500 sm:w-40">Reason</dt>
		<dd class="whitespace-pre-line">{r.reason}</dd>
	</div>
	{#if r.decisionNote}
		<div class="flex gap-3">
			<dt class="w-28 shrink-0 text-slate-500 sm:w-40">Note</dt>
			<dd>{r.decisionNote}</dd>
		</div>
	{/if}
</dl>

{#if r.canDecide}
	<form method="POST" action="?/decide" class="mt-6 max-w-3xl space-y-3">
		{#if r.compOff}
			<p class="text-sm text-slate-600" data-testid="comp-off">
				Worked on a weekend or holiday: approving also adds compensatory leave, half a day or a full day by the shift's
				minutes.
			</p>
		{/if}
		{#if r.kind === 'overtime'}
			<label class="block text-sm text-slate-700">
				Minutes to approve
				<input name="minutes" type="number" min={15} max={r.minutes} step={15} value={r.minutes} class={field} />
			</label>
		{/if}
		<label class="block text-sm text-slate-700">
			Note
			<textarea name="note" maxlength={500} class={field}></textarea>
		</label>
		<div class="flex gap-3">
			<Button type="submit" name="decision" value="approve">Approve</Button>
			<Button type="submit" name="decision" value="reject" variant="danger">Decline</Button>
		</div>
	</form>
{/if}
{#if r.canCancel}
	<form method="POST" action="?/cancel" class="mt-4">
		<Button type="submit" variant="secondary">Cancel request</Button>
	</form>
{/if}
