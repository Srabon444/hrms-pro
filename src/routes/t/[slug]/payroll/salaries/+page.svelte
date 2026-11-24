<script lang="ts">
	import Attachments from '#lib/components/Attachments.svelte';
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import { money, unit } from '#lib/money.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const b = $derived(data.board);
	const input = 'input px-2 py-1';
</script>

<svelte:head><title>Salaries · {data.tenant.name}</title></svelte:head>

<h1 class="page-title">Salaries</h1>

<div class="mt-4 max-w-4xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'done' in form}<Alert tone="info" message={form.done} />{/if}
</div>

{#if b.pending.length}
	<section class="mt-6 max-w-4xl panel" aria-label="Waiting for approval">
		<h2 class="section-title">Waiting for approval</h2>
		<ul class="mt-3 divide-y divide-slate-100 text-sm">
			{#each b.pending as c (c.id)}
				<li class="py-3" data-testid="salary-change">
					<p class="text-slate-800">{c.name} · {money(c.gross, data.currency)} gross from {c.effectiveFrom}</p>
					<p class="text-slate-500">{c.lines.join(', ')} · {c.reason}</p>
					{#if c.canAttach || data.changeFiles[c.id]?.length}
						<Attachments
							slug={data.tenant.slug}
							attachments={{ files: data.changeFiles[c.id] ?? [], canEdit: c.canAttach }}
							{form}
							action="?/changeFiles"
							ownerId={c.id}
							title="Documents"
							compact
						/>
					{/if}
					{#if c.canDecide}
						<form method="POST" action="?/decide" class="mt-2 flex flex-wrap items-center gap-2">
							<input type="hidden" name="changeId" value={c.id} />
							<input name="note" maxlength="300" aria-label={`Note for ${c.name}`} class={`${input} w-64`} />
							<Button type="submit" name="decision" value="approve">Approve salary of {c.name}</Button>
							<Button type="submit" name="decision" value="reject">Reject salary of {c.name}</Button>
						</form>
					{/if}
				</li>
			{/each}
		</ul>
	</section>
{/if}

{#if b.canPropose}
	<section class="mt-6 max-w-4xl panel" aria-label="New salary">
		<h2 class="section-title">New salary</h2>
		<form method="POST" action="?/propose" class="mt-3 grid gap-3 text-sm sm:grid-cols-2">
			<label class="text-slate-700">
				Employee
				<select name="employeeId" required class={`${input} block w-full`}>
					<option value="">Choose…</option>
					{#each b.people as p (p.id)}<option value={p.id}>{p.name} ({p.code})</option>{/each}
				</select>
			</label>
			<label class="text-slate-700">
				Starts on
				<input name="effectiveFrom" type="date" required value={b.today} class={`${input} block w-full`} />
			</label>
			{#each b.components as c (c.id)}
				<label class="text-slate-700">
					{c.name}
					{c.calc === 'pct_basic' ? '(% of basic)' : `(${unit(data.currency)})`}
					<input
						name={`c_${c.id}`}
						inputmode="decimal"
						required={c.code === 'BASIC'}
						pattern={c.calc === 'pct_basic' ? '\\d{1,3}(\\.\\d{1,2})?' : '\\d{1,7}(\\.\\d{1,2})?'}
						class={`${input} block w-full`}
					/>
				</label>
			{/each}
			<label class="text-slate-700 sm:col-span-2">
				Reason
				<input name="reason" required maxlength="300" class={`${input} block w-full`} />
			</label>
			<div><Button type="submit">Send for approval</Button></div>
		</form>
	</section>
{/if}

<section class="mt-6 max-w-4xl panel" aria-label="Current salaries">
	<h2 class="section-title">Current salaries</h2>
	<table class="mt-3 data-table">
		<thead>
			<tr><th class="py-1">Employee</th><th>Gross</th><th>Since</th><th>Breakdown</th></tr>
		</thead>
		<tbody>
			{#each b.people as p (p.id)}
				<tr class="border-t border-slate-100" data-testid="salary-row">
					<td class="py-1">{p.name} <span class="text-slate-400">{p.code}</span></td>
					{#if p.salary}
						<td>{money(p.salary.gross, data.currency)}</td>
						<td>{p.salary.effectiveFrom}</td>
						<td class="text-slate-500">{p.salary.lines.join(', ')}</td>
					{:else}
						<td colspan="3" class="text-slate-400">No salary yet</td>
					{/if}
				</tr>
			{/each}
		</tbody>
	</table>
</section>
