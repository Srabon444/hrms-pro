<script lang="ts">
	import EmployeeForm from '#lib/components/EmployeeForm.svelte';
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<svelte:head><title>New employee · {data.tenant.name}</title></svelte:head>

<a href="/t/{data.tenant.slug}/employees" class="text-sm text-indigo-600 hover:underline">Back to employees</a>
<h1 class="mt-2 text-2xl font-semibold text-slate-900">New employee</h1>

<form method="POST" class="mt-6 max-w-3xl rounded-xl bg-white p-6 ring-1 ring-slate-200">
	<div class="mb-4"><Alert message={form?.message} /></div>
	<EmployeeForm values={form?.values} choices={data.choices} sensitive={data.sensitive} />
	<div class="mt-6"><Button type="submit">Add employee</Button></div>
</form>
