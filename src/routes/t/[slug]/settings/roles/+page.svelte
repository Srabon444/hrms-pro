<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import Field from '#lib/components/ui/Field.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<svelte:head><title>Roles · {data.tenant.name}</title></svelte:head>

<h1 class="text-2xl font-semibold text-slate-900">Roles</h1>

<ul class="mt-6 divide-y divide-slate-200 rounded-xl bg-white ring-1 ring-slate-200">
	{#each data.roles as r (r.id)}
		<li class="flex items-start gap-4 p-4">
			<div class="flex-1">
				<a href="/t/{data.tenant.slug}/settings/roles/{r.id}" class="font-medium text-indigo-700 hover:underline">
					{r.name}
				</a>
				{#if r.isSystem}<span class="ml-2 text-xs text-slate-500">built-in</span>{/if}
				{#if r.description}<p class="text-sm text-slate-600">{r.description}</p>{/if}
			</div>
			<span class="text-sm text-slate-500">{r.members} member{r.members === 1 ? '' : 's'}</span>
		</li>
	{/each}
</ul>

<section class="mt-8 max-w-xl rounded-xl bg-white p-6 ring-1 ring-slate-200">
	<h2 class="font-semibold text-slate-900">New role</h2>
	<form method="POST" action="?/create" class="mt-4 space-y-4">
		<Field label="Role name" name="name" required maxlength={80} value={form && 'name' in form ? form.name : ''} />
		<Field label="Description" name="description" maxlength={300} />
		<Button type="submit">Create role</Button>
		<Alert message={form?.message} />
	</form>
</section>
