<script lang="ts">
	import Badge from '#lib/components/ui/Badge.svelte';
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import Field from '#lib/components/ui/Field.svelte';
	import { TICKET_FILTER_LABELS, TICKET_PRIORITY_LABELS, TICKET_STATUS_LABELS } from '#lib/helpdesk-labels.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const base = $derived(`/t/${data.tenant.slug}/helpdesk`);
	const values = $derived((form && 'values' in form ? form.values : {}) as Record<string, string>);
	const input = 'mt-1 block w-full input';
	const when = (d: Date) => d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
</script>

<svelte:head><title>Helpdesk · {data.tenant.name}</title></svelte:head>

<h1 class="page-title">Helpdesk</h1>

<div class="mt-4 max-w-5xl">
	<Alert message={form?.message} />
</div>

{#if data.canRaise}
	<section class="mt-4 max-w-5xl panel" aria-label="Raise a ticket">
		<h2 class="section-title">Raise a ticket</h2>
		<form method="POST" action="?/create" class="mt-3 grid gap-3 sm:grid-cols-3">
			<label class="block text-sm font-medium text-slate-700">
				Category
				<select name="categoryId" required class={input}>
					{#each data.categories as c (c.id)}
						<option value={c.id} selected={values.categoryId === c.id}>
							{c.name}{c.confidential ? ' (confidential)' : ''}
						</option>
					{/each}
				</select>
			</label>
			<label class="block text-sm font-medium text-slate-700">
				Priority
				<select name="priority" class={input}>
					{#each Object.entries(TICKET_PRIORITY_LABELS) as [value, label] (value)}
						<option {value} selected={(values.priority ?? 'normal') === value}>{label}</option>
					{/each}
				</select>
			</label>
			<Field label="Subject" name="subject" required maxlength={160} value={values.subject ?? ''} />
			<label class="block text-sm font-medium text-slate-700 sm:col-span-3">
				Description
				<textarea name="description" required maxlength="5000" rows="4" class={input}
					>{values.description ?? ''}</textarea
				>
			</label>
			<div><Button type="submit">Raise ticket</Button></div>
		</form>
	</section>
{/if}

<nav class="mt-6 flex max-w-5xl flex-wrap gap-2 text-sm" aria-label="Ticket filters">
	{#each Object.entries(TICKET_FILTER_LABELS) as [value, label] (value)}
		<a
			href={`${base}?filter=${value}`}
			aria-current={data.list.filter === value ? 'page' : undefined}
			class={[
				'rounded-full px-3 py-1 ring-1',
				data.list.filter === value ? 'bg-brand-600 text-white ring-brand-600' : 'text-slate-700 ring-slate-300'
			]}
		>
			{label}
		</a>
	{/each}
</nav>

<section class="mt-4 max-w-5xl" aria-label="Tickets">
	{#if data.list.rows.length}
		<table class="data-table">
			<thead>
				<tr>
					<th class="py-2">#</th><th>Subject</th><th>Category</th><th>From</th><th>Priority</th><th>Status</th><th>
						Handled by
					</th><th>Due</th>
				</tr>
			</thead>
			<tbody>
				{#each data.list.rows as t (t.id)}
					<tr class="border-t border-slate-200" data-testid="ticket">
						<td class="py-2">{t.number}</td>
						<td><a class="text-brand-700 underline" href={`${base}/${t.id}`}>{t.subject}</a></td>
						<td>{t.category}{t.confidential ? ' 🔒' : ''}</td>
						<td>{t.requester}</td>
						<td>{TICKET_PRIORITY_LABELS[t.priority]}</td>
						<td><Badge status={t.status} label={TICKET_STATUS_LABELS[t.status]} /></td>
						<td>{t.assignee ?? '—'}</td>
						<td class={t.overdue ? 'font-medium text-red-700' : ''}>
							{when(t.slaDueAt)}{t.overdue ? ' · late' : ''}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{:else}
		<p class="text-sm text-slate-600">No tickets here.</p>
	{/if}
</section>
