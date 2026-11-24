<script lang="ts">
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const input = 'input mt-1 block';
</script>

<svelte:head><title>Data export · {data.tenant.name}</title></svelte:head>

<h1 class="page-title">Data export</h1>
<p class="mt-1 max-w-3xl text-sm text-slate-600">
	Download your organisation's records as CSV files. Dated records export up to 366 days at a time, and every download
	is recorded in the audit log.
</p>

{#if data.datasets.length === 0}
	<p class="mt-6 text-sm text-slate-600">Your roles do not include any records that can be exported.</p>
{/if}

{#each data.datasets as d (d.key)}
	<section class="mt-4 max-w-3xl panel" aria-label={d.label}>
		<h2 class="section-title">{d.label}</h2>
		<form
			method="GET"
			action="/t/{data.tenant.slug}/settings/data-export/file"
			class="mt-3 flex flex-wrap items-end gap-3"
		>
			<input type="hidden" name="dataset" value={d.key} />
			{#if d.dated}
				<label class="text-sm text-slate-700">
					From
					<input name="from" type="date" required class={input} />
				</label>
				<label class="text-sm text-slate-700">
					To
					<input name="to" type="date" required class={input} />
				</label>
			{/if}
			<Button type="submit" variant="secondary">Download {d.label.toLowerCase()}</Button>
		</form>
	</section>
{/each}
