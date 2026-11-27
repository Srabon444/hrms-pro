<script lang="ts">
	import Badge from '#lib/components/ui/Badge.svelte';
	import AiAssist from '#lib/components/AiAssist.svelte';
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import Field from '#lib/components/ui/Field.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const input = 'mt-1 block w-full input';
	const statusLabel: Record<string, string> = { open: 'Open', on_hold: 'On hold', closed: 'Closed' };
</script>

<svelte:head><title>Recruitment · {data.tenant.name}</title></svelte:head>

<h1 class="page-title">Recruitment</h1>

<div class="mt-4 max-w-4xl">
	<Alert message={form?.message} />
</div>

{#if data.canManage}
	<section class="mt-4 max-w-4xl panel" aria-label="New opening">
		<h2 class="section-title">New opening</h2>
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
			{#if data.ai.write}
				<div class="sm:col-span-2">
					<AiAssist
						url={`/t/${data.tenant.slug}/recruitment/draft`}
						label="Draft with AI"
						send={['title', 'departmentId', 'designationId']}
					/>
				</div>
			{/if}
			<div><Button type="submit">Open position</Button></div>
		</form>
	</section>
{/if}

<section class="mt-6 max-w-4xl" aria-label="Openings">
	{#if data.board.openings.length}
		<table class="data-table">
			<thead>
				<tr><th class="py-2">Opening</th><th>Department</th><th>Headcount</th><th>In pipeline</th><th>Status</th></tr>
			</thead>
			<tbody>
				{#each data.board.openings as o (o.id)}
					<tr class="border-t border-slate-100">
						<td class="py-2">
							<a class="text-brand-700 underline" href={`/t/${data.tenant.slug}/recruitment/${o.id}`}>{o.title}</a>
						</td>
						<td>{o.department ?? '—'}</td>
						<td>{o.headcount}</td>
						<td>{o.active} of {o.total}</td>
						<td><Badge status={o.status} label={statusLabel[o.status]} /></td>
					</tr>
				{/each}
			</tbody>
		</table>
	{:else}
		<p class="text-sm text-slate-600">No openings yet.</p>
	{/if}
</section>
