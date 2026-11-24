export function labelTables(root: ParentNode = document): void {
	for (const table of root.querySelectorAll<HTMLTableElement>('table.data-table')) {
		const heads = [...(table.tHead?.rows[0]?.cells ?? [])].flatMap((th) =>
			Array<string>(th.colSpan).fill(th.colSpan > 1 ? '' : (th.textContent ?? '').trim())
		);
		const rows = [...table.tBodies, ...(table.tFoot ? [table.tFoot] : [])].flatMap((b) => [...b.rows]);
		for (const row of rows) {
			let col = 0;
			for (const cell of row.cells) {
				const label = cell.colSpan > 1 ? '' : (heads[col] ?? '');
				if (cell.dataset.label !== label) cell.dataset.label = label;
				col += cell.colSpan;
			}
		}
	}
}
