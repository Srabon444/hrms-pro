<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements';

	let { label, name, help, ...rest }: { label: string; name: string; help?: string } & HTMLInputAttributes = $props();
	const id = $props.id();
</script>

<label class="block">
	<span class="text-sm font-medium text-slate-700">{label}</span>
	<input {name} aria-describedby={help ? `${id}-help` : undefined} {...rest} class="mt-1 block w-full input" />
	{#if help}<span id="{id}-help" class="mt-1 block text-xs text-slate-500">{help}</span>{/if}
</label>
