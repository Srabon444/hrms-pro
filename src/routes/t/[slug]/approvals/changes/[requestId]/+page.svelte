<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const c = $derived(data.change);
</script>

<svelte:head><title>Profile change · {data.tenant.name}</title></svelte:head>

<a href="/t/{data.tenant.slug}/approvals" class="text-sm text-indigo-600 hover:underline">Back to approvals</a>
<h1 class="mt-2 text-2xl font-semibold text-slate-900">Profile change for {c.employee.fullName}</h1>
<p class="text-sm text-slate-600">{c.employee.code} · requested {c.at.toLocaleDateString()} · {c.status}</p>

<div class="mt-4 max-w-3xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'decided' in form}<Alert tone="info" message="Decision saved." />{/if}
</div>

<table class="mt-4 w-full max-w-3xl rounded-xl bg-white text-left text-sm ring-1 ring-slate-200">
	<thead class="text-slate-500">
		<tr><th class="p-3">Field</th><th class="p-3">Now</th><th class="p-3">Requested</th></tr>
	</thead>
	<tbody>
		{#each c.rows as r (r.key)}
			<tr class="border-t border-slate-100" data-testid="change-row">
				<td class="p-3">{r.label}</td>
				<td class="p-3">{r.current ?? 'hidden'}</td>
				<td class="p-3 font-medium">{r.requested || 'cleared'}</td>
			</tr>
		{/each}
	</tbody>
</table>

{#if c.status === 'pending'}
	<form method="POST" class="mt-6 max-w-3xl space-y-3">
		<label class="block text-sm text-slate-700">
			Note to the employee
			<textarea name="note" maxlength={500} class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2"
			></textarea>
		</label>
		<div class="flex gap-3">
			<Button type="submit" name="decision" value="approve">Approve</Button>
			<Button type="submit" name="decision" value="reject" variant="danger">Reject</Button>
		</div>
	</form>
{:else if c.decisionNote}
	<p class="mt-6 text-sm text-slate-700">Note: {c.decisionNote}</p>
{/if}
