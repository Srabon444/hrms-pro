<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLButtonAttributes } from 'svelte/elements';

	let {
		children,
		variant = 'primary',
		...rest
	}: { children: Snippet; variant?: 'primary' | 'secondary' | 'danger' } & HTMLButtonAttributes = $props();
</script>

<button
	{...rest}
	class={[
		'inline-flex items-center justify-center gap-1.5 rounded-lg border border-transparent px-3.5 py-1.5 text-sm font-medium transition-colors disabled:opacity-50',
		variant === 'primary' && 'bg-brand-600 text-white hover:bg-brand-700',
		variant === 'secondary' && 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50',
		variant === 'danger' && 'bg-red-600 text-white hover:bg-red-500'
	]}
>
	{@render children()}
</button>
