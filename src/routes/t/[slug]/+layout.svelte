<script lang="ts">
	import { page } from '$app/state';
	import Button from '#lib/components/ui/Button.svelte';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();
	const root = $derived(`/t/${data.tenant.slug}`);
	const hrefOf = (href: string) => (href ? `${root}/${href}` : root);
	const isActive = (href: string) => (href ? page.url.pathname.startsWith(hrefOf(href)) : page.url.pathname === root);
</script>

<div class="min-h-screen bg-slate-50 md:flex">
	<aside class="border-b border-slate-200 bg-white md:min-h-screen md:w-56 md:border-r md:border-b-0">
		<a href={root} class="block px-4 py-4 font-semibold text-indigo-700">{data.tenant.name}</a>
		<nav aria-label="Main" class="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:pb-4">
			{#each data.nav as item (item.href)}
				<a
					href={hrefOf(item.href)}
					aria-current={isActive(item.href) ? 'page' : undefined}
					class={[
						'rounded-md px-3 py-2 text-sm whitespace-nowrap',
						isActive(item.href) ? 'bg-indigo-50 font-medium text-indigo-700' : 'text-slate-700 hover:bg-slate-100'
					]}
				>
					{item.label}
					{#if item.href === 'notifications' && data.unread > 0}
						<span class="ml-1 rounded-full bg-indigo-600 px-1.5 text-xs text-white" data-testid="unread-count">
							{data.unread}
						</span>
					{/if}
				</a>
			{/each}
		</nav>
	</aside>
	<div class="flex-1">
		<header class="flex items-center gap-4 border-b border-slate-200 bg-white px-4 py-3">
			<span class="ml-auto text-sm text-slate-600">{data.user.name}</span>
			<a href="/account/security" class="text-sm text-indigo-600 hover:underline">Security</a>
			<form method="POST" action="/logout"><Button type="submit" variant="secondary">Sign out</Button></form>
		</header>
		<main class="mx-auto max-w-6xl px-4 py-8">{@render children()}</main>
	</div>
</div>
