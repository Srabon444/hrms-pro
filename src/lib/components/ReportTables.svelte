<script lang="ts">
	type Section = {
		key: string;
		title: string;
		columns: { key: string; label: string; numeric?: true }[];
		rows: { cells: Record<string, string | number | null> }[];
	};
	let { sections }: { sections: Section[] } = $props();
</script>

{#each sections as s (s.key)}
	<section class="mt-6 max-w-5xl" aria-label={s.title}>
		<h2 class="section-title">{s.title}</h2>
		<table class="mt-2 data-table">
			<thead>
				<tr>
					{#each s.columns as c (c.key)}<th class={['py-2', c.numeric && 'text-right']}>{c.label}</th>{/each}
				</tr>
			</thead>
			<tbody>
				{#each s.rows as row, i (i)}
					<tr class="border-t border-slate-200" data-testid={`row-${s.key}`}>
						{#each s.columns as c (c.key)}
							<td class={['py-2', c.numeric && 'text-right tabular-nums']}>{row.cells[c.key] ?? '—'}</td>
						{/each}
					</tr>
				{:else}
					<tr><td colspan={s.columns.length} class="py-2 text-slate-500">Nothing in this period.</td></tr>
				{/each}
			</tbody>
		</table>
	</section>
{/each}
