<script lang="ts">
	import Badge from '#lib/components/ui/Badge.svelte';
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import Field from '#lib/components/ui/Field.svelte';
	import LocaleFields from '#lib/components/LocaleFields.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<svelte:head><title>Platform · HRMS</title></svelte:head>

<main class="mx-auto max-w-4xl space-y-8 px-4 py-12">
	<div class="flex items-center">
		<h1 class="page-title">Organisations</h1>
		<a href="/" class="ml-auto text-sm text-brand-600 hover:underline">Home</a>
	</div>
	<Alert message={form?.message} />
	{#if form && 'created' in form}
		<Alert tone="info" message="Organisation {form.created} created. The owner invitation was emailed." />
	{/if}

	<section class="panel">
		<h2 class="section-title mb-4">New organisation</h2>
		<form method="POST" action="?/create" class="grid gap-4 sm:grid-cols-3">
			<Field label="Name" name="name" required maxlength={120} value={form && 'name' in form ? form.name : ''} />
			<Field
				label="URL name"
				name="slug"
				required
				pattern={'[a-z0-9][a-z0-9\\-]{1,40}'}
				value={form && 'slug' in form ? form.slug : ''}
			/>
			<Field
				label="Owner email"
				name="ownerEmail"
				type="email"
				required
				value={form && 'ownerEmail' in form ? form.ownerEmail : ''}
			/>
			<LocaleFields
				value={form && 'locale' in form ? (form.locale as typeof data.locale) : data.locale}
				timezones={data.timezones}
				currencies={data.currencies}
			/>
			<div class="sm:col-span-3"><Button type="submit">Create and invite owner</Button></div>
		</form>
	</section>

	<table class="data-table overflow-hidden rounded-xl bg-white ring-1 ring-slate-200">
		<thead class="bg-slate-50 text-slate-600">
			<tr>
				<th class="px-4 py-2">Name</th><th class="px-4 py-2">URL</th><th class="px-4 py-2">Members</th><th
					class="px-4 py-2"
				>
					Status
				</th><th class="px-4 py-2">Platform AI</th><th></th>
			</tr>
		</thead>
		<tbody class="divide-y divide-slate-200">
			{#each data.tenants as t (t.id)}
				<tr class="max-md:px-4">
					<td class="px-4 py-2">{t.name}</td>
					<td class="px-4 py-2 font-mono">/t/{t.slug}</td>
					<td class="px-4 py-2">{t.members}</td>
					<td class="px-4 py-2"><Badge status={t.status} /></td>
					<td class="px-4 py-2">
						<form method="POST" action="?/aiPlatform">
							<input type="hidden" name="tenantId" value={t.id} />
							<input type="hidden" name="ai" value={t.aiPlatform ? 'off' : 'on'} />
							<Button
								type="submit"
								variant="secondary"
								aria-label={`${t.aiPlatform ? 'Turn off' : 'Turn on'} platform AI for ${t.name}`}
							>
								{t.aiPlatform ? 'On · turn off' : 'Off · turn on'}
							</Button>
						</form>
					</td>
					<td class="px-4 py-2 text-right">
						<form method="POST" action="?/status">
							<input type="hidden" name="tenantId" value={t.id} />
							<input type="hidden" name="status" value={t.status === 'active' ? 'suspended' : 'active'} />
							<Button type="submit" variant={t.status === 'active' ? 'danger' : 'secondary'}>
								{t.status === 'active' ? 'Suspend' : 'Reactivate'}
							</Button>
						</form>
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
</main>
