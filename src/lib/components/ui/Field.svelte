<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements';

	let { label, name, help, ...rest }: { label: string; name: string; help?: string } & HTMLInputAttributes = $props();
	const id = $props.id();
</script>

<label class="block">
	<span class="text-sm font-medium text-slate-700">{label}</span>
	<input
		{name}
		aria-describedby={help ? `${id}-help` : undefined}
		{...rest}
		class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-slate-900 shadow-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none"
	/>
	{#if help}<span id="{id}-help" class="mt-1 block text-xs text-slate-500">{help}</span>{/if}
</label>
