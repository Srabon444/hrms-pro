<script lang="ts">
	import { page } from '$app/state';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();
	const base = $derived(`/t/${data.tenant.slug}/settings`);
	const groups = $derived(Map.groupBy(data.settingsPages, (p) => p.group));
	const onHub = $derived(page.url.pathname === base);
</script>

{#if onHub}
	{@render children()}
{:else}
	<div class="gap-8 lg:flex">
		<nav aria-label="Settings" class="mb-6 shrink-0 lg:mb-0 lg:w-48">
			<a href={base} class="text-sm font-medium text-indigo-700 hover:underline">All settings</a>
			{#each groups as [group, pages] (group)}
				<p class="mt-4 text-xs font-semibold tracking-wide text-slate-500 uppercase">{group}</p>
				<ul class="mt-1 flex flex-wrap gap-1 lg:flex-col">
					{#each pages as p (p.href)}
						{@const href = `${base}/${p.href}`}
						<li>
							<a
								{href}
								aria-current={page.url.pathname.startsWith(href) ? 'page' : undefined}
								class={[
									'block rounded-md px-2 py-1 text-sm',
									page.url.pathname.startsWith(href)
										? 'bg-indigo-50 font-medium text-indigo-700'
										: 'text-slate-700 hover:bg-slate-100'
								]}
							>
								{p.label}
							</a>
						</li>
					{/each}
				</ul>
			{/each}
		</nav>
		<div class="min-w-0 flex-1">{@render children()}</div>
	</div>
{/if}
