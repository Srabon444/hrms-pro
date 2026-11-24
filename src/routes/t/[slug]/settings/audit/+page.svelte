<script lang="ts">
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const older = $derived(
		data.next ? `?${new URLSearchParams({ ...(data.table ? { table: data.table } : {}), before: data.next })}` : null
	);
</script>

<svelte:head><title>Audit log · {data.tenant.name}</title></svelte:head>

<h1 class="page-title">Audit log</h1>

<form method="GET" class="mt-4 flex flex-wrap items-end gap-3">
	<label class="text-sm text-slate-700">
		Record type
		<select name="table" class="mt-1 block rounded-md border-slate-300 text-sm">
			<option value="">All</option>
			{#each data.tables as t (t)}<option value={t} selected={t === data.table}>{t}</option>{/each}
		</select>
	</label>
	<Button type="submit" variant="secondary">Filter</Button>
</form>

{#if data.entries.length === 0}
	<p class="mt-6 text-sm text-slate-600">No changes recorded.</p>
{:else}
	<div class="mt-6 overflow-x-auto rounded-xl bg-white ring-1 ring-slate-200">
		<table class="data-table">
			<thead class="bg-slate-50 text-left text-slate-600">
				<tr>
					<th class="px-4 py-2 font-medium">When</th>
					<th class="px-4 py-2 font-medium">Who</th>
					<th class="px-4 py-2 font-medium">What</th>
					<th class="px-4 py-2 font-medium">Changes</th>
				</tr>
			</thead>
			<tbody class="divide-y divide-slate-100">
				{#each data.entries as e (e.id)}
					<tr data-testid="audit-entry" class="align-top">
						<td class="px-4 py-2 whitespace-nowrap text-slate-600">{e.at.toLocaleString()}</td>
						<td class="px-4 py-2">{e.actor}</td>
						<td class="px-4 py-2 font-mono text-xs">{e.event ?? `${e.op} ${e.table}`}</td>
						<td class="px-4 py-2">
							<ul class="space-y-0.5 font-mono text-xs">
								{#each e.changes as c (c.column)}
									<li><span class="text-slate-500">{c.column}:</span> {c.before} → {c.after}</li>
								{/each}
							</ul>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
	{#if older}<a href={older} class="mt-4 inline-block text-sm text-brand-600 hover:underline">Older entries</a>{/if}
{/if}
