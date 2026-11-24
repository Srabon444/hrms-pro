<script lang="ts">
	import PolicyFields from '#lib/components/PolicyFields.svelte';
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const base = $derived(`/t/${data.tenant.slug}/policies`);
	const values = $derived(
		(form && 'values' in form
			? form.values
			: {
					title: data.policy.title,
					description: data.policy.description,
					requiresAck: data.policy.requiresAck,
					active: data.policy.active
				}) as Record<string, string | boolean>
	);
	const pending = $derived(data.people.filter((p) => !p.acknowledgedAt).length);
</script>

<svelte:head><title>{data.policy.title} · {data.tenant.name}</title></svelte:head>

<a class="text-sm text-brand-700 underline" href={base}>All policies</a>
<h1 class="page-title mt-2">{data.policy.title}</h1>
<p class="text-sm text-slate-600">
	Version {data.policy.version}, published {data.policy.publishedOn} ·
	<a class="text-brand-700 underline" href={`${base}/${data.policy.id}/file`}>{data.policy.fileName}</a>
</p>

<div class="mt-4 max-w-3xl"><Alert message={form?.message} /></div>

<section class="mt-4 max-w-3xl panel" aria-label="Edit policy">
	<h2 class="section-title">Edit policy</h2>
	<form method="POST" action="?/save" enctype="multipart/form-data" class="mt-3 grid gap-3 sm:grid-cols-2">
		<PolicyFields v={values} fileRequired={false} />
		<p class="text-xs text-slate-500 sm:col-span-2">
			Uploading a new file starts version {data.policy.version + 1}; everyone has to acknowledge it again.
		</p>
		<div class="sm:col-span-2"><Button type="submit">Save</Button></div>
	</form>
</section>

{#if data.policy.requiresAck}
	<section class="mt-6 max-w-3xl" aria-label="Acknowledgements">
		<h2 class="section-title">
			Acknowledgements for version {data.policy.version}
			<span class="text-sm font-normal text-slate-600" data-testid="policy-pending">{pending} pending</span>
		</h2>
		<table class="mt-2 data-table">
			<thead><tr><th class="py-2">Employee</th><th>Acknowledged</th></tr></thead>
			<tbody>
				{#each data.people as p (p.id)}
					<tr class="border-t border-slate-200" data-testid="policy-person">
						<td class="py-2">{p.name} <span class="text-slate-500">{p.code}</span></td>
						<td>{p.acknowledgedAt ? new Date(p.acknowledgedAt).toLocaleString() : 'Pending'}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</section>
{/if}
