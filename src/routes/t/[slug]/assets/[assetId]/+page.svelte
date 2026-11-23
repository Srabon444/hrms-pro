<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import Field from '#lib/components/ui/Field.svelte';
	import { ASSET_STATUS_LABELS, CONDITION_LABELS } from '#lib/asset-labels.ts';
	import { taka } from '#lib/money.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const v = $derived(data.view);
	const a = $derived(v.asset);
	const input = 'mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm';
	const money = '\\d{1,9}(\\.\\d{1,2})?';
	let outcome = $state('returned');
</script>

<svelte:head><title>{a.tag} · Assets · {data.tenant.name}</title></svelte:head>

<a class="text-sm text-indigo-700 underline" href={`/t/${data.tenant.slug}/assets`}>Assets</a>
<h1 class="mt-2 text-2xl font-semibold text-slate-900">{a.tag} · {a.name}</h1>
<p class="text-sm text-slate-600">
	{a.category} · {ASSET_STATUS_LABELS[a.status]}{a.serial ? ` · S/N ${a.serial}` : ''}{a.purchaseDate
		? ` · bought ${a.purchaseDate}`
		: ''}{a.purchaseCost !== null ? ` · ৳${taka(a.purchaseCost)}` : ''}
</p>

<div class="mt-4 max-w-4xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'done' in form}<Alert tone="info" message={form.done} />{/if}
</div>

{#if v.canManage && a.status === 'available'}
	<section class="mt-4 max-w-4xl rounded-xl bg-white p-6 ring-1 ring-slate-200" aria-label="Hand over">
		<h2 class="font-semibold text-slate-900">Hand over</h2>
		<form method="POST" action="?/assign" class="mt-3 grid gap-3 sm:grid-cols-4">
			<label class="block text-sm font-medium text-slate-700">
				Employee
				<select name="employeeId" required class={input}>
					{#each v.people as e (e.id)}<option value={e.id}>{e.name}</option>{/each}
				</select>
			</label>
			<Field label="Handed over on" name="assignedOn" type="date" required max={v.today} value={v.today} />
			<label class="block text-sm font-medium text-slate-700">
				Condition
				<select name="condition" required class={input}>
					{#each Object.entries(CONDITION_LABELS) as [value, label] (value)}
						<option {value} selected={value === 'good'}>{label}</option>
					{/each}
				</select>
			</label>
			<div><Button type="submit">Hand over</Button></div>
		</form>
	</section>
{/if}

{#if v.canManage && v.holder}
	<section class="mt-4 max-w-4xl rounded-xl bg-white p-6 ring-1 ring-slate-200" aria-label="Take back">
		<h2 class="font-semibold text-slate-900">Take back or write off</h2>
		<form method="POST" action="?/return" class="mt-3 grid gap-3 sm:grid-cols-3">
			<label class="block text-sm font-medium text-slate-700">
				Outcome
				<select name="outcome" bind:value={outcome} class={input}>
					<option value="returned">Returned</option>
					<option value="written_off">Lost or not returned</option>
				</select>
			</label>
			<Field label="Date" name="returnedOn" type="date" required max={v.today} value={v.today} />
			{#if outcome === 'returned'}
				<label class="block text-sm font-medium text-slate-700">
					Condition on return
					<select name="condition" required class={input}>
						{#each Object.entries(CONDITION_LABELS) as [value, label] (value)}
							<option {value} selected={value === 'good'}>{label}</option>
						{/each}
					</select>
				</label>
			{/if}
			<Field label="Charge to employee (৳)" name="charge" inputmode="decimal" pattern={money} />
			<Field label="Note" name="note" maxlength={300} required={outcome === 'written_off'} />
			<div><Button type="submit">Close out</Button></div>
		</form>
	</section>
{/if}

<section class="mt-6 max-w-4xl" aria-label="History">
	<h2 class="font-semibold text-slate-900">History</h2>
	{#if v.history.length}
		<ul class="mt-2 space-y-1 text-sm">
			{#each v.history as h (h.id)}
				<li data-testid="asset-history">
					{h.name} · from {h.assignedOn} ({CONDITION_LABELS[h.conditionOut]})
					{#if h.returnedOn}
						· {h.outcome === 'returned'
							? `returned ${h.returnedOn} (${CONDITION_LABELS[h.conditionIn ?? '']})`
							: `written off ${h.returnedOn}`}{h.charge ? ` · charged ৳${taka(h.charge)}` : ''}{h.note
							? ` · ${h.note}`
							: ''}
					{:else}
						· still with them
					{/if}
				</li>
			{/each}
		</ul>
	{:else}
		<p class="mt-2 text-sm text-slate-600">Never handed out.</p>
	{/if}
</section>

{#if v.canManage}
	<section class="mt-6 max-w-4xl rounded-xl bg-white p-6 ring-1 ring-slate-200" aria-label="Edit asset">
		<h2 class="font-semibold text-slate-900">Edit asset</h2>
		<form method="POST" action="?/save" class="mt-3 grid gap-3 sm:grid-cols-3">
			<Field label="Tag" name="tag" required maxlength={20} pattern={'[A-Za-z0-9][A-Za-z0-9\\-]{1,19}'} value={a.tag} />
			<Field label="Name" name="name" required maxlength={120} value={a.name} />
			<Field label="Category" name="category" required maxlength={60} value={a.category} />
			<Field label="Serial number" name="serial" maxlength={120} value={a.serial} />
			<Field label="Purchase date" name="purchaseDate" type="date" max={v.today} value={a.purchaseDate ?? ''} />
			<Field
				label="Purchase cost (৳)"
				name="purchaseCost"
				inputmode="decimal"
				pattern={money}
				value={a.purchaseCost !== null ? taka(a.purchaseCost) : ''}
			/>
			{#if a.status !== 'assigned'}
				<label class="block text-sm font-medium text-slate-700">
					Status
					<select name="status" class={input}>
						{#if a.status === 'lost'}<option value="" selected>{ASSET_STATUS_LABELS.lost}</option>{/if}
						{#each ['available', 'repair', 'retired'] as value (value)}
							<option {value} selected={a.status === value}>{ASSET_STATUS_LABELS[value]}</option>
						{/each}
					</select>
				</label>
			{/if}
			<Field label="Notes" name="notes" maxlength={500} value={a.notes} />
			<div><Button type="submit">Save asset</Button></div>
		</form>
	</section>
{/if}
