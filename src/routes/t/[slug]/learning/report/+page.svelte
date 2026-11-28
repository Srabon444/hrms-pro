<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const verified = $derived(form && 'verified' in form ? form.verified : null);
</script>

<svelte:head><title>Training report · {data.tenant.name}</title></svelte:head>

<a class="text-sm text-brand-700 underline" href="/t/{data.tenant.slug}/learning">Learning</a>
<h1 class="page-title mt-1">Training report</h1>

<section class="mt-4 max-w-4xl panel" aria-label="Completion">
	<h2 class="section-title">Completion</h2>
	{#if data.byCourse.length}
		<div class="mt-3 overflow-x-auto">
			<table class="w-full text-left text-sm">
				<thead class="text-slate-500">
					<tr>
						<th class="py-1 pr-3">Course</th><th class="pr-3">People</th><th class="pr-3">Certified</th><th
							class="pr-3"
						>
							Overdue
						</th><th>Done</th>
					</tr>
				</thead>
				<tbody class="divide-y divide-slate-100">
					{#each data.byCourse as c (c.id)}
						<tr data-testid="course-row">
							<td class="py-1 pr-3">{c.title}</td><td class="pr-3">{c.enrolled}</td><td class="pr-3">{c.passed}</td>
							<td class="pr-3">{c.overdue}</td><td>{c.rate}%</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{:else}
		<p class="mt-2 text-sm text-slate-600">Nobody you look after is on a course yet.</p>
	{/if}
</section>

<section class="mt-6 max-w-4xl panel" aria-label="Overdue">
	<h2 class="section-title">Overdue</h2>
	{#if data.overdue.length}
		<ul class="mt-3 divide-y divide-slate-100 text-sm">
			{#each data.overdue as o (o.id)}
				<li class="py-2" data-testid="overdue">
					<span class="font-medium">{o.name}</span> ({o.code}) · {o.course} · due {o.dueOn}{o.mandatory
						? ' · required'
						: ''}
				</li>
			{/each}
		</ul>
	{:else}
		<p class="mt-2 text-sm text-slate-600">Nothing is overdue.</p>
	{/if}
</section>

<section class="mt-6 max-w-4xl panel" aria-label="Certifications expiring">
	<h2 class="section-title">Certifications expired or expiring in 60 days</h2>
	{#if data.expiring.length}
		<ul class="mt-3 divide-y divide-slate-100 text-sm">
			{#each data.expiring as x (x.id)}
				<li class="py-2"><span class="font-medium">{x.name}</span> · {x.certification} · {x.expiresOn}</li>
			{/each}
		</ul>
	{:else}
		<p class="mt-2 text-sm text-slate-600">None.</p>
	{/if}
</section>

<section class="mt-6 max-w-4xl panel" aria-label="Check a certificate">
	<h2 class="section-title">Check a certificate</h2>
	<div class="mt-2 space-y-2">
		<Alert message={form?.message} />
		{#if verified}
			<Alert
				tone={verified.valid ? 'info' : 'error'}
				message={verified.valid
					? `Valid: ${verified.name} completed ${verified.course}.`
					: verified.expired
						? `Expired on ${verified.expiresOn}: ${verified.name} completed ${verified.course}.`
						: 'No certificate with that code.'}
			/>
		{/if}
	</div>
	<form method="POST" action="?/verify" class="mt-3 flex flex-wrap items-end gap-3">
		<label class="block grow text-sm font-medium text-slate-700">
			Verification code
			<input name="code" required maxlength="40" class="mt-1 block w-full input" />
		</label>
		<Button type="submit">Check</Button>
	</form>
</section>
