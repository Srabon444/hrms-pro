<script lang="ts">
	import Attachments from '#lib/components/Attachments.svelte';
	import AnnouncementFields from '#lib/components/AnnouncementFields.svelte';
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const values = $derived((form && 'values' in form ? form.values : data.announcement) as Record<string, string>);
</script>

<svelte:head><title>{data.announcement.title} · Announcements · {data.tenant.name}</title></svelte:head>

<a class="text-sm text-brand-700 underline" href={`/t/${data.tenant.slug}/announcements`}>Announcements</a>
<h1 class="page-title mt-2">{data.announcement.title}</h1>

<div class="mt-4 max-w-3xl"><Alert message={form?.message} /></div>

<section class="mt-4 max-w-3xl panel" aria-label="Edit announcement">
	<form method="POST" action="?/save" class="grid gap-3 sm:grid-cols-2">
		<AnnouncementFields
			v={values}
			departments={data.departments}
			branches={data.branches}
			draftUrl={data.ai.write ? `/t/${data.tenant.slug}/announcements/draft` : undefined}
		/>
		<div><Button type="submit">Save</Button></div>
	</form>
	<form method="POST" action="?/delete" class="mt-4">
		<Button type="submit" variant="secondary">Delete announcement</Button>
	</form>
</section>

<Attachments slug={data.tenant.slug} attachments={data.attachments} {form} />
