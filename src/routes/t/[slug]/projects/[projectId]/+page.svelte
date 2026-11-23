<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import Field from '#lib/components/ui/Field.svelte';
	import { PROJECT_ROLE_LABELS, PROJECT_STATUS_LABELS } from '#lib/project-labels.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const v = $derived(data.view);
	const p = $derived(v.project);
	const input = 'mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm';
	const onTeam = $derived(new Set(v.members.map((x) => x.employeeId)));
</script>

<svelte:head><title>{p.code} · Projects · {data.tenant.name}</title></svelte:head>

<a class="text-sm text-indigo-700 underline" href={`/t/${data.tenant.slug}/projects`}>Projects</a>
<h1 class="mt-2 text-2xl font-semibold text-slate-900">{p.code} · {p.name}</h1>
<p class="text-sm text-slate-600">
	{PROJECT_STATUS_LABELS[p.status]}{p.client ? ` · ${p.client}` : ''} · {p.billable ? 'Billable' : 'Non-billable'}
</p>

<div class="mt-4 max-w-4xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'done' in form}<Alert tone="info" message={form.done} />{/if}
</div>

{#if v.canManage}
	<section class="mt-4 max-w-4xl rounded-xl bg-white p-6 ring-1 ring-slate-200" aria-label="Edit project">
		<h2 class="font-semibold text-slate-900">Edit project</h2>
		<form method="POST" action="?/save" class="mt-3 grid gap-3 sm:grid-cols-3">
			<Field
				label="Code"
				name="code"
				required
				maxlength={12}
				pattern={'[A-Za-z0-9][A-Za-z0-9\\-]{1,11}'}
				value={p.code}
			/>
			<Field label="Name" name="name" required maxlength={120} value={p.name} />
			<Field label="Client" name="client" maxlength={120} value={p.client ?? ''} />
			<label class="block text-sm font-medium text-slate-700">
				Status
				<select name="status" class={input}>
					{#each Object.entries(PROJECT_STATUS_LABELS) as [value, label] (value)}
						<option {value} selected={p.status === value}>{label}</option>
					{/each}
				</select>
			</label>
			<label class="flex items-center gap-2 text-sm">
				<input type="checkbox" name="billable" checked={p.billable} /> Billable
			</label>
			<div><Button type="submit">Save project</Button></div>
		</form>
	</section>
{/if}

<section class="mt-6 max-w-4xl" aria-label="Team">
	<h2 class="font-semibold text-slate-900">Team</h2>
	{#if v.members.length}
		<ul class="mt-2 space-y-2 text-sm">
			{#each v.members as x (x.employeeId)}
				<li class="flex items-center gap-3" data-testid="project-member">
					<span>{x.name} · {PROJECT_ROLE_LABELS[x.role]} · {x.allocation}%</span>
					{#if v.canManage}
						<form method="POST" action="?/remove">
							<input type="hidden" name="employeeId" value={x.employeeId} />
							<Button type="submit" variant="secondary">Remove {x.name}</Button>
						</form>
					{/if}
				</li>
			{/each}
		</ul>
	{:else}
		<p class="mt-2 text-sm text-slate-600">Nobody is on this project yet.</p>
	{/if}
</section>

{#if v.canManage && p.status !== 'closed'}
	<section class="mt-6 max-w-4xl rounded-xl bg-white p-6 ring-1 ring-slate-200" aria-label="Add to team">
		<h2 class="font-semibold text-slate-900">Add or change a team member</h2>
		<form method="POST" action="?/member" class="mt-3 grid gap-3 sm:grid-cols-4">
			<label class="block text-sm font-medium text-slate-700">
				Employee
				<select name="employeeId" required class={input}>
					{#each v.people as e (e.id)}<option value={e.id}>
							{e.name}{onTeam.has(e.id) ? ' (on team)' : ''}
						</option>{/each}
				</select>
			</label>
			<label class="block text-sm font-medium text-slate-700">
				Role
				<select name="role" class={input}>
					{#each Object.entries(PROJECT_ROLE_LABELS) as [value, label] (value)}<option {value}>{label}</option>{/each}
				</select>
			</label>
			<Field label="Allocation (%)" name="allocation" type="number" min="1" max="100" step="1" value="100" required />
			<div><Button type="submit">Save member</Button></div>
		</form>
	</section>
{/if}
