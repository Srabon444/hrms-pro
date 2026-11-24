<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import Field from '#lib/components/ui/Field.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<svelte:head><title>{data.role.name} · Roles</title></svelte:head>

<a href="/t/{data.tenant.slug}/settings/roles" class="text-sm text-brand-600 hover:underline">Back to roles</a>
<h1 class="page-title mt-2">{data.role.name}</h1>

<div class="mt-4 max-w-xl space-y-2">
	{#if data.reason}<Alert tone="info" message={data.reason} />{/if}
	<Alert message={form?.message} />
	{#if form && 'saved' in form}<Alert tone="info" message="Role saved." />{/if}
</div>

<form method="POST" action="?/save" class="mt-6 space-y-6">
	<div class="grid max-w-xl gap-4">
		<Field label="Role name" name="name" required maxlength={80} value={data.role.name} disabled={data.readOnly} />
		<Field
			label="Description"
			name="description"
			maxlength={300}
			value={data.role.description}
			disabled={data.readOnly}
		/>
	</div>
	<div class="overflow-x-auto rounded-xl bg-white ring-1 ring-slate-200">
		<table class="w-full text-left text-sm">
			<thead class="text-xs text-slate-500">
				<tr>
					<th class="px-2 py-2 font-medium sm:px-4">Permission</th>
					{#each data.scopes as s (s)}<th class="px-1 py-2 text-center font-medium capitalize sm:px-3">{s}</th>{/each}
				</tr>
			</thead>
			<tbody class="divide-y divide-slate-100">
				{#each data.rows as row (row.permission)}
					<tr>
						<td class="px-2 py-1.5 font-mono text-xs break-all text-slate-800 sm:px-4">
							{row.permission}
							{#if row.restricted}<span class="ml-1 font-sans text-amber-700">restricted</span>{/if}
						</td>
						{#each row.cells as c (c.scope)}
							<td class="px-1 py-1.5 text-center sm:px-3">
								<input
									type="checkbox"
									name="grant"
									value="{row.permission}:{c.scope}"
									checked={c.on}
									disabled={!c.editable}
									aria-label="{row.permission} {c.scope}"
								/>
								{#if c.on && !c.editable}<input type="hidden" name="grant" value="{row.permission}:{c.scope}" />{/if}
							</td>
						{/each}
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
	{#if !data.readOnly}<Button type="submit">Save role</Button>{/if}
</form>

{#if !data.readOnly && !data.role.isSystem}
	<form method="POST" action="?/delete" class="mt-6">
		<Button type="submit" variant="danger">Delete role</Button>
	</form>
{/if}
