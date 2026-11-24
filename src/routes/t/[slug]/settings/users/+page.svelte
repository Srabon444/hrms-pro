<script lang="ts">
	import Badge from '#lib/components/ui/Badge.svelte';
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import Field from '#lib/components/ui/Field.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<svelte:head><title>Users · {data.tenant.name}</title></svelte:head>

<h1 class="page-title">Users</h1>

<section class="mt-6 max-w-xl panel">
	<h2 class="section-title">Invite someone</h2>
	<form method="POST" action="?/invite" class="mt-4 space-y-4">
		<Field label="Email" name="email" type="email" required value={form && 'email' in form ? form.email : ''} />
		{#if data.grantableRoles.length}
			<fieldset>
				<legend class="text-sm font-medium text-slate-700">Roles (everyone is also an Employee)</legend>
				<div class="mt-2 grid grid-cols-2 gap-2">
					{#each data.grantableRoles as r (r.id)}
						<label class="flex items-center gap-2 text-sm text-slate-700">
							<input type="checkbox" name="roleId" value={r.id} />
							{r.name}
						</label>
					{/each}
				</div>
			</fieldset>
		{/if}
		{#if data.employees.length}
			<label class="block text-sm font-medium text-slate-700">
				Employee record
				<select name="employeeId" class="mt-1 block w-full input">
					<option value="">Not linked</option>
					{#each data.employees as e (e.id)}<option value={e.id}>{e.name}</option>{/each}
				</select>
			</label>
		{/if}
		<Button type="submit">Send invitation</Button>
	</form>
	<div class="mt-4">
		<Alert message={form && 'message' in form ? form.message : null} />
		{#if form && 'invited' in form}<Alert tone="info" message="Invitation sent to {form.invited}." />{/if}
	</div>
</section>

{#if data.pending.length}
	<section class="mt-8">
		<h2 class="section-title">Pending invitations</h2>
		<ul class="mt-3 divide-y divide-slate-200 rounded-xl bg-white ring-1 ring-slate-200">
			{#each data.pending as inv (inv.id)}
				<li class="flex items-center gap-4 p-4 text-sm">
					<span class="flex-1">{inv.email}</span>
					<span class="text-slate-500">expires {inv.expiresAt.toLocaleDateString()}</span>
					<form method="POST" action="?/revoke">
						<input type="hidden" name="id" value={inv.id} />
						<button type="submit" class="text-red-600 hover:underline">Revoke</button>
					</form>
				</li>
			{/each}
		</ul>
	</section>
{/if}

<section class="mt-8 overflow-x-auto">
	<table class="data-table rounded-xl bg-white ring-1 ring-slate-200">
		<thead class="text-left text-slate-600">
			<tr>
				<th class="px-4 py-3 font-medium">Name</th>
				<th class="px-4 py-3 font-medium">Employee</th>
				<th class="px-4 py-3 font-medium">Roles</th>
				<th class="px-4 py-3 font-medium">Status</th>
				<th class="px-4 py-3 font-medium">2FA</th>
				<th class="px-4 py-3 font-medium">Last sign-in</th>
			</tr>
		</thead>
		<tbody class="divide-y divide-slate-100">
			{#each data.members as u (u.id)}
				<tr class="max-md:px-4">
					<td class="px-4 py-3">
						{#if u.self}
							<span class="font-medium text-slate-900">{u.name}</span> <span class="text-slate-500">(you)</span>
						{:else}
							<a href="users/{u.id}" class="font-medium text-brand-700 hover:underline">{u.name}</a>
						{/if}
						<div class="text-slate-500">{u.email}</div>
					</td>
					<td class="px-4 py-3 text-slate-700">{u.employee ?? ''}</td>
					<td class="px-4 py-3 text-slate-700">{u.roles.join(', ')}</td>
					<td class="px-4 py-3"><Badge status={u.status} /></td>
					<td class="px-4 py-3 text-slate-700">{u.totpEnabled ? 'On' : 'Off'}</td>
					<td class="px-4 py-3 text-slate-500">{u.lastLoginAt?.toLocaleString() ?? 'Never'}</td>
				</tr>
			{/each}
		</tbody>
	</table>
</section>
