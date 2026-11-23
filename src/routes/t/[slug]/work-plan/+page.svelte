<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import Field from '#lib/components/ui/Field.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const p = $derived(data.plan);
	const input = 'mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm';
	const statuses = [
		['pending', 'Pending'],
		['in_progress', 'In progress'],
		['done', 'Done']
	] as const;
</script>

<svelte:head><title>Work plan · {data.tenant.name}</title></svelte:head>

<h1 class="text-2xl font-semibold text-slate-900">Work plan · week of {p.week}</h1>
<nav class="mt-2 flex gap-3 text-sm" aria-label="Weeks">
	<a class="text-indigo-700 underline" href={`?week=${p.previous}`}>Previous week</a>
	{#if p.week !== p.current}<a class="text-indigo-700 underline" href="?">This week</a>{/if}
	<a class="text-indigo-700 underline" href={`?week=${p.next}`}>Next week</a>
</nav>

<div class="mt-4 max-w-4xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'done' in form}<Alert tone="info" message={form.done} />{/if}
</div>

{#if p.canPlan}
	<section class="mt-4 max-w-4xl rounded-xl bg-white p-6 ring-1 ring-slate-200" aria-label="Add item">
		<h2 class="font-semibold text-slate-900">Add item</h2>
		<form method="POST" action="?/add" class="mt-3 grid gap-3 sm:grid-cols-3">
			<input type="hidden" name="weekStart" value={p.week} />
			<label class="block text-sm font-medium text-slate-700">
				Owner
				<select name="employeeId" required class={input}>
					{#each p.people as e (e.id)}<option value={e.id} selected={e.id === p.me}>{e.name}</option>{/each}
				</select>
			</label>
			<Field label="Item" name="description" required maxlength={300} />
			<Field label="Target" name="target" maxlength={120} />
			<div><Button type="submit">Add item</Button></div>
		</form>
	</section>
{/if}

<section class="mt-6 max-w-4xl" aria-label="Items">
	{#if p.items.length}
		<ul class="space-y-2">
			{#each p.items as i (i.id)}
				<li class="rounded-xl bg-white p-4 text-sm ring-1 ring-slate-200" data-testid="work-item">
					<p class="font-medium text-slate-900">
						{i.description}{i.target ? ` · target ${i.target}` : ''}{i.carried ? ' · carried over' : ''}
					</p>
					<p class="text-slate-600">{i.name}</p>
					<div class="mt-2 flex flex-wrap items-end gap-2">
						<form method="POST" action="?/status" class="flex items-end gap-2">
							<input type="hidden" name="itemId" value={i.id} />
							<label class="block text-sm font-medium text-slate-700">
								Status of {i.description}
								<select name="status" class={input}>
									{#each statuses as [value, label] (value)}
										<option {value} selected={i.status === value}>{label}</option>
									{/each}
								</select>
							</label>
							<Button type="submit" variant="secondary">Update {i.description}</Button>
						</form>
						<form method="POST" action="?/remove">
							<input type="hidden" name="itemId" value={i.id} />
							<Button type="submit" variant="secondary">Remove {i.description}</Button>
						</form>
					</div>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="text-sm text-slate-600">Nothing planned for this week.</p>
	{/if}
</section>

{#if p.canRoll}
	<form method="POST" action="?/rollover" class="mt-6">
		<input type="hidden" name="weekStart" value={p.week} />
		<Button type="submit">Carry unfinished items to next week</Button>
	</form>
{/if}
