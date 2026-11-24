<script lang="ts">
	import { money } from '#lib/money.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head><title>My payslips · {data.tenant.name}</title></svelte:head>

<h1 class="page-title">My payslips</h1>

{#if data.payslips.length}
	<ul class="mt-6 max-w-xl divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
		{#each data.payslips as p (p.id)}
			<li class="flex items-center justify-between px-4 py-3 text-sm" data-testid="my-payslip">
				<span class="text-slate-800">{p.period}{p.name ? ` · ${p.name}` : ''} · Net {money(p.net, p.currency)}</span>
				<a href="/t/{data.tenant.slug}/payslips/{p.id}/pdf" class="text-brand-700 hover:underline">
					Download PDF of {p.period}{p.name ? ` ${p.name}` : ''}
				</a>
			</li>
		{/each}
	</ul>
{:else}
	<p class="mt-6 text-sm text-slate-500">No payslips yet. They appear here once payroll is paid.</p>
{/if}
