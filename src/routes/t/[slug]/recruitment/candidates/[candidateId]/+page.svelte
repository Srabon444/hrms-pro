<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import Field from '#lib/components/ui/Field.svelte';
	import { taka } from '#lib/money.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const v = $derived(data.view);
	const c = $derived(v.candidate);
	const stage = $derived(v.stages.find((s) => s.id === c.stageId));
	const targets = $derived(v.stages.filter((s) => s.id !== c.stageId && s.kind !== 'hired'));
	const input = 'mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm';
	const base = $derived(`/t/${data.tenant.slug}/recruitment`);
	const when = (d: Date | string) => new Date(d).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
	const moneyPattern = '\\d{1,8}(\\.\\d{1,2})?';
	const verdict: Record<string, string> = { strong_no: 'Strong no', no: 'No', yes: 'Yes', strong_yes: 'Strong yes' };
	const offerLabel: Record<string, string> = {
		pending: 'Waiting for an answer',
		accepted: 'Accepted',
		declined: 'Declined',
		withdrawn: 'Withdrawn'
	};
	const live = $derived(!c.employeeId && stage?.kind === 'active' && v.opening.status !== 'closed');
	const accepted = $derived(v.offers.some((o) => o.status === 'accepted'));
	const openOffer = $derived(v.offers.some((o) => o.status === 'pending' || o.status === 'accepted'));
</script>

<svelte:head><title>{c.fullName} · Recruitment · {data.tenant.name}</title></svelte:head>

<a class="text-sm text-indigo-700 underline" href={`${base}/${v.opening.id}`}>{v.opening.title}</a>
<h1 class="mt-2 text-2xl font-semibold text-slate-900">{c.fullName} · {stage?.name}</h1>

<div class="mt-4 max-w-3xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'done' in form}<Alert tone="info" message={form.done} />{/if}
</div>

<section class="mt-4 max-w-3xl rounded-xl bg-white p-6 ring-1 ring-slate-200" aria-label="Candidate details">
	<dl class="grid gap-2 text-sm sm:grid-cols-2">
		<div>
			<dt class="text-slate-500">Email</dt>
			<dd>{c.email ?? '—'}</dd>
		</div>
		<div>
			<dt class="text-slate-500">Phone</dt>
			<dd>{c.phone ?? '—'}</dd>
		</div>
		<div>
			<dt class="text-slate-500">Tags</dt>
			<dd>{c.tags.length ? c.tags.join(', ') : '—'}</dd>
		</div>
		<div>
			<dt class="text-slate-500">Resume</dt>
			<dd>
				{#if c.hasResume}
					<a class="text-indigo-700 underline" href={`${base}/candidates/${c.id}/resume`} download>{c.resumeName}</a>
				{:else}—{/if}
			</dd>
		</div>
		{#if c.employeeId}
			<div>
				<dt class="text-slate-500">Employee</dt>
				<dd>
					<a class="text-indigo-700 underline" href={`/t/${data.tenant.slug}/employees/${c.employeeId}`}>
						Open employee record
					</a>
				</dd>
			</div>
		{/if}
		{#if c.notes}<div class="sm:col-span-2">
				<dt class="text-slate-500">Notes</dt>
				<dd class="whitespace-pre-line">{c.notes}</dd>
			</div>{/if}
	</dl>
</section>

{#if data.canManage && !c.employeeId && targets.length}
	<section class="mt-6 max-w-3xl rounded-xl bg-white p-6 ring-1 ring-slate-200" aria-label="Move candidate">
		<h2 class="font-semibold text-slate-900">Move candidate</h2>
		<form method="POST" action="?/move" class="mt-3 grid gap-3 sm:grid-cols-2">
			<label class="block text-sm font-medium text-slate-700">
				Stage
				<select name="stageId" required class={input}>
					{#each targets as s (s.id)}<option value={s.id}>{s.name}</option>{/each}
				</select>
			</label>
			<label class="block text-sm font-medium text-slate-700">
				Note
				<input name="note" maxlength="300" class={input} />
			</label>
			<div><Button type="submit">Move</Button></div>
		</form>
	</section>
{/if}

<section class="mt-6 max-w-3xl" aria-label="Interviews">
	<h2 class="font-semibold text-slate-900">Interviews</h2>
	{#if v.interviews.length}
		<ul class="mt-2 space-y-3">
			{#each v.interviews as i (i.id)}
				<li class="rounded-xl bg-white p-4 ring-1 ring-slate-200" data-testid="interview">
					<p class="text-sm font-medium text-slate-900">
						{i.title} · {when(i.scheduledAt)} · {i.durationMinutes} min{i.status === 'cancelled' ? ' · Cancelled' : ''}
					</p>
					{#if i.location}<p class="text-sm text-slate-600">{i.location}</p>{/if}
					{#if i.status === 'scheduled' && !i.allIn}
						<p class="mt-1 text-xs text-slate-500">Feedback stays hidden until every interviewer has sent theirs.</p>
					{/if}
					<ul class="mt-2 space-y-1 text-sm">
						{#each i.panel as p (p.membershipId)}
							<li>
								{p.name} ·
								{#if p.rating !== null}
									{p.rating}/5 · {verdict[p.recommendation ?? '']}{p.comments ? ` · ${p.comments}` : ''}
								{:else}
									{p.submitted ? 'Feedback sent' : 'Waiting for feedback'}
								{/if}
							</li>
						{/each}
					</ul>
					{#if data.canManage && i.status === 'scheduled' && !i.panel.some((p) => p.submitted)}
						<form method="POST" action="?/cancel" class="mt-2">
							<input type="hidden" name="interviewId" value={i.id} />
							<Button type="submit" variant="secondary">Cancel interview</Button>
						</form>
					{/if}
				</li>
			{/each}
		</ul>
	{:else}
		<p class="mt-2 text-sm text-slate-600">No interviews yet.</p>
	{/if}
</section>

{#if data.canManage && live}
	<section class="mt-6 max-w-3xl rounded-xl bg-white p-6 ring-1 ring-slate-200" aria-label="Schedule interview">
		<h2 class="font-semibold text-slate-900">Schedule interview</h2>
		<form method="POST" action="?/schedule" class="mt-3 grid gap-3 sm:grid-cols-2">
			<Field label="Interview title" name="title" required maxlength={80} />
			<Field label="Date and time" name="scheduledAt" type="datetime-local" required />
			<Field
				label="Duration (minutes)"
				name="durationMinutes"
				type="number"
				min="15"
				max="480"
				step="5"
				value="60"
				required
			/>
			<Field label="Location or link" name="location" maxlength={300} />
			<fieldset class="sm:col-span-2">
				<legend class="text-sm font-medium text-slate-700">Interviewers</legend>
				<div class="mt-1 grid gap-1 sm:grid-cols-2">
					{#each data.interviewers as p (p.id)}
						<label class="flex items-center gap-2 text-sm">
							<input type="checkbox" name="interviewers" value={p.id} />
							{p.name}
						</label>
					{/each}
				</div>
			</fieldset>
			<div><Button type="submit">Schedule</Button></div>
		</form>
	</section>
{/if}

<section class="mt-6 max-w-3xl" aria-label="Offers">
	<h2 class="font-semibold text-slate-900">Offers</h2>
	{#if v.offers.length}
		<ul class="mt-2 space-y-2 text-sm">
			{#each v.offers as o (o.id)}
				<li class="rounded-xl bg-white p-4 ring-1 ring-slate-200" data-testid="offer">
					<p>
						৳{taka(o.monthlyGross)} a month · joins {o.joinDate}{o.expiresOn ? ` · answer by ${o.expiresOn}` : ''} ·
						{offerLabel[o.status]}
					</p>
					{#if o.note}<p class="text-slate-600">{o.note}</p>{/if}
					{#if data.canManage && o.status === 'pending'}
						<form method="POST" action="?/decide" class="mt-2 flex gap-2">
							<input type="hidden" name="offerId" value={o.id} />
							<Button type="submit" name="decision" value="accepted">Mark accepted</Button>
							<Button type="submit" name="decision" value="declined" variant="secondary">Mark declined</Button>
							<Button type="submit" name="decision" value="withdrawn" variant="secondary">Withdraw</Button>
						</form>
					{/if}
				</li>
			{/each}
		</ul>
	{:else}
		<p class="mt-2 text-sm text-slate-600">No offers yet.</p>
	{/if}
</section>

{#if data.canManage && live && !openOffer}
	<section class="mt-6 max-w-3xl rounded-xl bg-white p-6 ring-1 ring-slate-200" aria-label="Make offer">
		<h2 class="font-semibold text-slate-900">Make offer</h2>
		<form method="POST" action="?/offer" class="mt-3 grid gap-3 sm:grid-cols-2">
			<Field label="Monthly gross (৳)" name="monthlyGross" inputmode="decimal" pattern={moneyPattern} required />
			<Field label="Join date" name="joinDate" type="date" required />
			<Field label="Answer by" name="expiresOn" type="date" />
			<Field label="Note" name="note" maxlength={500} />
			<div><Button type="submit">Record offer</Button></div>
		</form>
	</section>
{/if}

{#if data.canHire && live && accepted}
	<section class="mt-6 max-w-3xl rounded-xl bg-white p-6 ring-1 ring-slate-200" aria-label="Hire">
		<h2 class="font-semibold text-slate-900">Hire</h2>
		<p class="mt-1 text-sm text-slate-600">
			Creates an onboarding employee record from the accepted offer and starts the onboarding checklist.
		</p>
		<form method="POST" action="?/hire" class="mt-3 space-y-3">
			{#if data.canInvite && c.email}
				<label class="flex items-center gap-2 text-sm">
					<input type="checkbox" name="invite" checked /> Invite {c.email} to sign in
				</label>
			{/if}
			<Button type="submit">Hire {c.fullName}</Button>
		</form>
	</section>
{/if}

<section class="mt-6 max-w-3xl" aria-label="History">
	<h2 class="font-semibold text-slate-900">History</h2>
	<ol class="mt-2 space-y-1 text-sm">
		{#each v.history as h, i (i)}
			<li>
				<span class="text-slate-500">{when(h.at)}</span>
				{h.from ? `${h.from} → ${h.to}` : `Added to ${h.to}`}{h.note ? ` · ${h.note}` : ''}
			</li>
		{/each}
	</ol>
</section>
