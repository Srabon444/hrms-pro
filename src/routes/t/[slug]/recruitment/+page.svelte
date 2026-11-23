<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import Field from '#lib/components/ui/Field.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const input = 'mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm';
	const statusLabel: Record<string, string> = { open: 'Open', on_hold: 'On hold', closed: 'Closed' };
</script>

<svelte:head><title>Recruitment · {data.tenant.name}</title></svelte:head>

<h1 class="text-2xl font-semibold text-slate-900">Recruitment</h1>

<div class="mt-4 max-w-4xl">
	<Alert message={form?.message} />
</div>

{#if data.canManage}
	<section class="mt-4 max-w-4xl rounded-xl bg-white p-6 ring-1 ring-slate-200" aria-label="New opening">
		<h2 class="font-semibold text-slate-900">New opening</h2>
		<form method="POST" action="?/open" class="mt-3 grid gap-3 sm:grid-cols-2">
			<Field label="Job title" name="title" required maxlength={120} />
			<Field label="Headcount" name="headcount" type="number" min="1" max="500" step="1" value="1" required />
			<label class="block text-sm font-medium text-slate-700">
				Department
				<select name="departmentId" class={input}>
					<option value="">None</option>
					{#each data.board.departments as d (d.id)}<option value={d.id}>{d.name}</option>{/each}
				</select>
			</label>
			<label class="block text-sm font-medium text-slate-700">
				Designation
				<select name="designationId" class={input}>
					<option value="">None</option>
					{#each data.board.designations as d (d.id)}<option value={d.id}>{d.name}</option>{/each}
				</select>
			</label>
			<label class="block text-sm font-medium text-slate-700 sm:col-span-2">
				Description
				<textarea name="description" rows="4" maxlength="5000" class={input}></textarea>
			</label>
			<div><Button type="submit">Open position</Button></div>
		</form>
	</section>
{/if}

<section class="mt-6 max-w-4xl" aria-label="Openings">
	{#if data.board.openings.length}
		<table class="w-full text-left text-sm">
			<thead class="text-slate-500">
				<tr><th class="py-2">Opening</th><th>Department</th><th>Headcount</th><th>In pipeline</th><th>Status</th></tr>
			</thead>
			<tbody>
				{#each data.board.openings as o (o.id)}
					<tr class="border-t border-slate-100">
						<td class="py-2">
							<a class="text-indigo-700 underline" href={`/t/${data.tenant.slug}/recruitment/${o.id}`}>{o.title}</a>
						</td>
						<td>{o.department ?? '—'}</td>
						<td>{o.headcount}</td>
						<td>{o.active} of {o.total}</td>
						<td>{statusLabel[o.status]}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{:else}
		<p class="text-sm text-slate-600">No openings yet.</p>
	{/if}
</section>
