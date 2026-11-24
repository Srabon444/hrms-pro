<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const l = $derived(data.leave);
	const field = 'mt-1 block w-full input';
</script>

<svelte:head><title>Leave request · {data.tenant.name}</title></svelte:head>

<a href="/t/{data.tenant.slug}/approvals" class="text-sm text-brand-600 hover:underline">Back to approvals</a>
<h1 class="page-title mt-2">{l.type} for {l.employee.fullName}</h1>
<p class="text-sm text-slate-600">{l.employee.code} · {l.status}</p>

<div class="mt-4 max-w-3xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'decided' in form}<Alert tone="info" message="Decision saved." />{/if}
	{#if form && 'cancelled' in form}<Alert tone="info" message="Leave cancelled." />{/if}
</div>

<dl class="mt-4 max-w-3xl space-y-2 rounded-xl bg-white p-6 text-sm ring-1 ring-slate-200">
	<div class="flex gap-3">
		<dt class="w-28 shrink-0 text-slate-500 sm:w-40">Dates</dt>
		<dd>
			{l.startDate}{l.endDate !== l.startDate ? ` to ${l.endDate}` : ''}{l.session !== 'full' ? ` (${l.session})` : ''}
		</dd>
	</div>
	<div class="flex gap-3">
		<dt class="w-28 shrink-0 text-slate-500 sm:w-40">Days counted</dt>
		<dd data-testid="leave-days">{l.days}{l.dates.length ? ` · ${l.dates.join(', ')}` : ''}</dd>
	</div>
	{#if l.balance}
		<div class="flex gap-3">
			<dt class="w-28 shrink-0 text-slate-500 sm:w-40">Balance</dt>
			<dd>{l.balance.balance} days, {l.balance.pending} pending</dd>
		</div>
	{/if}
	{#if l.reason}
		<div class="flex gap-3">
			<dt class="w-28 shrink-0 text-slate-500 sm:w-40">Reason</dt>
			<dd class="whitespace-pre-line">{l.reason}</dd>
		</div>
	{/if}
	{#if l.decisionNote}
		<div class="flex gap-3">
			<dt class="w-28 shrink-0 text-slate-500 sm:w-40">Note</dt>
			<dd>{l.decisionNote}</dd>
		</div>
	{/if}
</dl>

{#if l.canDecide}
	<form method="POST" action="?/decide" class="mt-6 max-w-3xl space-y-3">
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
{#if l.canCancel}
	<form method="POST" action="?/cancel" class="mt-4">
		<Button type="submit" variant="secondary">Cancel leave</Button>
	</form>
{/if}
