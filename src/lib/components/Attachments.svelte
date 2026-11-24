<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';

	type Item = { id: string; filename: string; size: number };
	let {
		slug,
		attachments,
		form,
		action = '?/files',
		ownerId = '',
		title = 'Attachments',
		compact = false
	}: {
		slug: string;
		attachments: { files: Item[]; canEdit: boolean };
		form: unknown;
		action?: string;
		ownerId?: string;
		title?: string;
		compact?: boolean;
	} = $props();

	const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp';
	const MAX = 5;
	const size = (n: number) => (n < 1024 * 1024 ? `${Math.ceil(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
	const result = $derived((form ?? {}) as { fileMessage?: string; fileSaved?: boolean; fileOwner?: string });
	const mine = $derived(!ownerId || result.fileOwner === ownerId);
</script>

{#snippet body()}
	{#if mine}
		<div class="mt-3 space-y-2">
			<Alert message={result.fileMessage} />
			{#if result.fileSaved}<Alert tone="info" message="Attachments updated." />{/if}
		</div>
	{/if}
	<ul class="mt-3 divide-y divide-slate-100 text-sm">
		{#each attachments.files as f (f.id)}
			<li class="flex flex-wrap items-center gap-3 py-2" data-testid="attachment">
				<a href="/t/{slug}/files/{f.id}" class="break-all text-brand-700 hover:underline">{f.filename}</a>
				<span class="text-slate-500">{size(f.size)}</span>
				{#if attachments.canEdit}
					<form method="POST" {action} enctype="multipart/form-data" class="ml-auto flex flex-wrap items-center gap-2">
						<input type="hidden" name="fileId" value={f.id} />
						{#if ownerId}<input type="hidden" name="ownerId" value={ownerId} />{/if}
						<input
							name="files"
							type="file"
							accept={ACCEPT}
							aria-label="Replacement for {f.filename}"
							class="max-w-52 text-xs"
						/>
						<button type="submit" name="op" value="replace" class="text-brand-700 hover:underline">Replace</button>
						<button
							type="submit"
							name="op"
							value="remove"
							formnovalidate
							class="text-red-600 hover:underline"
							aria-label="Remove {f.filename}"
						>
							Remove
						</button>
					</form>
				{/if}
			</li>
		{:else}
			<li class="py-2 text-slate-500">No files attached.</li>
		{/each}
	</ul>
	{#if attachments.canEdit && attachments.files.length < MAX}
		<form method="POST" {action} enctype="multipart/form-data" class="mt-4 flex flex-wrap items-center gap-3">
			{#if ownerId}<input type="hidden" name="ownerId" value={ownerId} />{/if}
			<input name="files" type="file" multiple required accept={ACCEPT} aria-label="Files to attach" class="text-sm" />
			<Button type="submit" name="op" value="add" variant="secondary">Attach files</Button>
		</form>
		<p class="mt-2 text-xs text-slate-500">PDF, PNG, JPEG or WEBP. Up to {MAX} files, 10 MB per upload.</p>
	{/if}
{/snippet}

{#if compact}
	<details class="mt-2 text-sm" aria-label={title} open={mine && !!(result.fileMessage || result.fileSaved)}>
		<summary class="cursor-pointer text-brand-700">{title} ({attachments.files.length})</summary>
		{@render body()}
	</details>
{:else}
	<section class="mt-6 max-w-3xl panel" aria-label={title}>
		<h2 class="section-title">{title}</h2>
		{@render body()}
	</section>
{/if}
