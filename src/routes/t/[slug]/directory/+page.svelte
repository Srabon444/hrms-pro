<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import { dayMonth } from '#lib/day-month.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const f = $derived(data.filters);
	const pageHref = (p: number) => `?${new URLSearchParams({ q: f.q, page: String(p) })}`;
</script>

<svelte:head><title>Directory · {data.tenant.name}</title></svelte:head>

<div class="flex flex-wrap items-center gap-4">
	<h1 class="page-title">Directory</h1>
	<span class="text-sm text-slate-500" data-testid="directory-total">{data.total}</span>
	<a href="/t/{data.tenant.slug}/directory/chart" class="ml-auto text-sm text-brand-600 hover:underline">Org chart</a>
</div>

<form method="GET" class="mt-4 flex flex-wrap items-end gap-3">
	<input
		name="q"
		value={f.q}
		placeholder="Name, designation or department"
		aria-label="Search the directory"
		maxlength={100}
		class="input"
	/>
	<Button type="submit" variant="secondary">Search</Button>
</form>

{#if data.showBirthday !== null}
	<form method="POST" action="?/birthday" class="mt-4 flex flex-wrap items-center gap-3 text-sm">
		<Alert message={form && 'message' in form ? form.message : undefined} />
		<label class="flex items-center gap-2">
			<input type="checkbox" name="show" checked={data.showBirthday} />
			Show my birthday (day and month) to colleagues
		</label>
		<Button type="submit" variant="secondary">Save</Button>
		{#if form && 'saved' in form}<span role="status" class="text-slate-600">Saved.</span>{/if}
	</form>
{/if}

<div class="mt-6 overflow-x-auto rounded-xl bg-white ring-1 ring-slate-200">
	<table class="data-table">
		<thead class="bg-slate-50 text-left text-slate-600">
			<tr>
				<th class="px-4 py-2 font-medium">Name</th>
				<th class="px-4 py-2 font-medium">Designation</th>
				<th class="px-4 py-2 font-medium">Department</th>
				<th class="px-4 py-2 font-medium">Branch</th>
				<th class="px-4 py-2 font-medium">Manager</th>
				<th class="px-4 py-2 font-medium">Joined</th>
				<th class="px-4 py-2 font-medium">Work email</th>
				{#if data.birthdays}<th class="px-4 py-2 font-medium">Birthday</th>{/if}
			</tr>
		</thead>
		<tbody class="divide-y divide-slate-100">
			{#each data.rows as e (e.id)}
				<tr>
					<td class="px-4 py-2">
						{#if e.canOpen}
							<a href="/t/{data.tenant.slug}/employees/{e.id}" class="text-brand-700 hover:underline">{e.name}</a>
						{:else}{e.name}{/if}
					</td>
					<td class="px-4 py-2">{e.designation ?? ''}</td>
					<td class="px-4 py-2">{e.department ?? ''}</td>
					<td class="px-4 py-2">{e.branch ?? ''}</td>
					<td class="px-4 py-2">{e.manager ?? ''}</td>
					<td class="px-4 py-2">{e.joinDate}</td>
					<td class="px-4 py-2">
						{#if e.workEmail}<a href="mailto:{e.workEmail}" class="text-brand-700 hover:underline">
								{e.workEmail}
							</a>{/if}
					</td>
					{#if data.birthdays}<td class="px-4 py-2">{e.birthday ? dayMonth(e.birthday) : ''}</td>{/if}
				</tr>
			{:else}
				<tr><td colspan="8" class="px-4 py-6 text-center text-slate-500">Nobody matches that search.</td></tr>
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
