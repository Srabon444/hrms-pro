<script lang="ts">
	import LetterTemplateFields from '#lib/components/LetterTemplateFields.svelte';
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const values = $derived(
		(form?.values ?? {
			name: data.template.name,
			kind: data.template.kind,
			subject: data.template.subject,
			body: data.template.body,
			active: data.template.active
		}) as Record<string, string | boolean>
	);
</script>

<svelte:head><title>{data.template.name} · {data.tenant.name}</title></svelte:head>

<a class="text-sm text-indigo-700 underline" href={`/t/${data.tenant.slug}/settings/letters`}>All templates</a>
<h1 class="mt-2 text-2xl font-semibold text-slate-900">{data.template.name}</h1>

<div class="mt-4 max-w-3xl"><Alert message={form?.message} /></div>

<form method="POST" action="?/save" class="mt-4 grid max-w-3xl gap-3 sm:grid-cols-2">
	<LetterTemplateFields v={values} placeholders={data.placeholders} />
	<div class="sm:col-span-2"><Button type="submit">Save</Button></div>
</form>
