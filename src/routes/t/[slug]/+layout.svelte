<script lang="ts">
	import { afterNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import GlobalSearch from '#lib/components/GlobalSearch.svelte';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();
	let menuOpen = $state(false);
	afterNavigate(() => (menuOpen = false));
	const root = $derived(`/t/${data.tenant.slug}`);
	const hrefOf = (href: string) => (href ? `${root}/${href}` : root);
	const isActive = (href: string) => {
		if (!href) return page.url.pathname === root;
		const path = hrefOf(href);
		const deeper = data.nav.some((n) => n.href.startsWith(`${href}/`) && page.url.pathname.startsWith(hrefOf(n.href)));
		return !deeper && (page.url.pathname === path || page.url.pathname.startsWith(`${path}/`));
	};
	let search = $state<ReturnType<typeof GlobalSearch>>();
	const searchPages = $derived([
		...data.nav.map((n) => ({ href: hrefOf(n.href), label: n.label, group: n.group })),
		...data.settingsMenu.map((p) => ({
			href: `${root}/settings/${p.href}`,
			label: p.label,
			group: `Settings · ${p.group}`
		}))
	]);
	const groups = $derived(
		data.nav.reduce<{ name: string; items: typeof data.nav }[]>((acc, item) => {
			const last = acc.at(-1);
			if (last?.name === item.group) last.items.push(item);
			else acc.push({ name: item.group, items: [item] });
			return acc;
		}, [])
	);
</script>

<div class="min-h-screen lg:flex">
	<aside class="bg-brand-950 text-brand-100 lg:w-60 lg:shrink-0">
		<div class="lg:sticky lg:top-0 lg:max-h-screen lg:overflow-y-auto">
			<div class="flex items-center justify-between gap-2 pr-3">
				<a href={root} class="flex min-w-0 items-center gap-2.5 px-5 py-4 font-semibold text-white no-underline">
					<span class="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-500 text-sm" aria-hidden="true">
						{data.tenant.name.slice(0, 1).toUpperCase()}
					</span>
					<span class="truncate">{data.tenant.name}</span>
				</a>
				<button
					type="button"
					class="rounded-lg px-3 py-1.5 text-sm font-medium text-white ring-1 ring-white/20 lg:hidden"
					aria-expanded={menuOpen}
					aria-controls="main-nav"
					onclick={() => (menuOpen = !menuOpen)}
				>
					{menuOpen ? 'Close' : 'Menu'}
				</button>
			</div>
			<nav
				id="main-nav"
				aria-label="Main"
				class={['space-y-5 px-3 pb-6 sm:columns-2 sm:gap-6 lg:block lg:columns-1', menuOpen ? 'block' : 'hidden']}
			>
				{#each groups as g (g.name)}
					<div class="space-y-0.5 break-inside-avoid">
						<p class="px-3 pb-1 text-xs font-medium text-brand-300">{g.name}</p>
						{#each g.items as item (item.href)}
							<a
								href={hrefOf(item.href)}
								aria-current={isActive(item.href) ? 'page' : undefined}
								class={[
									'flex items-center rounded-lg px-3 py-1.5 text-sm whitespace-nowrap no-underline transition-colors',
									isActive(item.href)
										? 'bg-white/10 font-medium text-white shadow-[inset_3px_0_0] shadow-brand-300'
										: 'text-brand-100/85 hover:bg-white/5 hover:text-white'
								]}
							>
								{item.label}
								{#if item.href === 'notifications' && data.unread > 0}
									<span
										class="ml-auto rounded-full bg-amber-400 px-1.5 text-xs font-semibold text-brand-950"
										data-testid="unread-count"
									>
										{data.unread}
									</span>
								{/if}
							</a>
						{/each}
					</div>
				{/each}
			</nav>
		</div>
	</aside>
	<div class="min-w-0 flex-1">
		<header
			class="sticky top-0 z-10 flex items-center gap-4 border-b border-slate-200 bg-white/90 px-4 py-2.5 backdrop-blur sm:px-6"
		>
			<GlobalSearch bind:this={search} {root} userId={data.user.id} pages={searchPages} />
			<span class="ml-auto hidden truncate text-sm text-slate-600 sm:inline">{data.user.name}</span>
			<a href="/account/security" class="ml-auto text-sm text-brand-700 hover:underline sm:ml-0">Security</a>
			<form method="POST" action="/logout" onsubmit={() => search?.forget()}>
				<button
					type="submit"
					class="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
				>
					Sign out
				</button>
			</form>
		</header>
		<main class="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">{@render children()}</main>
	</div>
</div>
