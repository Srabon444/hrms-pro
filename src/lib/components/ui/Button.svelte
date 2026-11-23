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
		'inline-flex justify-center rounded-md px-4 py-2 text-sm font-semibold shadow-sm disabled:opacity-50',
		variant === 'primary' && 'bg-indigo-600 text-white hover:bg-indigo-500',
		variant === 'secondary' && 'bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50',
		variant === 'danger' && 'bg-red-600 text-white hover:bg-red-500'
	]}
>
	{@render children()}
</button>
