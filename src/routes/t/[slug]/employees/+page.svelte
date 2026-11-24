<script lang="ts">
	import Badge from '#lib/components/ui/Badge.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const f = $derived(data.filters);
	const pageHref = (p: number) => {
		const q = new URLSearchParams({
			q: f.q,
			department: f.department,
			status: f.status,
			sort: f.sort,
			page: String(p)
		});
		return `?${q}`;
	};
	const input = 'input';
</script>

<svelte:head><title>Employees · {data.tenant.name}</title></svelte:head>

<div class="flex flex-wrap items-center gap-4">
	<h1 class="page-title">Employees</h1>
	<span class="text-sm text-slate-500" data-testid="employee-total">{data.total}</span>
	<a href="/t/{data.tenant.slug}/employees/export{pageHref(1)}" class="ml-auto text-sm text-brand-600 hover:underline">
		Export CSV
	</a>
	{#if data.canCreate}
		<a href="/t/{data.tenant.slug}/employees/import" class="text-sm text-brand-600 hover:underline">Import CSV</a>
		<a
			href="/t/{data.tenant.slug}/employees/new"
			class="rounded-lg bg-brand-600 px-3.5 py-1.5 text-sm font-medium text-white no-underline hover:bg-brand-700"
		>
			New employee
		</a>
	{/if}
</div>

<form method="GET" class="mt-4 flex flex-wrap items-end gap-3">
	<input name="q" value={f.q} placeholder="Name, code or email" aria-label="Search" maxlength={100} class={input} />
	<select name="department" aria-label="Department" class={input}>
		<option value="">All departments</option>
		{#each data.departments as d (d.id)}<option value={d.id} selected={d.id === f.department}>{d.name}</option>{/each}
	</select>
	<select name="status" aria-label="Status" class={input}>
		<option value="">Any status</option>
		{#each ['onboarding', 'probation', 'active', 'notice', 'exited'] as s (s)}<option
				value={s}
				selected={s === f.status}
			>
				{s}
			</option>{/each}
	</select>
	<select name="sort" aria-label="Sort" class={input}>
		<option value="name" selected={f.sort === 'name'}>Name</option>
		<option value="code" selected={f.sort === 'code'}>Code</option>
		<option value="joined" selected={f.sort === 'joined'}>Newest joiners</option>
	</select>
	<Button type="submit" variant="secondary">Filter</Button>
</form>

<div class="mt-6 overflow-x-auto rounded-xl bg-white ring-1 ring-slate-200">
	<table class="data-table">
		<thead class="bg-slate-50 text-left text-slate-600">
			<tr>
				<th class="px-4 py-2 font-medium">Code</th>
				<th class="px-4 py-2 font-medium">Name</th>
				<th class="px-4 py-2 font-medium">Department</th>
				<th class="px-4 py-2 font-medium">Designation</th>
				<th class="px-4 py-2 font-medium">Status</th>
			</tr>
		</thead>
		<tbody class="divide-y divide-slate-100">
			{#each data.rows as e (e.id)}
				<tr>
					<td class="px-4 py-2 font-mono text-xs">{e.code}</td>
					<td class="px-4 py-2">
						<a href="/t/{data.tenant.slug}/employees/{e.id}" class="text-brand-700 hover:underline">{e.fullName}</a>
					</td>
					<td class="px-4 py-2">{e.department ?? ''}</td>
					<td class="px-4 py-2">{e.designation ?? ''}</td>
					<td class="px-4 py-2"><Badge status={e.status} /></td>
				</tr>
			{:else}
				<tr><td colspan="5" class="px-4 py-6 text-center text-slate-500">No employees found.</td></tr>
			{/each}
		</tbody>
	</table>
</div>

{#if data.pages > 1}
	<nav aria-label="Pages" class="mt-4 flex items-center gap-4 text-sm">
		{#if f.page > 1}<a href={pageHref(f.page - 1)} class="text-brand-600 hover:underline">Previous</a>{/if}
		<span>Page {f.page} of {data.pages}</span>
		{#if f.page < data.pages}<a href={pageHref(f.page + 1)} class="text-brand-600 hover:underline">Next</a>{/if}
	</nav>
{/if}
