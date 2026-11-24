<script lang="ts">
	import LetterTemplateFields from '#lib/components/LetterTemplateFields.svelte';
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import { LETTER_KIND_LABELS } from '#lib/letter-labels.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const values = $derived((form?.values ?? {}) as Record<string, string>);
</script>

<svelte:head><title>Letter templates · {data.tenant.name}</title></svelte:head>

<h1 class="page-title">Letter templates</h1>

<section class="mt-6 max-w-3xl" aria-label="Templates">
	<table class="data-table">
		<thead><tr><th class="py-2">Name</th><th>Kind</th><th>Status</th></tr></thead>
		<tbody>
			{#each data.templates as t (t.id)}
				<tr class="border-t border-slate-200" data-testid="letter-template">
					<td class="py-2">
						<a class="text-brand-700 underline" href={`/t/${data.tenant.slug}/settings/letters/${t.id}`}>{t.name}</a>
					</td>
					<td>{LETTER_KIND_LABELS[t.kind]}</td>
					<td>{t.active ? 'In use' : 'Retired'}</td>
				</tr>
			{/each}
		</tbody>
	</table>
</section>

<div class="mt-4 max-w-3xl"><Alert message={form?.message} /></div>

<section class="mt-4 max-w-3xl panel" aria-label="New template">
	<h2 class="section-title">New template</h2>
	<form method="POST" action="?/save" class="mt-3 grid gap-3 sm:grid-cols-2">
		<LetterTemplateFields v={values} placeholders={data.placeholders} />
		<div class="sm:col-span-2"><Button type="submit">Add template</Button></div>
	</form>
</section>
