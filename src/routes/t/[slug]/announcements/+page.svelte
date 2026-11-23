<script lang="ts">
	import AnnouncementCard from '#lib/components/AnnouncementCard.svelte';
	import AnnouncementFields from '#lib/components/AnnouncementFields.svelte';
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const base = $derived(`/t/${data.tenant.slug}/announcements`);
	const values = $derived((form && 'values' in form ? form.values : {}) as Record<string, string>);
	const STATE: Record<string, string> = { scheduled: 'Scheduled', live: 'Live', ended: 'Ended' };
</script>

<svelte:head><title>Announcements · {data.tenant.name}</title></svelte:head>

<h1 class="text-2xl font-semibold text-slate-900">Announcements</h1>

<div class="mt-4 max-w-3xl"><Alert message={form?.message} /></div>

{#if data.admin}
	<section class="mt-4 max-w-3xl rounded-xl bg-white p-6 ring-1 ring-slate-200" aria-label="New announcement">
		<h2 class="font-semibold text-slate-900">New announcement</h2>
		<form method="POST" action="?/save" class="mt-3 grid gap-3 sm:grid-cols-2">
			<AnnouncementFields
				v={{ publishOn: data.admin.today, ...values }}
				departments={data.admin.departments}
				branches={data.admin.branches}
			/>
			<div><Button type="submit">Publish</Button></div>
		</form>
	</section>

	<section class="mt-6 max-w-3xl" aria-label="All announcements">
		<h2 class="font-semibold text-slate-900">All announcements</h2>
		<table class="mt-2 w-full text-left text-sm">
			<thead class="text-slate-500">
				<tr><th class="py-2">Title</th><th>Audience</th><th>From</th><th>Until</th><th>State</th></tr>
			</thead>
			<tbody>
				{#each data.admin.rows as a (a.id)}
					<tr class="border-t border-slate-200" data-testid="announcement-row">
						<td class="py-2">
							<a class="text-indigo-700 underline" href={`${base}/${a.id}`}>{a.pinned ? '📌 ' : ''}{a.title}</a>
						</td>
						<td>{a.target ?? 'Everyone'}</td>
						<td>{a.publishOn}</td>
						<td>{a.expiresOn ?? '—'}</td>
						<td>{STATE[a.state]}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</section>
{/if}

<section class="mt-6 max-w-3xl space-y-3" aria-label="For you">
	<h2 class="font-semibold text-slate-900">For you</h2>
	{#each data.feed as a (a.id)}<AnnouncementCard {a} />{:else}<p class="text-sm text-slate-600">
			Nothing to read right now.
		</p>{/each}
</section>
