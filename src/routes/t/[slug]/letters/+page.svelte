<script lang="ts">
	import Button from '#lib/components/ui/Button.svelte';
	import { LETTER_KIND_LABELS } from '#lib/letter-labels.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const base = $derived(`/t/${data.tenant.slug}/letters`);
	const ref = (n: number) => `L-${String(n).padStart(5, '0')}`;
	const field = 'mt-1 block w-full input';
</script>

<svelte:head><title>Letters · {data.tenant.name}</title></svelte:head>

<h1 class="page-title">Letters</h1>

<section class="mt-6 max-w-3xl" aria-label="My letters">
	<h2 class="section-title">My letters</h2>
	<ul class="mt-2 divide-y divide-slate-200 text-sm">
		{#each data.mine as l (l.id)}
			<li class="flex justify-between py-2" data-testid="my-letter">
				<a class="text-brand-700 underline" href={`${base}/${l.id}/file`}>{l.subject}</a>
				<span class="text-slate-500">{ref(l.number)} · {l.issuedOn}</span>
			</li>
		{:else}
			<li class="py-2 text-slate-500">No letters yet.</li>
		{/each}
	</ul>
</section>

{#if data.issued}
	<section class="mt-6 max-w-3xl panel" aria-label="Issue a letter">
		<h2 class="section-title">Issue a letter</h2>
		<form method="GET" action={`${base}/new`} class="mt-3 grid gap-3 sm:grid-cols-2">
			<label class="block text-sm font-medium text-slate-700">
				Employee
				<select name="employeeId" required class={field}>
					{#each data.people as p (p.id)}<option value={p.id}>{p.name} ({p.code})</option>{/each}
				</select>
			</label>
			<label class="block text-sm font-medium text-slate-700">
				Template
				<select name="templateId" required class={field}>
					{#each data.templates as t (t.id)}<option value={t.id}>{t.name}</option>{/each}
				</select>
			</label>
			<div><Button type="submit">Prepare letter</Button></div>
		</form>
	</section>

	<section class="mt-6 max-w-3xl" aria-label="Issued letters">
		<h2 class="section-title">Issued letters</h2>
		<table class="mt-2 data-table">
			<thead>
				<tr><th class="py-2">Ref</th><th>Employee</th><th>Kind</th><th>Subject</th><th>Issued</th></tr>
			</thead>
			<tbody>
				{#each data.issued as l (l.id)}
					<tr class="border-t border-slate-200" data-testid="issued-letter">
						<td class="py-2">{ref(l.number)}</td>
						<td>{l.employee} <span class="text-slate-500">{l.code}</span></td>
						<td>{LETTER_KIND_LABELS[l.kind]}</td>
						<td><a class="text-brand-700 underline" href={`${base}/${l.id}/file`}>{l.subject}</a></td>
						<td>{l.issuedOn}</td>
					</tr>
				{:else}
					<tr><td colspan="5" class="py-2 text-slate-500">Nothing issued yet.</td></tr>
				{/each}
			</tbody>
		</table>
	</section>
{/if}
