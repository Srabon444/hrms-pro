<script lang="ts">
	import ReportTables from '#lib/components/ReportTables.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const r = $derived(data.report);
	const base = $derived(`/t/${data.tenant.slug}/reports/shared/${data.share.id}/file`);
</script>

<svelte:head><title>{r.title} · {data.tenant.name}</title></svelte:head>

<a class="text-sm text-indigo-700 underline" href={`/t/${data.tenant.slug}/reports`}>All reports</a>
<h1 class="mt-2 text-2xl font-semibold text-slate-900">{r.title}</h1>
<p class="mt-1 text-sm text-slate-600" data-testid="share-period">
	{r.params.from} to {r.params.to}{r.params.departmentName ? ` · ${r.params.departmentName}` : ''} · available until {data
		.share.expiresOn}
</p>
<div class="mt-4 flex gap-3 text-sm">
	<a class="text-indigo-700 underline" href={`${base}?format=csv`}>Download CSV</a>
	<a class="text-indigo-700 underline" href={`${base}?format=pdf`}>Download PDF</a>
</div>
<ReportTables sections={r.sections} />
