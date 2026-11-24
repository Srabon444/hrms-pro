<script lang="ts">
	import { enhance } from '$app/forms';
	import { whileBusy } from '#lib/busy.ts';
	import Button from './Button.svelte';

	let {
		action,
		label,
		button,
		columns,
		example,
		file,
		rows = null
	}: {
		action: string;
		label: string;
		button: string;
		columns: readonly string[];
		example: string[];
		file: string;
		rows?: unknown;
	} = $props();
	const href = $derived(
		`data:text/csv;charset=utf-8,${encodeURIComponent(`${columns.join(',')}\r\n${example.join(',')}\r\n`)}`
	);
	let busy = $state(false);
	const errors = $derived(Array.isArray(rows) ? (rows as { line: number; message: string }[]) : []);
</script>

<form
	method="POST"
	{action}
	enctype="multipart/form-data"
	use:enhance={whileBusy((b) => (busy = b))}
	class="mt-4 flex flex-wrap items-end gap-3"
>
	<label class="text-sm text-slate-700">
		{label} <span class="text-slate-500">(CSV: {columns.join(',')})</span>
		<input name="file" type="file" accept=".csv,text/csv" required class="mt-1 block text-sm" />
	</label>
	<Button type="submit" variant="secondary" disabled={busy}>{busy ? 'Importing…' : button}</Button>
	<a {href} download={file} class="text-sm text-brand-600 hover:underline">Download template</a>
</form>
{#if errors.length}
	<ul class="mt-3 rounded-xl bg-white p-4 text-sm ring-1 ring-slate-200" aria-label="Import errors">
		{#each errors as r (r.line)}
			<li data-testid="import-error"><span class="font-medium">Line {r.line}:</span> {r.message}</li>
		{/each}
	</ul>
{/if}
