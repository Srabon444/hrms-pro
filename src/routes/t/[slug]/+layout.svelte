<script lang="ts">
	import Button from '#lib/components/ui/Button.svelte';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();
</script>

<div class="min-h-screen bg-slate-50">
	<header class="border-b border-slate-200 bg-white">
		<div class="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3">
			<a href="/t/{data.tenant.slug}" class="font-semibold text-indigo-700">{data.tenant.name}</a>
			<span class="ml-auto text-sm text-slate-600">{data.user.name}</span>
			<a href="/account/security" class="text-sm text-indigo-600 hover:underline">Security</a>
			<form method="POST" action="/logout"><Button type="submit" variant="secondary">Sign out</Button></form>
		</div>
	</header>
	<main class="mx-auto max-w-6xl px-4 py-8">{@render children()}</main>
</div>
