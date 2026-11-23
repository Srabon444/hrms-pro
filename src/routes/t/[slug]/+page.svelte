<script lang="ts">
	import AnnouncementCard from '#lib/components/AnnouncementCard.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head><title>{data.tenant.name} · HRMS</title></svelte:head>

<h1 class="text-2xl font-semibold text-slate-900">Welcome to {data.tenant.name}</h1>
{#if data.membership.status === 'ex_employee'}
	<p class="mt-2 text-slate-600">Your employment has ended. You can still download your documents and payslips.</p>
{/if}

{#if data.announcements.length}
	<section class="mt-6 max-w-3xl space-y-3" aria-label="Announcements">
		<h2 class="font-semibold text-slate-900">
			Announcements
			<a class="ml-2 text-sm font-normal text-indigo-700 underline" href={`/t/${data.tenant.slug}/announcements`}>
				See all
			</a>
		</h2>
		{#each data.announcements as a (a.id)}<AnnouncementCard {a} />{/each}
	</section>
{/if}
