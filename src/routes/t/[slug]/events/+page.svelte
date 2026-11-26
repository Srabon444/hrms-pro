<script lang="ts">
	import AudienceFields from '#lib/components/AudienceFields.svelte';
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import Field from '#lib/components/ui/Field.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const values = $derived((form && 'values' in form ? form.values : {}) as Record<string, string>);
	const ANSWER: Record<string, string> = { yes: 'Going', maybe: 'Maybe', no: 'Not going' };
	const sent = (k: string) => values[k] ?? '';
	let startDate = $state(sent('startDate'));
	let startTime = $state(sent('startTime'));
	const when = (e: { startDate: string; endDate: string; startTime: string | null; endTime: string | null }) =>
		`${e.startDate}${e.endDate !== e.startDate ? ` to ${e.endDate}` : ''}${e.startTime ? `, ${e.startTime}–${e.endTime}` : ', all day'}`;
</script>

<svelte:head><title>Events · {data.tenant.name}</title></svelte:head>

<h1 class="page-title">Events</h1>

<div class="mt-4 max-w-3xl"><Alert message={form?.message} /></div>

{#if data.manager}
	<section class="mt-4 max-w-3xl panel" aria-label="New event">
		<h2 class="section-title">New event</h2>
		<form method="POST" action="?/save" class="mt-3 grid gap-3 sm:grid-cols-2">
			<Field label="Title" name="title" required maxlength={160} value={values.title ?? ''} />
			<Field label="Location (optional)" name="location" maxlength={200} value={values.location ?? ''} />
			<label class="block text-sm font-medium text-slate-700">
				Starts on
				<input
					name="startDate"
					type="date"
					required
					min={data.today}
					bind:value={startDate}
					class="mt-1 block w-full input"
				/>
			</label>
			<Field label="Ends on (optional)" name="endDate" type="date" min={startDate} value={values.endDate ?? ''} />
			<label class="block text-sm font-medium text-slate-700">
				Start time (leave empty for all day)
				<input name="startTime" type="time" bind:value={startTime} class="mt-1 block w-full input" />
			</label>
			<Field label="End time" name="endTime" type="time" required={!!startTime} value={values.endTime ?? ''} />
			<AudienceFields
				label="Who is invited"
				audience={values.audience || 'all'}
				departmentId={values.departmentId ?? ''}
				branchId={values.branchId ?? ''}
				departments={data.departments}
				branches={data.branches}
			/>
			<label class="block text-sm font-medium text-slate-700 sm:col-span-2">
				Description (optional)
				<textarea name="description" maxlength={2000} rows="3" class="mt-1 block w-full input"
					>{values.description ?? ''}</textarea
				>
			</label>
			<div><Button type="submit">Add event</Button></div>
		</form>
	</section>
{/if}

<section class="mt-6 max-w-3xl space-y-3" aria-label="Events">
	<h2 class="section-title">{data.manager ? 'Upcoming and recent' : 'Upcoming'}</h2>
	{#each data.rows as e (e.id)}
		<article class="panel" data-testid="event" class:opacity-60={e.past}>
			<div class="flex flex-wrap items-start justify-between gap-2">
				<div>
					<h3 class="font-semibold text-slate-900">{e.title}</h3>
					<p class="text-sm text-slate-600">{when(e)}{e.location ? ` · ${e.location}` : ''}</p>
					<p class="text-xs text-slate-500">
						{e.target ?? 'Everyone'} · {e.going} going{e.mine ? ` · You: ${ANSWER[e.mine]}` : ''}
					</p>
				</div>
				{#if data.manager}
					<form method="POST" action="?/delete">
						<input type="hidden" name="eventId" value={e.id} />
						<Button type="submit" variant="secondary">Delete</Button>
					</form>
				{/if}
			</div>
			{#if e.description}<p class="mt-2 text-sm whitespace-pre-line text-slate-700">{e.description}</p>{/if}
			{#if !e.past}
				<form method="POST" action="?/rsvp" class="mt-3 flex flex-wrap gap-2">
					<input type="hidden" name="eventId" value={e.id} />
					{#each Object.entries(ANSWER) as [value, label] (value)}
						<Button type="submit" name="response" {value} variant={e.mine === value ? 'primary' : 'secondary'}>
							{label}
						</Button>
					{/each}
				</form>
			{/if}
		</article>
	{:else}
		<p class="text-sm text-slate-600">No events coming up.</p>
	{/each}
</section>
