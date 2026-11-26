<script lang="ts">
	import UnitNode from './UnitNode.svelte';
	import { more, type Node, type Unit } from './tree';

	let { unit, base }: { unit: Unit; base: string } = $props();
	let open = $state(false);
	let level = $state<{ departments: Unit[]; people: Node[] } | null>(null);
	let failed = $state(false);

	async function toggle() {
		if (!open && !level) {
			const res = await fetch(`${base}/nodes?dept=${unit.id}`);
			failed = !res.ok;
			if (failed) return;
			level = await res.json();
		}
		open = !open;
	}
</script>

<li class="mt-1">
	<div class="flex items-center gap-2">
		{#if unit.people || unit.subDepartments}
			<button
				type="button"
				class="w-6 rounded text-slate-500 hover:bg-slate-100"
				aria-expanded={open}
				aria-label="{open ? 'Hide' : 'Show'} {unit.name}"
				onclick={toggle}
			>
				{open ? '−' : '+'}
			</button>
		{:else}<span class="w-6"></span>{/if}
		<span class="font-medium">{unit.name}</span>
		<span class="text-xs text-slate-400">{unit.people} people</span>
		{#if failed}<span role="alert" class="text-xs text-red-600">Could not load. Try again.</span>{/if}
	</div>
	{#if open && level}
		<ul class="ml-6 border-l border-slate-200 pl-3">
			{#each level.departments as d (d.id)}<UnitNode unit={d} {base} />{/each}
			{#each level.people as p (p.id)}
				<li class="mt-1 flex items-center gap-2 pl-8">
					<span>{p.name}</span>
					{#if p.designation}<span class="text-sm text-slate-500">{p.designation}</span>{/if}
				</li>
			{/each}
			{#if level.people.length < (level.people[0]?.siblings ?? 0)}
				<li class="mt-1 pl-8 text-xs text-slate-500">{more(level.people.length, level.people[0].siblings)}</li>
			{/if}
		</ul>
	{/if}
</li>
