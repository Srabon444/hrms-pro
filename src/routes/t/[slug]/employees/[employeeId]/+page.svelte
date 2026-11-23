<script lang="ts">
	import EmployeeForm from '#lib/components/EmployeeForm.svelte';
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const e = $derived(data.employee);
	const values = $derived(form && 'values' in form ? form.values : { ...e, ...(data.sensitive ?? {}) });
	const facts = $derived([
		['Code', e.code],
		['Status', e.status],
		['Department', data.names.department],
		['Designation', data.names.designation],
		['Grade', data.names.grade],
		['Branch', data.names.branch],
		['Manager', data.names.managerName && `${data.names.managerName} (${data.names.managerCode})`],
		['Joined', e.joinDate],
		['Work email', e.workEmail],
		['Phone', e.phone]
	]);
</script>

<svelte:head><title>{e.fullName} · {data.tenant.name}</title></svelte:head>

<a href="/t/{data.tenant.slug}/employees" class="text-sm text-indigo-600 hover:underline">Back to employees</a>
<h1 class="mt-2 text-2xl font-semibold text-slate-900">{e.fullName}</h1>

<dl class="mt-4 grid max-w-3xl gap-x-6 gap-y-2 rounded-xl bg-white p-6 text-sm ring-1 ring-slate-200 sm:grid-cols-2">
	{#each facts as [label, value] (label)}
		<div class="flex gap-2">
			<dt class="w-28 text-slate-500">{label}</dt>
			<dd data-testid="fact-{label}">{value ?? ''}</dd>
		</div>
	{/each}
	{#if data.sensitive}
		<div class="flex gap-2">
			<dt class="w-28 text-slate-500">National ID</dt>
			<dd>{data.sensitive.nationalId ?? ''}</dd>
		</div>
		<div class="flex gap-2">
			<dt class="w-28 text-slate-500">Bank account</dt>
			<dd>{data.sensitive.bankAccountNumber ?? ''}</dd>
		</div>
	{/if}
</dl>

{#if data.canUpdate && data.choices}
	<form method="POST" class="mt-6 max-w-3xl rounded-xl bg-white p-6 ring-1 ring-slate-200">
		<h2 class="mb-4 font-semibold text-slate-900">Edit record</h2>
		<div class="mb-4 space-y-2">
			<Alert message={form?.message} />
			{#if form && 'saved' in form}<Alert tone="info" message="Employee saved." />{/if}
		</div>
		<EmployeeForm {values} choices={data.choices} sensitive={data.canUpdateSensitive} selfId={e.id} />
		<div class="mt-6"><Button type="submit">Save changes</Button></div>
	</form>
{/if}

{#if data.history.length}
	<section class="mt-6 max-w-3xl rounded-xl bg-white p-6 ring-1 ring-slate-200" aria-label="History">
		<h2 class="font-semibold text-slate-900">History</h2>
		<ul class="mt-3 space-y-1 text-sm">
			{#each data.history as h, i (i)}
				<li data-testid="history">
					<span class="text-slate-500">{h.at.toLocaleDateString()}</span>
					{h.label}: {h.oldValue ?? 'none'} → {h.newValue ?? 'none'}
				</li>
			{/each}
		</ul>
	</section>
{/if}
