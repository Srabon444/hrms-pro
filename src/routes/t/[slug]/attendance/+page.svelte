<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const field = 'mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm';
	let kind = $state('regularization');
	const tz = $derived(data.now?.timeZone ?? data.month?.timeZone ?? 'UTC');
	const time = (d: Date | null) =>
		d
			? new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(
					d
				)
			: '—';
	const hours = (m: number) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
	const label: Record<string, string> = {
		present: 'Present',
		late: 'Late',
		half_day: 'Half day',
		absent: 'Absent',
		on_leave: 'On leave',
		holiday: 'Holiday',
		weekend: 'Weekend',
		wfh: 'Working from home'
	};
	const line = (d: {
		status: string | null;
		firstIn: Date | null;
		lastOut: Date | null;
		workedMinutes: number | null;
		lateMinutes: number | null;
	}) =>
		[
			d.status ? label[d.status] : 'Not in yet',
			d.firstIn ? `${time(d.firstIn)}–${time(d.lastOut)}` : '',
			d.workedMinutes ? hours(d.workedMinutes) : '',
			d.lateMinutes ? `${d.lateMinutes} min late` : ''
		]
			.filter(Boolean)
			.join(' · ');
</script>

<svelte:head><title>Attendance · {data.tenant.name}</title></svelte:head>

<h1 class="text-2xl font-semibold text-slate-900">Attendance</h1>
<div class="mt-4 max-w-3xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'punched' in form}<Alert tone="info" message="Punch recorded." />{/if}
	{#if form && 'added' in form}<Alert tone="info" message="Punch added." />{/if}
	{#if form && 'requested' in form}<Alert tone="info" message="Request sent." />{/if}
	{#if form && 'cancelledRequest' in form}<Alert tone="info" message="Request cancelled." />{/if}
</div>

{#if data.now}
	{@const n = data.now}
	<section class="mt-4 max-w-3xl rounded-xl bg-white p-6 ring-1 ring-slate-200" aria-label="Today">
		<h2 class="font-semibold text-slate-900">
			Today <span class="text-sm font-normal text-slate-500">{n.day}</span>
		</h2>
		{#if n.shift}
			<p class="mt-1 text-sm text-slate-600">
				{n.shift.name} · {n.shift.startTime.slice(0, 5)}–{n.shift.endTime.slice(0, 5)}
			</p>
		{/if}
		<p class="mt-2 text-sm text-slate-800" data-testid="today-status">
			{n.status ? label[n.status.status] : 'Not in yet'}{n.status?.workedMinutes
				? ` · ${hours(n.status.workedMinutes)}`
				: ''}
		</p>
		{#if n.punches.length}
			<ul class="mt-2 flex flex-wrap gap-2 text-sm">
				{#each n.punches as p (p.at)}
					<li class="rounded bg-slate-100 px-2 py-1" data-testid="punch">
						{time(p.at)}{p.source === 'web' ? '' : ` (${p.source})`}
					</li>
				{/each}
			</ul>
		{/if}
		{#if data.canPunch}
			<form method="POST" action="?/punch" class="mt-4">
				<Button type="submit">{n.punches.length % 2 ? 'Punch out' : 'Punch in'}</Button>
			</form>
		{/if}
	</section>
{/if}

{#if data.canPunch}
	<section class="mt-6 max-w-3xl rounded-xl bg-white p-6 ring-1 ring-slate-200" aria-label="Ask for a change">
		<h2 class="font-semibold text-slate-900">Ask for a change</h2>
		<form method="POST" action="?/request" class="mt-3 grid gap-3 sm:grid-cols-2">
			<label class="text-sm text-slate-700">
				Request
				<select name="kind" bind:value={kind} class={field}>
					<option value="regularization">Missed punch</option>
					<option value="wfh">Work from home</option>
					<option value="overtime">Overtime</option>
				</select>
			</label>
			{#if kind === 'regularization'}
				<label class="text-sm text-slate-700">
					When you were in or out
					<input name="at" type="datetime-local" required class={field} />
				</label>
			{:else}
				<label class="text-sm text-slate-700">
					Day
					<input name="date" type="date" required max={kind === 'overtime' ? data.today : undefined} class={field} />
				</label>
			{/if}
			{#if kind === 'overtime'}
				<label class="text-sm text-slate-700">
					Minutes
					<input name="minutes" type="number" min={15} max={1440} step={15} required class={field} />
				</label>
			{/if}
			<label class="text-sm text-slate-700 sm:col-span-2">
				Reason
				<textarea name="reason" required maxlength={500} class={field}></textarea>
			</label>
			<div><Button type="submit">Send request</Button></div>
		</form>
		{#if data.requests.length}
			<ul class="mt-4 divide-y divide-slate-100 text-sm">
				{#each data.requests as r (r.id)}
					<li class="flex items-center gap-3 py-2">
						<span class="flex-1 text-slate-800" data-testid="attendance-request">
							{r.title} · {r.status}{r.approvedMinutes !== null ? ` · ${r.approvedMinutes} min approved` : ''}
						</span>
						{#if r.cancellable}
							<form method="POST" action="?/cancelRequest">
								<input type="hidden" name="requestId" value={r.id} />
								<Button type="submit" variant="secondary" aria-label="Cancel {r.title}">Cancel</Button>
							</form>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>
{/if}

{#if data.month}
	{@const mo = data.month}
	<section class="mt-6 max-w-3xl rounded-xl bg-white p-6 ring-1 ring-slate-200" aria-label="My month">
		<div class="flex flex-wrap items-end justify-between gap-3">
			<h2 class="font-semibold text-slate-900">My month</h2>
			<form method="GET" class="flex items-end gap-2">
				<label class="text-sm text-slate-700">
					Month
					<input name="month" type="month" value={mo.month} max={mo.today.slice(0, 7)} class={field} />
				</label>
				<Button type="submit" variant="secondary">Show</Button>
			</form>
		</div>
		{#if mo.days.length}
			<ul class="mt-3 divide-y divide-slate-100 text-sm">
				{#each mo.days as d (d.date)}
					<li class="flex gap-3 py-2" data-testid="attendance-day">
						<span class="w-24 text-slate-500">{d.date}</span>
						<span class="text-slate-800">{line(d)}</span>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="mt-3 text-sm text-slate-500">Nothing recorded this month.</p>
		{/if}
	</section>
{/if}

{#if data.team}
	<section class="mt-6 max-w-3xl rounded-xl bg-white p-6 ring-1 ring-slate-200" aria-label="Team">
		<div class="flex flex-wrap items-end justify-between gap-3">
			<h2 class="font-semibold text-slate-900">Team</h2>
			<form method="GET" class="flex items-end gap-2">
				<label class="text-sm text-slate-700">
					Day
					<input name="date" type="date" value={data.date} max={data.today} class={field} />
				</label>
				<Button type="submit" variant="secondary">Show</Button>
			</form>
		</div>
		<ul class="mt-3 divide-y divide-slate-100 text-sm">
			{#each data.team as t (t.id)}
				<li class="flex gap-3 py-2" data-testid="team-day">
					<span class="w-48 truncate text-slate-800">{t.fullName}</span>
					<span class="text-slate-600">{line(t)}</span>
				</li>
			{/each}
		</ul>
		{#if data.canManage}
			<form method="POST" action="?/manual" class="mt-4 grid gap-3 sm:grid-cols-3">
				<label class="text-sm text-slate-700">
					Person
					<select name="employeeId" required class={field}>
						{#each data.team as t (t.id)}<option value={t.id}>{t.fullName}</option>{/each}
					</select>
				</label>
				<label class="text-sm text-slate-700">
					Punch time
					<input name="at" type="datetime-local" required class={field} />
				</label>
				<div class="flex items-end"><Button type="submit" variant="secondary">Add punch</Button></div>
			</form>
		{/if}
	</section>
{/if}
