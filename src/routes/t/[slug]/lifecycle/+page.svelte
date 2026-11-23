<script lang="ts">
	import TaskList from '#lib/components/TaskList.svelte';
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const input = 'rounded-md border border-slate-300 px-2 py-1 text-sm';
	const saved = $derived(form && 'probationSaved' in form ? form.probationSaved : null);
</script>

<svelte:head><title>Lifecycle · {data.tenant.name}</title></svelte:head>

<h1 class="text-2xl font-semibold text-slate-900">Lifecycle</h1>

<div class="mt-4 max-w-4xl space-y-2">
	<Alert message={form?.message} />
	{#if saved === 'confirm'}<Alert tone="info" message="Employment confirmed." />{/if}
	{#if saved === 'extend'}<Alert tone="info" message="Probation extended." />{/if}
	{#if form && 'taskSaved' in form}<Alert tone="info" message="Task done." />{/if}
</div>

<section class="mt-6 max-w-4xl rounded-xl bg-white p-6 ring-1 ring-slate-200" aria-label="Probation due">
	<h2 class="font-semibold text-slate-900">Probation ending within 30 days</h2>
	<ul class="mt-3 divide-y divide-slate-100 text-sm">
		{#each data.probation.rows as p (p.id)}
			<li class="flex flex-wrap items-center gap-3 py-3" data-testid="probation-row">
				<a href="/t/{data.tenant.slug}/employees/{p.id}" class="font-medium text-indigo-700 hover:underline">
					{p.fullName}
				</a>
				<span class="text-slate-500">{p.code} · ends {p.probationEndDate}</span>
				{#if p.overdue}<span class="rounded bg-amber-100 px-2 text-amber-800">overdue</span>{/if}
				<form method="POST" action="?/probation" class="ml-auto flex items-center gap-2">
					<input type="hidden" name="employeeId" value={p.id} />
					<input type="hidden" name="decision" value="confirm" />
					<input
						name="date"
						type="date"
						value={data.probation.today}
						required
						aria-label="Confirm {p.fullName} on"
						class={input}
					/>
					<Button type="submit">Confirm</Button>
				</form>
				<form method="POST" action="?/probation" class="flex items-center gap-2">
					<input type="hidden" name="employeeId" value={p.id} />
					<input type="hidden" name="decision" value="extend" />
					<input name="date" type="date" required aria-label="Extend {p.fullName} to" class={input} />
					<Button type="submit" variant="secondary">Extend</Button>
				</form>
			</li>
		{:else}
			<li class="py-2 text-slate-500">Nobody's probation ends soon.</li>
		{/each}
	</ul>
</section>

<section class="mt-6 max-w-4xl rounded-xl bg-white p-6 ring-1 ring-slate-200" aria-label="Upcoming exits">
	<h2 class="font-semibold text-slate-900">Upcoming exits</h2>
	<ul class="mt-3 divide-y divide-slate-100 text-sm">
		{#each data.exits as x (x.id)}
			<li class="flex gap-3 py-2" data-testid="exit-row">
				<a href="/t/{data.tenant.slug}/employees/{x.id}" class="font-medium text-indigo-700 hover:underline">
					{x.fullName}
				</a>
				<span class="text-slate-500">{x.code} · last day {x.exitDate} · {x.exitType ?? ''}</span>
			</li>
		{:else}
			<li class="py-2 text-slate-500">Nobody is on notice.</li>
		{/each}
	</ul>
</section>

<section class="mt-6 max-w-4xl rounded-xl bg-white p-6 ring-1 ring-slate-200" aria-label="Checklist tasks">
	<h2 class="font-semibold text-slate-900">Open checklist tasks</h2>
	<TaskList tasks={data.tasks} slug={data.tenant.slug} roleNames={data.roleNames} action="?/task" />
</section>
