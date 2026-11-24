<script lang="ts">
	import { enhance } from '$app/forms';
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import { money, taka, unit } from '#lib/money.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const b = $derived(data.board);
	const active = $derived(b.categories.filter((c) => c.active));
	const input = 'input px-2 py-1';
	const base = $derived(`/t/${data.tenant.slug}/expenses`);
	let rows = $state(1);
	const statusLabel: Record<string, string> = {
		submitted: 'Waiting for approval',
		approved: 'Approved',
		rejected: 'Rejected',
		paid: 'Paid',
		cancelled: 'Cancelled'
	};
</script>

<svelte:head><title>Expenses · {data.tenant.name}</title></svelte:head>

{#snippet items(claim: (typeof b.mine)[number])}
	<ul class="mt-1 text-slate-500">
		{#each claim.items as i (i.id)}
			<li>
				{i.spentOn} · {i.category} · {i.description} · {money(i.amount, data.currency)}
				{#if i.receiptName}
					· <a class="text-brand-700 underline" href={`${base}/receipts/${i.id}`}>Receipt for {i.description}</a>
				{/if}
			</li>
		{/each}
	</ul>
{/snippet}

<h1 class="page-title">Expenses</h1>

<div class="mt-4 max-w-4xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'done' in form}<Alert tone="info" message={form.done} />{/if}
</div>

{#if b.toApprove.length}
	<section class="mt-6 max-w-4xl panel" aria-label="Claims to approve">
		<h2 class="section-title">Claims to approve</h2>
		<ul class="mt-3 divide-y divide-slate-100 text-sm">
			{#each b.toApprove as c (c.id)}
				<li class="py-3" data-testid="expense-to-approve">
					<p class="text-slate-800">{c.name} · {c.title} · {money(c.total, data.currency)}</p>
					{@render items(c)}
					<form method="POST" action="?/decide" class="mt-2 flex flex-wrap items-center gap-2">
						<input type="hidden" name="claimId" value={c.id} />
						<select name="payVia" aria-label={`How to pay ${c.title}`} class={input}>
							<option value="payroll">With salary</option>
							<option value="direct">Directly</option>
						</select>
						<input name="note" maxlength="300" aria-label={`Note for ${c.title}`} class={`${input} w-56`} />
						<Button type="submit" name="decision" value="approve">Approve {c.title}</Button>
						<Button type="submit" name="decision" value="reject">Reject {c.title}</Button>
					</form>
				</li>
			{/each}
		</ul>
	</section>
{/if}

{#if b.toPay.length}
	<section class="mt-6 max-w-4xl panel" aria-label="Claims to pay">
		<h2 class="section-title">Claims to pay</h2>
		<ul class="mt-3 divide-y divide-slate-100 text-sm">
			{#each b.toPay as c (c.id)}
				<li class="py-3" data-testid="expense-to-pay">
					<p class="text-slate-800">{c.name} · {c.title} · {money(c.total, data.currency)}</p>
					{@render items(c)}
					<form method="POST" action="?/pay" class="mt-2">
						<input type="hidden" name="claimId" value={c.id} />
						<Button type="submit">Mark {c.title} paid</Button>
					</form>
				</li>
			{/each}
		</ul>
	</section>
{/if}

{#if b.canSubmit}
	<section class="mt-6 max-w-4xl panel" aria-label="New claim">
		<h2 class="section-title">New claim</h2>
		{#if active.length}
			<form
				method="POST"
				action="?/submit"
				enctype="multipart/form-data"
				use:enhance={() =>
					async ({ result, update }) => {
						await update({ reset: result.type === 'success' });
						if (result.type === 'success') rows = 1;
					}}
				class="mt-3 space-y-3 text-sm"
			>
				<label class="block text-slate-700">
					Title
					<input name="title" required maxlength="120" class={`${input} block w-full`} />
				</label>
				{#each { length: rows } as _, i (i)}
					<fieldset class="grid gap-2 rounded-md border border-slate-200 p-3 sm:grid-cols-5">
						<legend class="px-1 text-slate-600">Item {i + 1}</legend>
						<label class="text-slate-700">
							Category
							<select name={`items.${i}.categoryId`} required class={`${input} block w-full`}>
								<option value="">Choose…</option>
								{#each active as c (c.id)}
									<option value={c.id}>
										{c.name}{c.claimLimit ? ` (up to ${money(c.claimLimit, data.currency)})` : ''}
									</option>
								{/each}
							</select>
						</label>
						<label class="text-slate-700">
							Date
							<input name={`items.${i}.spentOn`} type="date" required max={b.today} class={`${input} block w-full`} />
						</label>
						<label class="text-slate-700">
							Description
							<input name={`items.${i}.description`} required maxlength="200" class={`${input} block w-full`} />
						</label>
						<label class="text-slate-700">
							Amount ({unit(data.currency)})
							<input
								name={`items.${i}.amount`}
								required
								inputmode="decimal"
								pattern={'\\d{1,7}(\\.\\d{1,2})?'}
								class={`${input} block w-full`}
							/>
						</label>
						<label class="text-slate-700">
							Receipt
							<input
								name={`items.${i}.receipt`}
								type="file"
								accept="application/pdf,image/png,image/jpeg,image/webp"
								class="block w-full text-xs"
							/>
						</label>
					</fieldset>
				{/each}
				<p class="text-slate-500">Receipts: PDF or image, 10 MB in total.</p>
				<div class="flex gap-2">
					{#if rows < data.maxItems}
						<Button type="button" onclick={() => rows++}>Add item</Button>
					{/if}
					<Button type="submit">Send claim</Button>
				</div>
			</form>
		{:else}
			<p class="mt-2 text-sm text-slate-500">No expense categories are set up yet.</p>
		{/if}
	</section>
{/if}

{#if b.mine.length}
	<section class="mt-6 max-w-4xl panel" aria-label="My claims">
		<h2 class="section-title">My claims</h2>
		<ul class="mt-3 divide-y divide-slate-100 text-sm">
			{#each b.mine as c (c.id)}
				<li class="py-3" data-testid="my-expense">
					<p class="text-slate-800">
						{c.title} · {money(c.total, data.currency)} · {statusLabel[c.status]}{c.payVia === 'payroll' &&
						c.status === 'approved'
							? ' (with salary)'
							: ''}
					</p>
					{@render items(c)}
					{#if c.status === 'submitted'}
						<form method="POST" action="?/cancel" class="mt-2">
							<input type="hidden" name="claimId" value={c.id} />
							<Button type="submit">Cancel {c.title}</Button>
						</form>
					{/if}
				</li>
			{/each}
		</ul>
	</section>
{/if}

{#if b.canManage}
	<section class="mt-6 max-w-4xl panel" aria-label="Categories">
		<h2 class="section-title">Categories</h2>
		<ul class="mt-3 space-y-2 text-sm">
			{#each b.categories as c (c.id)}
				<li>
					<form method="POST" action="?/category" class="flex flex-wrap items-center gap-2">
						<input type="hidden" name="id" value={c.id} />
						<input name="name" required maxlength="60" value={c.name} aria-label="Category name" class={input} />
						<input
							name="claimLimit"
							inputmode="decimal"
							pattern={'\\d{1,7}(\\.\\d{1,2})?'}
							value={c.claimLimit === null ? '' : taka(c.claimLimit)}
							aria-label={`Limit per claim for ${c.name}`}
							placeholder="No limit"
							class={`${input} w-32`}
						/>
						<label class="text-slate-700"><input type="checkbox" name="active" checked={c.active} /> Active</label>
						<Button type="submit">Save {c.name}</Button>
					</form>
				</li>
			{/each}
			<li>
				<form method="POST" action="?/category" class="flex flex-wrap items-center gap-2">
					<input name="name" required maxlength="60" aria-label="New category name" class={input} />
					<input
						name="claimLimit"
						inputmode="decimal"
						pattern={'\\d{1,7}(\\.\\d{1,2})?'}
						aria-label="Limit per claim"
						placeholder="No limit"
						class={`${input} w-32`}
					/>
					<input type="hidden" name="active" value="on" />
					<Button type="submit">Add category</Button>
				</form>
			</li>
		</ul>
	</section>
{/if}
