<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const values = $derived((form && 'values' in form ? form.values : {}) as Record<string, string>);
	const STATUS: Record<string, string> = { scheduled: 'Scheduled', done: 'Done', cancelled: 'Cancelled' };
</script>

<svelte:head><title>1:1s · {data.tenant.name}</title></svelte:head>

<h1 class="page-title">1:1s</h1>

<div class="mt-4 max-w-3xl"><Alert message={form?.message} /></div>

{#if data.me && (data.myManager || data.reports.length)}
	<section class="mt-4 max-w-3xl panel" aria-label="Schedule a 1:1">
		<h2 class="section-title">Schedule a 1:1</h2>
		<form method="POST" action="?/schedule" class="mt-3 space-y-3">
			<label class="block text-sm font-medium text-slate-700">
				With
				<select name="employeeId" required class="mt-1 block w-full input">
					{#if data.myManager}
						<option value={data.me} selected={values.employeeId === data.me}>
							{data.myManager.name} (my manager)
						</option>
					{/if}
					{#each data.reports as r (r.id)}
						<option value={r.id} selected={values.employeeId === r.id}>{r.name}</option>
					{/each}
				</select>
			</label>
			<label class="block text-sm font-medium text-slate-700">
				Date
				<input
					type="date"
					name="scheduledFor"
					required
					value={values.scheduledFor ?? ''}
					class="mt-1 block w-full input"
				/>
			</label>
			<Button type="submit">Schedule</Button>
		</form>
	</section>
{/if}

{#snippet list(rows: typeof data.mine, label: string, empty: string)}
	<section class="mt-6 max-w-3xl" aria-label={label}>
		<h2 class="section-title">{label}</h2>
		<ul class="mt-2 space-y-2">
			{#each rows as r (r.id)}
				<li data-testid="one-on-one">
					<a class="panel block text-sm hover:bg-slate-50" href={`/t/${data.tenant.slug}/one-on-ones/${r.id}`}>
						<span class="font-medium text-slate-900">{r.managerName} and {r.employeeName}</span>
						<span class="block text-xs text-slate-500">{r.scheduledFor} · {STATUS[r.status]}</span>
					</a>
				</li>
			{:else}
				<li class="text-sm text-slate-600">{empty}</li>
			{/each}
		</ul>
	</section>
{/snippet}

{@render list(data.mine, 'My 1:1s', 'No 1:1s yet.')}
{#if data.others.length}{@render list(data.others, 'Other 1:1s', '')}{/if}
