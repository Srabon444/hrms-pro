<script lang="ts">
	import Field from '#lib/components/ui/Field.svelte';

	let { v, fileRequired }: { v: Record<string, string | boolean | null | undefined>; fileRequired: boolean } = $props();
	const str = (k: string) => (typeof v[k] === 'string' ? (v[k] as string) : '');
	const on = (k: string, fallback: boolean) => (v.title === undefined ? fallback : v[k] === true || v[k] === 'on');
</script>

<div class="sm:col-span-2"><Field label="Title" name="title" required maxlength={160} value={str('title')} /></div>
<label class="block text-sm font-medium text-slate-700 sm:col-span-2">
	Summary
	<textarea name="description" maxlength={2000} rows="3" class="mt-1 block w-full input">{str('description')}</textarea>
</label>
<label class="block text-sm font-medium text-slate-700">
	{fileRequired ? 'Policy PDF' : 'New version (PDF, optional)'}
	<input name="file" type="file" accept=".pdf,application/pdf" required={fileRequired} class="mt-1 block text-sm" />
</label>
<div class="space-y-2 text-sm text-slate-700">
	<label class="flex items-center gap-2">
		<input type="checkbox" name="requiresAck" checked={on('requiresAck', true)} /> Everyone must acknowledge it
	</label>
	<label class="flex items-center gap-2">
		<input type="checkbox" name="active" checked={on('active', true)} /> Published
	</label>
</div>
