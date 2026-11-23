<script lang="ts">
	import AnnouncementFields from '#lib/components/AnnouncementFields.svelte';
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const values = $derived((form && 'values' in form ? form.values : data.announcement) as Record<string, string>);
</script>

<svelte:head><title>{data.announcement.title} · Announcements · {data.tenant.name}</title></svelte:head>

<a class="text-sm text-indigo-700 underline" href={`/t/${data.tenant.slug}/announcements`}>Announcements</a>
<h1 class="mt-2 text-2xl font-semibold text-slate-900">{data.announcement.title}</h1>

<div class="mt-4 max-w-3xl"><Alert message={form?.message} /></div>

<section class="mt-4 max-w-3xl rounded-xl bg-white p-6 ring-1 ring-slate-200" aria-label="Edit announcement">
	<form method="POST" action="?/save" class="grid gap-3 sm:grid-cols-2">
		<AnnouncementFields v={values} departments={data.departments} branches={data.branches} />
		<div><Button type="submit">Save</Button></div>
	</form>
	<form method="POST" action="?/delete" class="mt-4">
		<Button type="submit" variant="secondary">Delete announcement</Button>
	</form>
</section>
