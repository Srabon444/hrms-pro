<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const field = 'input';
	const roleName = $derived(Object.fromEntries(data.roles.map((r) => [r.key, r.name])));
	const when = (n: number, kind: string) => {
		const anchor = kind === 'onboarding' ? 'join date' : 'last day';
		if (n === 0) return `on the ${anchor}`;
		return `${Math.abs(n)} day${Math.abs(n) === 1 ? '' : 's'} ${n < 0 ? 'before' : 'after'} the ${anchor}`;
	};
</script>

<svelte:head><title>Checklists · {data.tenant.name}</title></svelte:head>

<h1 class="page-title">Checklists</h1>
<p class="mt-1 max-w-3xl text-sm text-slate-600">
	Active onboarding checklists start for every new joiner, and offboarding checklists for every leaver. Each task goes
	to the people holding its role.
</p>

<div class="mt-4 max-w-3xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'saved' in form}<Alert tone="info" message="Checklists saved." />{/if}
</div>

<form method="POST" action="?/create" class="mt-4 flex max-w-3xl flex-wrap items-end gap-3">
	<label class="text-sm text-slate-700">
		Type
		<select name="kind" class="{field} mt-1 block">
			{#each data.kinds as k (k)}<option value={k}>{k}</option>{/each}
		</select>
	</label>
	<label class="text-sm text-slate-700">
		Checklist name
		<input name="name" required maxlength={120} class="{field} mt-1 block" />
	</label>
	<Button type="submit">Create checklist</Button>
</form>

{#each data.templates as t (t.id)}
	<section class="mt-6 max-w-3xl panel" aria-label={t.name}>
		<div class="flex items-center justify-between gap-3">
			<h2 class="section-title">
				{t.name}
				<span class="ml-2 text-xs font-normal text-slate-500">{t.kind}{t.active ? '' : ' · inactive'}</span>
			</h2>
			<form method="POST" action="?/toggle">
				<input type="hidden" name="templateId" value={t.id} />
				<input type="hidden" name="active" value={String(!t.active)} />
				<Button type="submit" variant="secondary">{t.active ? 'Deactivate' : 'Activate'}</Button>
			</form>
		</div>
		<ul class="mt-3 divide-y divide-slate-100 text-sm">
			{#each t.items as i (i.id)}
				<li class="flex items-center justify-between gap-3 py-2" data-testid="template-item">
					<span>{i.title} · {roleName[i.assigneeRole] ?? i.assigneeRole} · {when(i.dueOffsetDays, t.kind)}</span>
					<form method="POST" action="?/removeItem">
						<input type="hidden" name="templateId" value={t.id} />
						<input type="hidden" name="itemId" value={i.id} />
						<button type="submit" class="text-red-600 hover:underline" aria-label="Remove {i.title}">Remove</button>
					</form>
				</li>
			{:else}
				<li class="py-2 text-slate-500">No tasks yet.</li>
			{/each}
		</ul>
		<form method="POST" action="?/addItem" class="mt-3 flex flex-wrap items-end gap-3">
			<input type="hidden" name="templateId" value={t.id} />
			<label class="text-sm text-slate-700">
				Task
				<input name="title" required maxlength={200} class="{field} mt-1 block" />
			</label>
			<label class="text-sm text-slate-700">
				Done by
				<select name="assigneeRole" class="{field} mt-1 block">
					{#each data.roles as r (r.key)}<option value={r.key}>{r.name}</option>{/each}
				</select>
			</label>
			<label class="text-sm text-slate-700">
				Due (days after start, negative for before)
				<input
					name="dueOffsetDays"
					type="number"
					required
					min={-90}
					max={365}
					value={0}
					class="{field} mt-1 block w-28"
				/>
			</label>
			<Button type="submit">Add task</Button>
		</form>
	</section>
{/each}
