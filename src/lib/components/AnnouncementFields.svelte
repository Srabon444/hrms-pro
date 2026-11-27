<script lang="ts">
	import AiAssist from '#lib/components/AiAssist.svelte';
	import AudienceFields from '#lib/components/AudienceFields.svelte';
	import Field from '#lib/components/ui/Field.svelte';

	type Option = { id: string; name: string };
	let {
		v,
		departments,
		branches,
		draftUrl
	}: {
		v: Record<string, string | boolean | null | undefined>;
		departments: Option[];
		branches: Option[];
		draftUrl?: string;
	} = $props();
	const input = 'mt-1 block w-full input';
	const str = (k: string) => (typeof v[k] === 'string' ? (v[k] as string) : '');
	let publishOn = $state(str('publishOn'));
</script>

<Field label="Title" name="title" required maxlength={160} value={str('title')} />
<AudienceFields
	label="Who sees it"
	audience={str('audience') || 'all'}
	departmentId={str('departmentId')}
	branchId={str('branchId')}
	{departments}
	{branches}
/>
<label class="block text-sm font-medium text-slate-700">
	Publish on
	<input name="publishOn" type="date" required bind:value={publishOn} class={input} />
</label>
<Field label="Show until (optional)" name="expiresOn" type="date" min={publishOn} value={str('expiresOn')} />
<label class="flex items-center gap-2 text-sm text-slate-700">
	<input type="checkbox" name="pinned" checked={v.pinned === true || v.pinned === 'on'} />
	Pin to the top
</label>
<label class="block text-sm font-medium text-slate-700 sm:col-span-2">
	Message
	<textarea name="body" required maxlength="5000" rows="5" class={input}>{str('body')}</textarea>
</label>
{#if draftUrl}
	<div class="sm:col-span-2"><AiAssist url={draftUrl} label="Draft with AI" send={['title']} /></div>
{/if}
