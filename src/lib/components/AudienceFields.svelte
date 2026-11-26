<script lang="ts">
	type Option = { id: string; name: string };
	let {
		label,
		audience = 'all',
		departmentId = '',
		branchId = '',
		departments,
		branches
	}: {
		label: string;
		audience?: string;
		departmentId?: string;
		branchId?: string;
		departments: Option[];
		branches: Option[];
	} = $props();
	const input = 'mt-1 block w-full input';
	const initial = () => audience;
	let picked = $state(initial());
</script>

<label class="block text-sm font-medium text-slate-700">
	{label}
	<select name="audience" bind:value={picked} class={input}>
		<option value="all">Everyone</option>
		<option value="department">A department (and its sub-departments)</option>
		<option value="branch">A branch</option>
	</select>
</label>
{#if picked === 'department'}
	<label class="block text-sm font-medium text-slate-700">
		Department
		<select name="departmentId" required class={input}>
			{#each departments as d (d.id)}<option value={d.id} selected={departmentId === d.id}>{d.name}</option>{/each}
		</select>
	</label>
{:else if picked === 'branch'}
	<label class="block text-sm font-medium text-slate-700">
		Branch
		<select name="branchId" required class={input}>
			{#each branches as b (b.id)}<option value={b.id} selected={branchId === b.id}>{b.name}</option>{/each}
		</select>
	</label>
{/if}
