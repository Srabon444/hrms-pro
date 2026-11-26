<script lang="ts">
	import OrgNode from './OrgNode.svelte';
	import { more, type Node, type Tree } from './tree';

	let { node, tree, me, base }: { node: Node; tree: Tree; me: string | null; base: string } = $props();
	const kids = $derived(tree.kids[node.id]);
	const open = $derived(!!tree.open[node.id]);

	async function toggle() {
		if (!open && !kids) {
			const res = await fetch(`${base}/nodes?of=${node.id}`);
			if (!res.ok) {
				tree.failed = 'Could not load that team. Try again.';
				return;
			}
			tree.kids[node.id] = (await res.json()).nodes;
		}
		tree.open[node.id] = !open;
	}
</script>

<li class="mt-1">
	<div class="flex items-center gap-2" id="node-{node.id}" tabindex="-1">
		{#if node.reports}
			<button
				type="button"
				class="w-6 rounded text-slate-500 hover:bg-slate-100"
				aria-expanded={open}
				aria-label="{open ? 'Hide' : 'Show'} the team of {node.name}"
				onclick={toggle}
			>
				{open ? '−' : '+'}
			</button>
		{:else}<span class="w-6"></span>{/if}
		<span
			class={node.id === me ? 'font-semibold text-brand-700' : ''}
			aria-current={node.id === me ? 'true' : undefined}
		>
			{node.name}
		</span>
		{#if node.designation}<span class="text-sm text-slate-500">{node.designation}</span>{/if}
		{#if node.reports}<span class="text-xs text-slate-400">{node.reports} reporting</span>{/if}
	</div>
	{#if open && kids}
		<ul class="ml-6 border-l border-slate-200 pl-3">
			{#each kids as child (child.id)}<OrgNode node={child} {tree} {me} {base} />{/each}
			{#if kids.length < node.reports}<li class="mt-1 text-xs text-slate-500">
					{more(kids.length, node.reports)}
				</li>{/if}
		</ul>
	{/if}
</li>
