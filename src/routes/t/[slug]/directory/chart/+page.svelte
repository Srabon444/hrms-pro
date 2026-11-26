<script lang="ts">
	import { tick } from 'svelte';
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import OrgNode from './OrgNode.svelte';
	import UnitNode from './UnitNode.svelte';
	import { group, more, type Node, type Tree } from './tree';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const base = $derived(`/t/${data.tenant.slug}/directory/chart`);
	const tree: Tree = $state({ kids: {}, open: {}, failed: null });
	let found = $state<Node | null>(null);
	const roots = $derived(
		data.people && found && !data.people.roots.some((r) => r.id === found!.id)
			? [...data.people.roots, found]
			: (data.people?.roots ?? [])
	);
	const rootTotal = $derived(data.people?.roots[0]?.siblings ?? 0);

	$effect.pre(() => {
		if (!data.people) return;
		const kids = group(data.people.children);
		tree.kids = kids;
		tree.open = Object.fromEntries(Object.keys(kids).map((id) => [id, true]));
	});

	async function findMe() {
		tree.failed = null;
		const res = await fetch(`${base}/nodes?path=me`);
		if (!res.ok) {
			tree.failed = 'Could not find your place in the chart.';
			return;
		}
		const path: { chain: string[]; top: Node | null; children: Node[] } = await res.json();
		if (!path.chain.length) {
			tree.failed = 'You are not linked to an employee record in the chart.';
			return;
		}
		found = path.top;
		Object.assign(tree.kids, group(path.children));
		for (const id of path.chain.slice(0, -1)) tree.open[id] = true;
		await tick();
		const mine = document.getElementById(`node-${path.chain.at(-1)}`);
		mine?.scrollIntoView({ block: 'center' });
		mine?.focus();
	}
</script>

<svelte:head><title>Org chart · {data.tenant.name}</title></svelte:head>

<div class="flex flex-wrap items-center gap-4">
	<h1 class="page-title">Org chart</h1>
	<nav aria-label="Chart view" class="flex gap-3 text-sm">
		<a
			href="?view=people"
			aria-current={data.view === 'people' ? 'page' : undefined}
			class="text-brand-600 hover:underline"
		>
			By manager
		</a>
		<a
			href="?view=departments"
			aria-current={data.view === 'departments' ? 'page' : undefined}
			class="text-brand-600 hover:underline"
		>
			By department
		</a>
	</nav>
	<a href="/t/{data.tenant.slug}/directory" class="ml-auto text-sm text-brand-600 hover:underline">Directory</a>
</div>

<div class="mt-4 panel">
	<Alert message={tree.failed} />
	{#if data.people}
		{#if data.me}<Button type="button" variant="secondary" onclick={findMe}>Find me</Button>{/if}
		<ul class="mt-3" aria-label="Reporting lines">
			{#each roots as node (node.id)}<OrgNode {node} {tree} me={data.me} {base} />{/each}
		</ul>
		{#if data.people.roots.length < rootTotal}
			<p class="mt-2 text-xs text-slate-500">{more(data.people.roots.length, rootTotal)}</p>
		{/if}
	{:else if data.units}
		<ul aria-label="Departments">
			{#each data.units.departments as unit (unit.id)}<UnitNode {unit} {base} />{/each}
		</ul>
		{#if !data.units.departments.length}<p class="text-sm text-slate-500">No departments yet.</p>{/if}
	{/if}
</div>
