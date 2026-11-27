<script lang="ts">
	import Attachments from '#lib/components/Attachments.svelte';
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '$app/forms';
	import { whileBusy } from '#lib/busy.ts';
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const field = 'mt-1 block w-full input';
	let kind = $state('regularization');
	let importing = $state(false);
	let punching = $state(false);
	const place = () =>
		new Promise<GeolocationPosition | null>((resolve) =>
			navigator.geolocation
				? navigator.geolocation.getCurrentPosition(resolve, () => resolve(null), {
						enableHighAccuracy: true,
						timeout: 10_000,
						maximumAge: 60_000
					})
				: resolve(null)
		);
	const punchWithPlace: SubmitFunction = async ({ formData }) => {
		punching = true;
		const at = data.locationRule === 'off' ? null : await place();
		if (at) {
			formData.set('lat', String(at.coords.latitude));
			formData.set('lng', String(at.coords.longitude));
			formData.set('accuracy', String(at.coords.accuracy));
		}
		return async ({ update }) => {
			punching = false;
			await update();
		};
	};
	const rowErrors = $derived(form && 'rows' in form ? (form.rows as { line: number; message: string }[]) : []);
	const tz = $derived(data.now?.timeZone ?? data.month?.timeZone ?? 'UTC');
	const time = (d: Date | null, zone?: string | null) =>
		d
			? new Intl.DateTimeFormat('en-GB', {
					timeZone: zone ?? tz,
					hour: '2-digit',
					minute: '2-digit',
					hourCycle: 'h23'
				}).format(d)
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
		timeZone: string | null;
	}) =>
		[
			d.status ? label[d.status] : 'Not in yet',
			d.firstIn ? `${time(d.firstIn, d.timeZone)}–${time(d.lastOut, d.timeZone)}` : '',
			d.workedMinutes ? hours(d.workedMinutes) : '',
			d.lateMinutes ? `${d.lateMinutes} min late` : ''
		]
			.filter(Boolean)
			.join(' · ');
</script>

<svelte:head><title>Attendance · {data.tenant.name}</title></svelte:head>

<h1 class="page-title">Attendance</h1>
<div class="mt-4 max-w-3xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'punched' in form}
		<Alert
			tone="info"
			message={form.outsideSite ? 'Punch recorded. It was away from a work site, so HR can see it.' : 'Punch recorded.'}
		/>
	{/if}
	{#if form && 'added' in form}<Alert tone="info" message="Punch added." />{/if}
	{#if form && 'kioskPin' in form}<Alert tone="info" message={form.kioskPin} />{/if}
	{#if form && 'requested' in form}<Alert tone="info" message="Request sent." />{/if}
	{#if form && 'cancelledRequest' in form}<Alert tone="info" message="Request cancelled." />{/if}
	{#if form && 'imported' in form && form.imported}
		<Alert
			tone="info"
			message="{form.imported.added} punches imported, {form.imported.skipped} already recorded or repeated."
		/>
	{/if}
	{#if rowErrors.length}
		<ul class="rounded-xl bg-white p-4 text-sm ring-1 ring-slate-200" aria-label="Import errors">
			{#each rowErrors as r (r.line)}
				<li data-testid="import-error"><span class="font-medium">Line {r.line}:</span> {r.message}</li>
			{/each}
		</ul>
	{/if}
</div>

{#if data.now}
	{@const n = data.now}
	<section class="mt-4 max-w-3xl panel" aria-label="Today">
		<h2 class="section-title">
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
						{time(p.at)}{p.kind === 'break_start' ? ' break' : p.kind === 'break_end' ? ' back' : ''}{p.source === 'web'
							? ''
							: ` (${p.source})`}{p.outsideSite ? ' · away from site' : ''}
					</li>
				{/each}
			</ul>
		{/if}
		{#if n.onBreak}<p class="mt-2 text-sm text-amber-700" data-testid="on-break">On a break.</p>{/if}
		{#if data.canPunch}
			<form method="POST" action="?/punch" class="mt-4 flex flex-wrap gap-2" use:enhance={punchWithPlace}>
				{#if n.onBreak}
					<Button type="submit" name="kind" value="break_end" disabled={punching}>End break</Button>
				{:else}
					<Button type="submit" name="kind" value="" disabled={punching}>
						{n.clockedIn ? 'Punch out' : 'Punch in'}
					</Button>
					{#if n.clockedIn}
						<Button type="submit" name="kind" value="break_start" variant="secondary" disabled={punching}>
							Start break
						</Button>
					{/if}
				{/if}
			</form>
			{#if data.locationRule !== 'off'}
				<p class="mt-2 text-xs text-slate-500">
					Your location is checked against the work sites when you punch. Punching from the office network works without
					it.
				</p>
			{/if}
		{/if}
	</section>
{/if}

{#if data.kioskPin}
	<section class="mt-6 max-w-3xl panel" aria-label="Kiosk PIN">
		<h2 class="section-title">Kiosk PIN</h2>
		<p class="mt-1 text-sm text-slate-600" data-testid="kiosk-pin-state">
			{data.kioskPin.set
				? 'You have a kiosk PIN. Set a new one any time; nobody can see it, not even HR.'
				: 'Set a PIN to punch at the office kiosk with your employee code. Nobody can see it, not even HR.'}
		</p>
		<form method="POST" action="?/kioskPin" class="mt-3 grid gap-3 sm:grid-cols-2" autocomplete="off">
			<label class="text-sm text-slate-700">
				New PIN (6 to 8 digits)
				<input
					name="pin"
					type="password"
					inputmode="numeric"
					pattern={'\\d{6,8}'}
					minlength={6}
					maxlength={8}
					required
					autocomplete="new-password"
					class="input mt-1 block w-full"
				/>
			</label>
			<label class="text-sm text-slate-700">
				Type it again
				<input
					name="confirm"
					type="password"
					inputmode="numeric"
					minlength={6}
					maxlength={8}
					required
					autocomplete="new-password"
					class="input mt-1 block w-full"
				/>
			</label>
			<div class="flex flex-wrap gap-2 sm:col-span-2">
				<Button type="submit">Save PIN</Button>
				{#if data.kioskPin.set}
					<Button type="submit" variant="secondary" formaction="?/kioskPinRemove" formnovalidate>Remove PIN</Button>
				{/if}
			</div>
		</form>
	</section>
{/if}

{#if data.canPunch}
	<section class="mt-6 max-w-3xl panel" aria-label="Ask for a change">
		<h2 class="section-title">Ask for a change</h2>
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
					<li class="flex flex-wrap items-start gap-3 py-2">
						<div class="min-w-0 flex-1">
							<span class="text-slate-800" data-testid="attendance-request">
								{r.title} · {r.status}{r.approvedMinutes !== null ? ` · ${r.approvedMinutes} min approved` : ''}
							</span>
							{#if r.status === 'pending' || data.requestFiles[r.id]?.length}
								<Attachments
									slug={data.tenant.slug}
									attachments={{ files: data.requestFiles[r.id] ?? [], canEdit: r.status === 'pending' }}
									{form}
									action="?/requestFiles"
									ownerId={r.id}
									title="Proof"
									compact
								/>
							{/if}
						</div>
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
	<section class="mt-6 max-w-3xl panel" aria-label="My month">
		<div class="flex flex-wrap items-end justify-between gap-3">
			<h2 class="section-title">My month</h2>
			<form method="GET" class="flex flex-wrap items-end gap-2">
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
	<section class="mt-6 max-w-3xl panel" aria-label="Team">
		<div class="flex flex-wrap items-end justify-between gap-3">
			<h2 class="section-title">Team</h2>
			<form method="GET" class="flex flex-wrap items-end gap-2">
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
					{#if t.outsideSite}<span class="text-amber-700" data-testid="away-flag">Away from site</span>{/if}
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
				<div class="flex flex-wrap items-end"><Button type="submit" variant="secondary">Add punch</Button></div>
			</form>
			<form
				method="POST"
				action="?/importPunches"
				enctype="multipart/form-data"
				use:enhance={whileBusy((b) => (importing = b))}
				class="mt-4 flex flex-wrap items-end gap-3"
			>
				<label class="text-sm text-slate-700">
					Device punches (CSV with employee_code,timestamp)
					<input name="file" type="file" accept=".csv,text/csv" required class="mt-1 block text-sm" />
				</label>
				<Button type="submit" variant="secondary" disabled={importing}>
					{importing ? 'Importing…' : 'Import punches'}
				</Button>
			</form>
		{/if}
	</section>
{/if}
