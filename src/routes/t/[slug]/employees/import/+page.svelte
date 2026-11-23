<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const rowErrors = $derived(form && 'rows' in form ? (form.rows as { line: number; message: string }[]) : []);
</script>

<svelte:head><title>Import employees · {data.tenant.name}</title></svelte:head>

<a href="/t/{data.tenant.slug}/employees" class="text-sm text-indigo-600 hover:underline">Back to employees</a>
<h1 class="mt-2 text-2xl font-semibold text-slate-900">Import employees</h1>
<p class="mt-2 max-w-3xl text-sm text-slate-600">
	Upload a UTF-8 CSV of up to 2000 rows with this header. Department, designation, grade and branch are matched by name;
	the manager by work email, so list managers before their reports. Either every row is added or none is.
</p>
<code class="mt-2 block max-w-3xl rounded bg-slate-100 p-3 text-xs break-all">{data.columns.join(',')}</code>

<form method="POST" enctype="multipart/form-data" class="mt-6 flex max-w-3xl items-end gap-3">
	<input name="file" type="file" accept=".csv,text/csv" required aria-label="CSV file" class="text-sm" />
	<Button type="submit">Import</Button>
</form>

<div class="mt-4 max-w-3xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'imported' in form}<Alert tone="info" message="{form.imported} employees imported." />{/if}
	{#if rowErrors.length}
		<ul class="rounded-xl bg-white p-4 text-sm ring-1 ring-slate-200" aria-label="Import errors">
			{#each rowErrors as r (r.line)}
				<li data-testid="import-error"><span class="font-medium">Line {r.line}:</span> {r.message}</li>
			{/each}
		</ul>
	{/if}
</div>
