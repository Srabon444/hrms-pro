export type Node = {
	id: string;
	name: string;
	designation: string | null;
	managerId: string | null;
	reports: number;
	siblings: number;
};
export type Unit = { id: string; name: string; people: number; subDepartments: number };
export type Tree = { kids: Record<string, Node[]>; open: Record<string, boolean>; failed: string | null };

export const more = (shown: number, total: number) =>
	`Showing ${shown} of ${total}. Search the directory to find the rest.`;

export const group = (nodes: Node[]): Record<string, Node[]> =>
	nodes.reduce<Record<string, Node[]>>((acc, n) => {
		if (n.managerId) (acc[n.managerId] ??= []).push(n);
		return acc;
	}, {});
