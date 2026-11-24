<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	let session = $state('full');
	const field = 'mt-1 block w-full input';
	const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
	const when = (r: { startDate: string; endDate: string; session: string }) =>
		r.session !== 'full'
			? `${r.startDate} (${r.session})`
			: r.startDate === r.endDate
				? r.startDate
				: `${r.startDate} to ${r.endDate}`;
</script>

<svelte:head><title>Leave · {data.tenant.name}</title></svelte:head>

<h1 class="page-title">Leave</h1>
<div class="mt-4 max-w-3xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'requested' in form}<Alert tone="info" message="Leave requested." />{/if}
	{#if form && 'cancelled' in form}<Alert tone="info" message="Leave cancelled." />{/if}
</div>

<section class="mt-4 max-w-3xl panel" aria-label="My balance">
	<h2 class="section-title">
		My balance <span class="text-sm font-normal text-slate-500">FY {data.fy}</span>
	</h2>
	<dl class="mt-3 grid gap-2 text-sm sm:grid-cols-2">
		{#each data.balances as b (b.id)}
			<div class="flex justify-between gap-3 rounded-md bg-slate-50 px-3 py-2" data-testid="leave-balance">
				<dt class="text-slate-600">{b.name}</dt>
				<dd class="font-medium text-slate-900">
					{b.unlimited ? 'no limit' : `${days(b.available)} left`}{b.pending ? ` · ${b.pending} pending` : ''}
				</dd>
			</div>
		{/each}
	</dl>
</section>

{#if data.balances.length}
	<section class="mt-6 max-w-3xl panel" aria-label="Request leave">
		<h2 class="section-title">Request leave</h2>
		<form method="POST" action="?/request" enctype="multipart/form-data" class="mt-3 grid gap-3 sm:grid-cols-2">
			<label class="text-sm text-slate-700">
				Leave type
				<select name="leaveTypeId" required class={field}>
					{#each data.balances as b (b.id)}<option value={b.id}>{b.name}</option>{/each}
				</select>
			</label>
			<label class="text-sm text-slate-700">
				Day
				<select name="session" bind:value={session} class={field}>
					<option value="full">Full days</option>
					<option value="am">Morning half</option>
					<option value="pm">Afternoon half</option>
				</select>
			</label>
			<label class="text-sm text-slate-700">
				From
				<input name="startDate" type="date" required class={field} />
			</label>
			{#if session === 'full'}
				<label class="text-sm text-slate-700">
					To
					<input name="endDate" type="date" class={field} />
				</label>
			{/if}
			<label class="text-sm text-slate-700 sm:col-span-2">
				Reason
				<textarea name="reason" maxlength={500} class={field}></textarea>
			</label>
			<label class="text-sm text-slate-700 sm:col-span-2">
				Attachments <span class="text-slate-500">
					(optional, e.g. a prescription: PDF or image, up to 5 files, 10 MB)
				</span>
				<input
					name="files"
					type="file"
					multiple
					accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp"
					class="mt-1 block w-full text-sm"
				/>
			</label>
			<div class="sm:col-span-2"><Button type="submit">Request leave</Button></div>
		</form>
	</section>
{/if}

<section class="mt-6 max-w-3xl panel" aria-label="My requests">
	<h2 class="section-title">My requests</h2>
	{#if data.requests.length === 0}
		<p class="mt-3 text-sm text-slate-600">No leave requests yet.</p>
	{:else}
		<ul class="mt-3 divide-y divide-slate-100 text-sm">
			{#each data.requests as r (r.id)}
				<li class="flex items-center gap-3 py-2" data-testid="leave-request">
					<a href="/t/{data.tenant.slug}/approvals/leave/{r.id}" class="flex-1 hover:underline">
						{r.type} · {when(r)} · {days(r.days)} · {r.status}
					</a>
					{#if r.cancellable}
						<form method="POST" action="?/cancel">
							<input type="hidden" name="id" value={r.id} />
							<Button type="submit" variant="secondary" aria-label="Cancel {r.type} from {r.startDate}">Cancel</Button>
						</form>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</section>

<section class="mt-6 max-w-3xl panel" aria-label="Who is out">
	<h2 class="section-title">
		Who is out <span class="text-sm font-normal text-slate-500">next 30 days</span>
	</h2>
	{#if data.out.length === 0}
		<p class="mt-3 text-sm text-slate-600">Nobody is out.</p>
	{:else}
		<ul class="mt-3 divide-y divide-slate-100 text-sm">
			{#each data.out as o, i (i)}
				<li class="py-2" data-testid="out">
					{o.date} · {o.name} · {o.type}{o.session === 'full' ? '' : ` (${o.session})`}
				</li>
			{/each}
		</ul>
	{/if}
</section>
