<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import { money, unit } from '#lib/money.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const b = $derived(data.board);
	const input = 'input px-2 py-1';
	const values = $derived((form && 'values' in form && form.values) || {});
	const amount = '\\d{1,7}(\\.\\d{1,2})?';
	const STATE: Record<string, string> = {
		submitted: 'Waiting for approval',
		approved: 'Approved',
		rejected: 'Rejected',
		cancelled: 'Cancelled'
	};
	const ADVANCE: Record<string, string> = {
		requested: 'with finance',
		approved: 'approved, deducted from salary',
		closed: 'repaid',
		rejected: 'rejected by finance',
		cancelled: 'cancelled'
	};
	const place = (t: { country: string; city: string | null }) => (t.city ? `${t.city}, ${t.country}` : t.country);
</script>

<svelte:head><title>Travel · {data.tenant.name}</title></svelte:head>

<h1 class="page-title">Travel</h1>

<div class="mt-4 max-w-4xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'done' in form}<Alert tone="info" message={form.done} />{/if}
</div>

{#snippet trip(t: (typeof b.mine)[number], who: boolean)}
	<p class="font-medium text-slate-800">
		{who ? `${t.name} · ` : ''}{t.purpose}
		<span class="font-normal text-slate-400">· {place(t)}</span>
	</p>
	<p class="text-slate-600">
		{t.departOn} to {t.returnOn} ({t.days} day(s)) · estimated {money(t.estimatedCost, data.currency)}
		{#if t.advance}· advance {money(t.advance, data.currency)}{t.advanceStatus
				? ` (${ADVANCE[t.advanceStatus]})`
				: ''}{/if}
		· <span data-testid="trip-status">{STATE[t.status]}</span>
	</p>
	<p class="text-slate-500" data-testid="trip-money">
		{t.perDiem
			? `Per diem ${money(t.perDiem.daily, data.currency)} × ${t.perDiem.days} = ${money(t.perDiem.total, data.currency)}`
			: 'No per diem rate for this place'}
		{#if t.status === 'approved'}
			· claimed {money(t.claimed, data.currency)} · {t.settlement >= 0
				? `company owes ${money(t.settlement, data.currency)}`
				: `${money(-t.settlement, data.currency)} to pay back`}
		{/if}
	</p>
	{#if t.decisionNote}<p class="text-slate-500">Note: {t.decisionNote}</p>{/if}
{/snippet}

{#if b.toDecide.length}
	<section class="mt-6 max-w-4xl panel" aria-label="Trips to decide">
		<h2 class="section-title">Trips to decide</h2>
		<ul class="mt-3 divide-y divide-slate-100 text-sm">
			{#each b.toDecide as t (t.id)}
				<li class="py-3" data-testid="trip-to-decide">
					{@render trip(t, true)}
					<form method="POST" action="?/decide" class="mt-2 flex flex-wrap items-center gap-2">
						<input type="hidden" name="tripId" value={t.id} />
						<input name="note" maxlength="300" aria-label={`Note for ${t.name}`} class={`${input} min-w-0 flex-1`} />
						<Button type="submit" name="decision" value="approve">Approve trip of {t.name}</Button>
						<Button type="submit" name="decision" value="reject">Reject trip of {t.name}</Button>
					</form>
				</li>
			{/each}
		</ul>
	</section>
{/if}

{#if b.canRequest}
	<section class="mt-6 max-w-4xl panel" aria-label="New trip">
		<h2 class="section-title">New trip</h2>
		<form method="POST" action="?/request" class="mt-3 grid gap-3 text-sm sm:grid-cols-2">
			<label class="block text-slate-700 sm:col-span-2">
				Purpose
				<input name="purpose" required maxlength="200" value={values.purpose ?? ''} class={`${input} block w-full`} />
			</label>
			<label class="block text-slate-700">
				Country
				<input name="country" required maxlength="60" value={values.country ?? ''} class={`${input} block w-full`} />
			</label>
			<label class="block text-slate-700">
				City (optional)
				<input name="city" maxlength="60" value={values.city ?? ''} class={`${input} block w-full`} />
			</label>
			<label class="block text-slate-700">
				Leaving on
				<input
					name="departOn"
					type="date"
					required
					min={b.today}
					value={values.departOn ?? ''}
					class={`${input} block w-full`}
				/>
			</label>
			<label class="block text-slate-700">
				Back on
				<input
					name="returnOn"
					type="date"
					required
					min={b.today}
					value={values.returnOn ?? ''}
					class={`${input} block w-full`}
				/>
			</label>
			<label class="block text-slate-700">
				Estimated cost ({unit(data.currency)})
				<input
					name="estimatedCost"
					required
					inputmode="decimal"
					pattern={amount}
					value={values.estimatedCost ?? ''}
					class={`${input} block w-full`}
				/>
			</label>
			<label class="block text-slate-700">
				Advance needed ({unit(data.currency)}, optional)
				<input
					name="advance"
					inputmode="decimal"
					pattern={amount}
					value={values.advance ?? ''}
					class={`${input} block w-full`}
				/>
			</label>
			<p class="text-xs text-slate-500 sm:col-span-2">
				An approved advance goes to finance as a salary advance, repaid from the salary of the month you are back. Claim
				your trip expenses against the trip; what you claim minus the advance is what is settled.
			</p>
			<div class="sm:col-span-2"><Button type="submit">Send for approval</Button></div>
		</form>
	</section>
{/if}

{#if b.mine.length}
	<section class="mt-6 max-w-4xl panel" aria-label="My trips">
		<h2 class="section-title">My trips</h2>
		<ul class="mt-3 divide-y divide-slate-100 text-sm">
			{#each b.mine as t (t.id)}
				<li class="py-3" data-testid="my-trip">
					{@render trip(t, false)}
					{#if t.status === 'submitted'}
						<form method="POST" action="?/cancel" class="mt-2">
							<input type="hidden" name="tripId" value={t.id} />
							<Button type="submit">Cancel {t.purpose}</Button>
						</form>
					{/if}
				</li>
			{/each}
		</ul>
	</section>
{/if}

{#if b.others.length}
	<section class="mt-6 max-w-4xl panel" aria-label="Trips">
		<h2 class="section-title">Trips</h2>
		<ul class="mt-3 divide-y divide-slate-100 text-sm">
			{#each b.others as t (t.id)}
				<li class="py-3" data-testid="trip">{@render trip(t, true)}</li>
			{/each}
		</ul>
	</section>
{/if}

<section class="mt-6 max-w-4xl panel" aria-label="Per diem rates">
	<h2 class="section-title">Per diem rates</h2>
	<p class="mt-1 text-xs text-slate-500">
		Daily allowance in {unit(data.currency)}. A city rate wins over the country rate. Enter foreign rates already
		converted.
	</p>
	{#if b.rates.length}
		<ul class="mt-3 divide-y divide-slate-100 text-sm">
			{#each b.rates as r (r.id)}
				<li class="flex flex-wrap items-center justify-between gap-2 py-2" data-testid="rate">
					<span>{place(r)} · {money(r.dailyAmount, data.currency)} a day</span>
					{#if b.canManage}
						<form method="POST" action="?/removeRate">
							<input type="hidden" name="rateId" value={r.id} />
							<Button type="submit">Remove rate for {place(r)}</Button>
						</form>
					{/if}
				</li>
			{/each}
		</ul>
	{:else}
		<p class="mt-2 text-sm text-slate-600">No rates yet.</p>
	{/if}
	{#if b.canManage}
		<form method="POST" action="?/rate" class="mt-3 flex flex-wrap items-end gap-2 text-sm">
			<label class="text-slate-700">
				Country
				<input name="country" required maxlength="60" class={`${input} block w-36`} />
			</label>
			<label class="text-slate-700">
				City (optional)
				<input name="city" maxlength="60" class={`${input} block w-36`} />
			</label>
			<label class="text-slate-700">
				Daily amount
				<input
					name="dailyAmount"
					required
					inputmode="decimal"
					pattern={'\\d{1,6}(\\.\\d{1,2})?'}
					class={`${input} block w-28`}
				/>
			</label>
			<Button type="submit">Save rate</Button>
		</form>
	{/if}
</section>
