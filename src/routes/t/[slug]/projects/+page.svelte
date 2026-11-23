<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import Field from '#lib/components/ui/Field.svelte';
	import { PROJECT_STATUS_LABELS } from '#lib/project-labels.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const base = $derived(`/t/${data.tenant.slug}/projects`);
	const values = $derived((form && 'values' in form ? form.values : {}) as Record<string, string>);
</script>

<svelte:head><title>Projects · {data.tenant.name}</title></svelte:head>

<h1 class="text-2xl font-semibold text-slate-900">Projects</h1>

<div class="mt-4 max-w-4xl">
	<Alert message={form?.message} />
</div>

{#if data.canManage}
	<section class="mt-4 max-w-4xl rounded-xl bg-white p-6 ring-1 ring-slate-200" aria-label="New project">
		<h2 class="font-semibold text-slate-900">New project</h2>
		<form method="POST" action="?/save" class="mt-3 grid gap-3 sm:grid-cols-3">
			<Field
				label="Code"
				name="code"
				required
				maxlength={12}
				pattern={'[A-Za-z0-9][A-Za-z0-9\\-]{1,11}'}
				value={values.code ?? ''}
			/>
			<Field label="Name" name="name" required maxlength={120} value={values.name ?? ''} />
			<Field label="Client" name="client" maxlength={120} value={values.client ?? ''} />
			<label class="flex items-center gap-2 text-sm">
				<input type="checkbox" name="billable" checked={form ? values.billable === 'on' : true} /> Billable
			</label>
			<div><Button type="submit">Create project</Button></div>
		</form>
	</section>
{/if}

<section class="mt-6 max-w-4xl" aria-label="Project list">
	{#if data.projects.length}
		<table class="w-full text-left text-sm">
			<thead class="text-slate-500">
				<tr><th class="py-2">Code</th><th>Name</th><th>Client</th><th>Status</th><th>People</th></tr>
			</thead>
			<tbody>
				{#each data.projects as p (p.id)}
					<tr class="border-t border-slate-200" data-testid="project">
						<td class="py-2"><a class="text-indigo-700 underline" href={`${base}/${p.id}`}>{p.code}</a></td>
						<td>{p.name}</td>
						<td>{p.client || '—'}</td>
						<td>{PROJECT_STATUS_LABELS[p.status]}{p.billable ? '' : ' · non-billable'}</td>
						<td>{p.members}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{:else}
		<p class="text-sm text-slate-600">No projects yet.</p>
	{/if}
</section>
