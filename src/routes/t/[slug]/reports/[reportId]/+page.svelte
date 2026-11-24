<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import ReportTables from '#lib/components/ReportTables.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const r = $derived(data.report);
	const people = $derived.by(() => {
		const seen: Record<string, string> = {};
		for (const s of r?.sections ?? [])
			for (const row of s.rows) if (row.employeeId) seen[row.employeeId] = String(row.cells.name ?? row.employeeId);
		return Object.entries(seen)
			.map(([id, name]) => ({ id, name }))
			.sort((a, b) => a.name.localeCompare(b.name));
	});
	const query = $derived(
		r
			? new URLSearchParams({
					from: r.params.from,
					to: r.params.to,
					department: r.params.departmentId ?? ''
				}).toString()
			: ''
	);
	const field = 'mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm';
</script>

<svelte:head><title>{r?.title ?? 'Report'} · {data.tenant.name}</title></svelte:head>

<a class="text-sm text-indigo-700 underline" href={`/t/${data.tenant.slug}/reports`}>All reports</a>
<h1 class="mt-2 text-2xl font-semibold text-slate-900">{r?.title ?? 'Report'}</h1>

<form method="GET" class="mt-4 grid max-w-3xl items-end gap-3 sm:grid-cols-4" aria-label="Filters">
	<label class="block text-sm font-medium text-slate-700">
		From
		<input name="from" type="date" value={r?.params.from ?? data.filters.from ?? ''} class={field} />
	</label>
	<label class="block text-sm font-medium text-slate-700">
		To
		<input name="to" type="date" value={r?.params.to ?? data.filters.to ?? ''} class={field} />
	</label>
	<label class="block text-sm font-medium text-slate-700">
		Department
		<select name="department" class={field}>
			<option value="">All departments</option>
			{#each data.departments as d (d.id)}
				<option value={d.id} selected={d.id === (r?.params.departmentId ?? data.filters.department)}>{d.name}</option>
			{/each}
		</select>
	</label>
	<div><Button type="submit" variant="secondary">Show</Button></div>
</form>

<div class="mt-4 max-w-3xl"><Alert message={form?.message ?? data.message} /></div>

{#if r}
	<div class="mt-4 flex gap-3 text-sm">
		<a class="text-indigo-700 underline" href={`/t/${data.tenant.slug}/reports/${r.id}/export?format=csv&${query}`}>
			Download CSV
		</a>
		<a class="text-indigo-700 underline" href={`/t/${data.tenant.slug}/reports/${r.id}/export?format=pdf&${query}`}>
			Download PDF
		</a>
	</div>
	<ReportTables sections={r.sections} />

	<details class="mt-8 max-w-3xl rounded-xl bg-white p-6 ring-1 ring-slate-200">
		<summary class="cursor-pointer font-semibold text-slate-900">Share this report</summary>
		{#if data.recipients.length}
			<form method="POST" action={`?${query}&/share`} class="mt-4 grid gap-4" aria-label="Share this report">
				<input type="hidden" name="from" value={r.params.from} />
				<input type="hidden" name="to" value={r.params.to} />
				<input type="hidden" name="department" value={r.params.departmentId ?? ''} />
				<fieldset>
					<legend class="text-sm font-medium text-slate-700">What to include</legend>
					{#each r.sections as s (s.key)}
						<div class="mt-2">
							<label class="text-sm font-medium">
								<input type="checkbox" name="sections" value={s.key} checked />
								{s.title}
							</label>
							<div class="mt-1 ml-6 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-700">
								{#each s.columns as c (c.key)}
									<label><input type="checkbox" name="columns" value={`${s.key}:${c.key}`} checked /> {c.label}</label>
								{/each}
							</div>
						</div>
					{/each}
				</fieldset>
				{#if people.length}
					<fieldset>
						<legend class="text-sm font-medium text-slate-700">
							Only these employees (leave all unticked for everyone)
						</legend>
						<div class="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-700">
							{#each people as p (p.id)}
								<label><input type="checkbox" name="employees" value={p.id} /> {p.name}</label>
							{/each}
						</div>
					</fieldset>
				{/if}
				<fieldset>
					<legend class="text-sm font-medium text-slate-700">Share with</legend>
					<div class="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-700">
						{#each data.recipients as p (p.membershipId)}
							<label><input type="checkbox" name="recipients" value={p.membershipId} /> {p.name}</label>
						{/each}
					</div>
				</fieldset>
				<div><Button type="submit">Share</Button></div>
			</form>
		{:else}
			<p class="mt-3 text-sm text-slate-600">Nobody else can see this report with at least your reach.</p>
		{/if}
	</details>
{/if}
