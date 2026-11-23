<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<svelte:head><title>{data.member.name} · Users</title></svelte:head>

<a href="../users" class="text-sm text-indigo-600 hover:underline">Back to users</a>
<h1 class="mt-2 text-2xl font-semibold text-slate-900">{data.member.name}</h1>
<p class="text-sm text-slate-600">{data.member.email} · {data.member.status}</p>

<div class="mt-4 max-w-xl">
	<Alert message={form && 'message' in form ? form.message : null} />
	{#if form && 'saved' in form}<Alert tone="info" message={form.saved} />{/if}
</div>

<section class="mt-6 max-w-xl rounded-xl bg-white p-6 ring-1 ring-slate-200">
	<h2 class="font-semibold text-slate-900">Roles</h2>
	<p class="mt-1 text-sm text-slate-600">Everyone is also an Employee. Roles you cannot grant are shown greyed out.</p>
	<form method="POST" action="?/roles" class="mt-4 space-y-4">
		<div class="grid grid-cols-2 gap-2">
			{#each data.roles as r (r.id)}
				<label class={['flex items-center gap-2 text-sm', r.editable ? 'text-slate-700' : 'text-slate-400']}>
					<input type="checkbox" name="roleId" value={r.id} checked={r.held} disabled={!r.editable} />
					{r.name}
				</label>
				{#if !r.editable && r.held}<input type="hidden" name="roleId" value={r.id} />{/if}
			{/each}
		</div>
		<Button type="submit">Save roles</Button>
	</form>
</section>

{#if data.member.status !== 'ex_employee'}
	<section class="mt-6 max-w-xl rounded-xl bg-white p-6 ring-1 ring-slate-200">
		<h2 class="font-semibold text-slate-900">Access</h2>
		<form method="POST" action="?/status" class="mt-4">
			{#if data.member.status === 'active'}
				<input type="hidden" name="status" value="disabled" />
				<Button type="submit" variant="danger">Disable access</Button>
			{:else}
				<input type="hidden" name="status" value="active" />
				<Button type="submit">Restore access</Button>
			{/if}
		</form>
	</section>
{/if}
