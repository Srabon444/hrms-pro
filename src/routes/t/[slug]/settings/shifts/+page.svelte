<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const input = 'rounded-md border border-slate-300 px-3 py-2 text-sm mt-1 block w-full';
	type Values = Partial<(typeof data.shifts)[number]>;
	const blank: Values = { graceMinutes: 15, halfDayMinutes: 240, fullDayMinutes: 480, active: true };
	const hhmm = (t?: string) => t?.slice(0, 5) ?? '';
</script>

<svelte:head><title>Shifts · {data.tenant.name}</title></svelte:head>

{#snippet fields(v: Values)}
	<label class="text-sm text-slate-700">
		Name
		<input name="name" required maxlength={60} value={v.name ?? ''} class={input} />
	</label>
	<label class="text-sm text-slate-700">
		Starts
		<input name="startTime" type="time" required value={hhmm(v.startTime)} class={input} />
	</label>
	<label class="text-sm text-slate-700">
		Ends (earlier than the start means the next day)
		<input name="endTime" type="time" required value={hhmm(v.endTime)} class={input} />
	</label>
	<label class="text-sm text-slate-700">
		Grace before late (minutes)
		<input name="graceMinutes" type="number" min="0" max="240" required value={v.graceMinutes} class={input} />
	</label>
	<label class="text-sm text-slate-700">
		Minutes for a half day
		<input name="halfDayMinutes" type="number" min="1" max="1440" required value={v.halfDayMinutes} class={input} />
	</label>
	<label class="text-sm text-slate-700">
		Minutes for a full day
		<input name="fullDayMinutes" type="number" min="1" max="1440" required value={v.fullDayMinutes} class={input} />
	</label>
	<label class="flex items-center gap-2 text-sm text-slate-700">
		<input type="checkbox" name="isDefault" checked={!!v.isDefault} />
		Default for people without a shift
	</label>
	<label class="flex items-center gap-2 text-sm text-slate-700">
		<input type="checkbox" name="active" checked={!!v.active} />
		Active
	</label>
{/snippet}

<h1 class="text-2xl font-semibold text-slate-900">Shifts</h1>
<p class="mt-1 max-w-3xl text-sm text-slate-600">
	Everyone works the default shift unless their profile assigns another one from a given date.
</p>

<div class="mt-4 max-w-3xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'saved' in form}<Alert tone="info" message="Shifts saved." />{/if}
</div>

{#each data.shifts as s (s.id)}
	<section class="mt-6 max-w-3xl rounded-xl bg-white p-6 ring-1 ring-slate-200" aria-label={s.name}>
		<h2 class="font-semibold text-slate-900">
			{s.name}
			<span class="ml-2 text-xs font-normal text-slate-500">
				{hhmm(s.startTime)}–{hhmm(s.endTime)}{s.isDefault ? ' · default' : ''}{s.active ? '' : ' · inactive'}
			</span>
		</h2>
		<form method="POST" action="?/update" class="mt-3 grid gap-3 sm:grid-cols-2">
			<input type="hidden" name="shiftId" value={s.id} />
			{@render fields(s)}
			<div class="sm:col-span-2"><Button type="submit">Save {s.name}</Button></div>
		</form>
	</section>
{/each}

<section class="mt-6 max-w-3xl rounded-xl bg-white p-6 ring-1 ring-slate-200" aria-label="New shift">
	<h2 class="font-semibold text-slate-900">New shift</h2>
	<form method="POST" action="?/create" class="mt-3 grid gap-3 sm:grid-cols-2">
		{@render fields(blank)}
		<div class="sm:col-span-2"><Button type="submit">Add shift</Button></div>
	</form>
</section>
