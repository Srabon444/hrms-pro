<script lang="ts">
	import Field from '#lib/components/ui/Field.svelte';

	type Option = { id: string; name: string };
	let {
		v,
		departments,
		branches
	}: { v: Record<string, string | boolean | null | undefined>; departments: Option[]; branches: Option[] } = $props();
	const input = 'mt-1 block w-full input';
	const str = (k: string) => (typeof v[k] === 'string' ? (v[k] as string) : '');
	let audience = $state(str('audience') || 'all');
	let publishOn = $state(str('publishOn'));
</script>

<Field label="Title" name="title" required maxlength={160} value={str('title')} />
<label class="block text-sm font-medium text-slate-700">
	Who sees it
	<select name="audience" bind:value={audience} class={input}>
		<option value="all">Everyone</option>
		<option value="department">A department (and its sub-departments)</option>
		<option value="branch">A branch</option>
	</select>
</label>
{#if audience === 'department'}
	<label class="block text-sm font-medium text-slate-700">
		Department
		<select name="departmentId" required class={input}>
			{#each departments as d (d.id)}<option value={d.id} selected={str('departmentId') === d.id}>
					{d.name}
				</option>{/each}
		</select>
	</label>
{:else if audience === 'branch'}
	<label class="block text-sm font-medium text-slate-700">
		Branch
		<select name="branchId" required class={input}>
			{#each branches as b (b.id)}<option value={b.id} selected={str('branchId') === b.id}>{b.name}</option>{/each}
		</select>
	</label>
{/if}
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
