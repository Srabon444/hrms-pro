<script lang="ts">
	import Attachments from '#lib/components/Attachments.svelte';

	type Task = {
		id: string;
		title: string;
		assigneeRole: string;
		dueDate: string;
		overdue: boolean;
		checklist: string;
		employeeId: string;
		employeeName: string;
		employeeCode: string;
		readable?: boolean;
	};
	type Item = { id: string; filename: string; size: number };
	let {
		tasks,
		slug,
		roleNames,
		action,
		files,
		form
	}: {
		tasks: Task[];
		slug: string;
		roleNames: Record<string, string>;
		action: string;
		files: Record<string, Item[]>;
		form: unknown;
	} = $props();
</script>

<ul class="mt-3 divide-y divide-slate-100 text-sm">
	{#each tasks as t (t.id)}
		<li class="flex flex-wrap items-start justify-between gap-3 py-2" data-testid="task">
			<div class="min-w-0 flex-1">
				<p class="font-medium text-slate-900">{t.title}</p>
				<p class="text-slate-500">
					{#if t.readable ?? true}
						<a href="/t/{slug}/employees/{t.employeeId}" class="text-brand-700 hover:underline">{t.employeeName}</a>
					{:else}
						{t.employeeName}
					{/if}
					· {t.checklist} · {roleNames[t.assigneeRole] ?? t.assigneeRole} ·
					<span class={t.overdue ? 'font-medium text-red-700' : ''}>
						due {t.dueDate}{t.overdue ? ' (overdue)' : ''}
					</span>
				</p>
				<Attachments
					{slug}
					attachments={{ files: files[t.id] ?? [], canEdit: true }}
					{form}
					action="?/taskFiles"
					ownerId={t.id}
					title="Proof"
					compact
				/>
			</div>
			<form method="POST" {action}>
				<input type="hidden" name="itemId" value={t.id} />
				<input type="hidden" name="done" value="true" />
				<button type="submit" class="text-brand-700 hover:underline" aria-label="Done: {t.title} for {t.employeeName}">
					Mark done
				</button>
			</form>
		</li>
	{:else}
		<li class="py-2 text-slate-500">No open tasks.</li>
	{/each}
</ul>
