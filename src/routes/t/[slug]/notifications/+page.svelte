<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const root = $derived(`/t/${data.tenant.slug}`);
</script>

<svelte:head><title>Notifications · {data.tenant.name}</title></svelte:head>

<div class="flex items-center">
	<h1 class="text-2xl font-semibold text-slate-900">Notifications</h1>
	{#if data.items.some((n) => !n.readAt)}
		<form method="POST" action="?/readAll" class="ml-auto">
			<Button type="submit" variant="secondary">Mark all as read</Button>
		</form>
	{/if}
</div>

<ul class="mt-6 divide-y divide-slate-200 rounded-xl bg-white ring-1 ring-slate-200">
	{#each data.items as n (n.id)}
		<li class="flex items-start gap-4 p-4" data-testid="notification">
			<div class="flex-1">
				<p class={['text-sm', n.readAt ? 'text-slate-600' : 'font-semibold text-slate-900']}>{n.title}</p>
				{#if n.body}<p class="mt-1 text-sm text-slate-600">{n.body}</p>{/if}
				<p class="mt-1 text-xs text-slate-500">{n.createdAt.toLocaleString()}</p>
			</div>
			{#if n.link}<a href="{root}/{n.link}" class="text-sm text-indigo-600 hover:underline">Open</a>{/if}
			{#if !n.readAt}
				<form method="POST" action="?/read">
					<input type="hidden" name="id" value={n.id} />
					<button type="submit" class="text-sm text-slate-600 hover:underline">Mark read</button>
				</form>
			{/if}
		</li>
	{:else}
		<li class="p-6 text-sm text-slate-600">You have no notifications.</li>
	{/each}
</ul>

<section class="mt-10 max-w-lg rounded-xl bg-white p-6 ring-1 ring-slate-200">
	<h2 class="font-semibold text-slate-900">Email me about</h2>
	<form method="POST" action="?/prefs" class="mt-4 space-y-3">
		{#each data.prefs as p (p.category)}
			<label class="flex items-center gap-2 text-sm text-slate-700">
				<input type="checkbox" name="email_{p.category}" checked={p.email} />
				{p.label}
			</label>
		{/each}
		<Button type="submit">Save</Button>
		{#if form && 'prefsSaved' in form}<Alert tone="info" message="Email preferences saved." />{/if}
	</form>
</section>
