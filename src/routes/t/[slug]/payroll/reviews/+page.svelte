<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import Field from '#lib/components/ui/Field.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const base = $derived(`/t/${data.tenant.slug}/payroll/reviews`);
	const values = $derived((form && 'values' in form ? form.values : {}) as Record<string, string>);
</script>

<svelte:head><title>Pay reviews · {data.tenant.name}</title></svelte:head>

<h1 class="page-title">Pay reviews</h1>

<div class="mt-4 max-w-3xl"><Alert message={form?.message} /></div>

{#if data.manage}
	<section class="mt-4 max-w-3xl panel" aria-label="New pay review">
		<h2 class="section-title">Start a pay review</h2>
		<form method="POST" action="?/create" class="mt-3 grid gap-3 sm:grid-cols-3">
			<div class="sm:col-span-3">
				<Field label="Name" name="name" required maxlength={80} value={values.name ?? ''} />
			</div>
			<Field
				label="New salaries start on"
				name="effectiveFrom"
				type="date"
				required
				value={values.effectiveFrom ?? ''}
			/>
			<Field
				label="Guideline raise % (optional)"
				name="guideline"
				inputmode="decimal"
				pattern={'\\d{1,3}(\\.\\d{1,2})?'}
				value={values.guideline ?? ''}
			/>
			<p class="text-xs text-slate-500 sm:col-span-3">
				Managers propose a raise for each person they look after. Applying the review sends every proposal to finance as
				a salary change waiting for approval; nothing changes until finance approves it.
			</p>
			<div class="sm:col-span-3"><Button type="submit">Start pay review</Button></div>
		</form>
	</section>
{/if}

<section class="mt-6 max-w-3xl panel" aria-label="Reviews">
	<h2 class="section-title">Reviews</h2>
	{#if data.cycles.length}
		<ul class="mt-3 divide-y divide-slate-100 text-sm">
			{#each data.cycles as c (c.id)}
				<li class="flex flex-wrap items-center justify-between gap-2 py-2" data-testid="pay-review">
					<a class="font-medium text-brand-700 underline" href="{base}/{c.id}">{c.name}</a>
					<span class="text-slate-500">
						From {c.effectiveFrom}{c.guidelineBp ? ` · guideline ${c.guidelineBp / 100}%` : ''} · {c.status === 'open'
							? 'Open'
							: 'Closed'}
					</span>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="mt-2 text-sm text-slate-600">No pay reviews yet.</p>
	{/if}
</section>
