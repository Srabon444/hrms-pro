<script lang="ts">
	import TaskList from '#lib/components/TaskList.svelte';
	import Alert from '#lib/components/ui/Alert.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<svelte:head><title>Tasks · {data.tenant.name}</title></svelte:head>

<h1 class="text-2xl font-semibold text-slate-900">My tasks</h1>
<p class="mt-1 text-sm text-slate-600">Onboarding and offboarding tasks for your role, your team or yourself.</p>
<div class="mt-4 max-w-3xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'taskSaved' in form}<Alert tone="info" message="Task done." />{/if}
</div>
<section class="mt-4 max-w-3xl rounded-xl bg-white p-6 ring-1 ring-slate-200" aria-label="Open tasks">
	<TaskList tasks={data.tasks} slug={data.tenant.slug} roleNames={data.roleNames} action="?/task" />
</section>
