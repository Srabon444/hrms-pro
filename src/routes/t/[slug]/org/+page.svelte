<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const input = 'rounded-md border border-slate-300 px-2 py-1 text-sm';
	const parentName = (id: string | null) => data.departments.find((d) => d.id === id)?.name;
	type Row = { id: string; name: string; parentId?: string | null; address?: string | null; rank?: number };
	const sections: { kind: 'department' | 'branch' | 'designation' | 'grade'; title: string; rows: Row[] }[] = $derived([
		{ kind: 'department', title: 'Departments', rows: data.departments },
		{ kind: 'branch', title: 'Branches', rows: data.branches },
		{ kind: 'designation', title: 'Designations', rows: data.designations },
		{ kind: 'grade', title: 'Grades', rows: data.grades }
	]);
</script>

<svelte:head><title>Organisation · {data.tenant.name}</title></svelte:head>

<h1 class="text-2xl font-semibold text-slate-900">Organisation structure</h1>
<div class="mt-4 max-w-xl"><Alert message={form?.message} /></div>

{#snippet parentSelect(current: string | null | undefined, self: string | null, label: string)}
	<select name="parentId" aria-label={label} class={input}>
		<option value="">No parent</option>
		{#each data.departments.filter((d) => d.id !== self) as d (d.id)}
			<option value={d.id} selected={d.id === current}>{d.name}</option>
		{/each}
	</select>
{/snippet}

<div class="mt-6 grid gap-6 lg:grid-cols-2">
	{#each sections as section (section.kind)}
		<section class="rounded-xl bg-white p-5 ring-1 ring-slate-200" aria-label={section.title}>
			<h2 class="font-semibold text-slate-900">{section.title}</h2>
			<ul class="mt-3 space-y-2">
				{#each section.rows as row (row.id)}
					<li class="flex flex-wrap items-center gap-2">
						<form method="POST" action="?/update" class="flex flex-1 flex-wrap items-center gap-2">
							<input type="hidden" name="kind" value={section.kind} />
							<input type="hidden" name="id" value={row.id} />
							<input
								name="name"
								value={row.name}
								required
								maxlength={120}
								aria-label="Name of {row.name}"
								class={input}
							/>
							{#if section.kind === 'department'}
								{@render parentSelect(row.parentId, row.id, `Parent of ${row.name}`)}
							{:else if section.kind === 'branch'}
								<input
									name="address"
									value={row.address ?? ''}
									placeholder="Address"
									aria-label="Address of {row.name}"
									class={input}
								/>
							{:else if section.kind === 'grade'}
								<input
									name="rank"
									type="number"
									min={0}
									max={1000}
									value={row.rank}
									aria-label="Rank of {row.name}"
									class="{input} w-20"
								/>
							{/if}
							<Button type="submit" variant="secondary">Save</Button>
						</form>
						<form method="POST" action="?/remove">
							<input type="hidden" name="kind" value={section.kind} />
							<input type="hidden" name="id" value={row.id} />
							<Button type="submit" variant="danger" aria-label="Delete {row.name}">Delete</Button>
						</form>
						{#if section.kind === 'department' && row.parentId}
							<span class="w-full text-xs text-slate-500">Under {parentName(row.parentId)}</span>
						{/if}
					</li>
				{:else}
					<li class="text-sm text-slate-500">None yet.</li>
				{/each}
			</ul>
			<form method="POST" action="?/add" class="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
				<input type="hidden" name="kind" value={section.kind} />
				<input
					name="name"
					required
					maxlength={120}
					placeholder="Name"
					aria-label="New {section.kind} name"
					class={input}
				/>
				{#if section.kind === 'department'}
					{@render parentSelect(null, null, 'Parent of new department')}
				{:else if section.kind === 'branch'}
					<input name="address" placeholder="Address" aria-label="New branch address" class={input} />
				{:else if section.kind === 'grade'}
					<input
						name="rank"
						type="number"
						min={0}
						max={1000}
						placeholder="Rank"
						aria-label="New grade rank"
						class="{input} w-20"
					/>
				{/if}
				<Button type="submit">Add</Button>
			</form>
		</section>
	{/each}

	<section class="rounded-xl bg-white p-5 ring-1 ring-slate-200 lg:col-span-2" aria-label="Holidays">
		<div class="flex items-center gap-4">
			<h2 class="font-semibold text-slate-900">Holidays {data.year}</h2>
			<a href="?year={data.year - 1}" class="text-sm text-indigo-600 hover:underline">{data.year - 1}</a>
			<a href="?year={data.year + 1}" class="text-sm text-indigo-600 hover:underline">{data.year + 1}</a>
		</div>
		<ul class="mt-3 divide-y divide-slate-100">
			{#each data.holidays as h (h.id)}
				<li class="flex items-center gap-4 py-2 text-sm">
					<span class="w-28 font-mono">{h.date}</span>
					<span class="flex-1">{h.name}</span>
					<form method="POST" action="?/removeHoliday">
						<input type="hidden" name="id" value={h.id} />
						<Button type="submit" variant="danger" aria-label="Delete holiday {h.name}">Delete</Button>
					</form>
				</li>
			{:else}
				<li class="py-2 text-sm text-slate-500">No holidays for {data.year}.</li>
			{/each}
		</ul>
		<form method="POST" action="?/addHoliday" class="mt-4 flex flex-wrap items-center gap-2">
			<input name="date" type="date" required aria-label="Holiday date" class={input} />
			<input name="name" required maxlength={120} placeholder="Holiday name" aria-label="Holiday name" class={input} />
			<Button type="submit">Add holiday</Button>
		</form>
	</section>
</div>
