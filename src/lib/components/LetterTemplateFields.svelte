<script lang="ts">
	import Field from '#lib/components/ui/Field.svelte';
	import { LETTER_KIND_LABELS } from '#lib/letter-labels.ts';

	let { v, placeholders }: { v: Record<string, string | boolean | null | undefined>; placeholders: readonly string[] } =
		$props();
	const str = (k: string) => (typeof v[k] === 'string' ? (v[k] as string) : '');
	const input = 'mt-1 block w-full input';
</script>

<Field label="Name" name="name" required maxlength={80} value={str('name')} />
<label class="block text-sm font-medium text-slate-700">
	Kind
	<select name="kind" class={input}>
		{#each Object.entries(LETTER_KIND_LABELS) as [k, label] (k)}
			<option value={k} selected={(str('kind') || 'other') === k}>{label}</option>
		{/each}
	</select>
</label>
<div class="sm:col-span-2">
	<Field label="Subject" name="subject" required maxlength={160} value={str('subject')} />
</div>
<label class="block text-sm font-medium text-slate-700 sm:col-span-2">
	Body
	<textarea name="body" required maxlength={20000} rows="12" class="{input} font-mono">{str('body')}</textarea>
</label>
<p class="text-xs text-slate-500 sm:col-span-2" data-testid="placeholders">
	Placeholders: {placeholders.map((p) => `{{${p}}}`).join(' ')}
</p>
<label class="flex items-center gap-2 text-sm text-slate-700">
	<input type="checkbox" name="active" checked={v.name === undefined || v.active === true || v.active === 'on'} /> In use
</label>
