<script lang="ts">
	import AnnouncementCard from '#lib/components/AnnouncementCard.svelte';
	import Card from '#lib/components/ui/Card.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const home = $derived(data.home);
	const base = $derived(`/t/${data.tenant.slug}`);
	const hours = (minutes: number) => (Math.round(minutes / 6) / 10).toFixed(1);
	const status = (s: string) => s.replaceAll('_', ' ');
</script>

<svelte:head><title>{data.tenant.name} · HRMS</title></svelte:head>

<h1 class="page-title">Welcome to {data.tenant.name}</h1>
{#if data.membership.status === 'ex_employee'}
	<p class="mt-2 text-slate-600">Your employment has ended. You can still download your documents and payslips.</p>
{/if}

{#if home}
	<p class="mt-1 text-sm text-slate-500">Today is {home.today}.</p>
	<div class="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
		{#if home.attendance}
			<Card title="Today" href={`${base}/attendance`}>
				{#if home.attendance.status}
					<p>
						<span class="font-medium capitalize">{status(home.attendance.status.status)}</span>
						· {hours(home.attendance.status.workedMinutes)} hours worked
					</p>
				{:else if home.attendance.punches.length}
					<p>
						Clocked in at {home.attendance.punches[0].at.toLocaleTimeString('en-GB', {
							timeZone: home.attendance.timeZone,
							hour: '2-digit',
							minute: '2-digit'
						})}.
					</p>
				{:else}
					<p>You have not clocked in today.</p>
				{/if}
				{#if home.attendance.shift}<p class="text-slate-500">Shift: {home.attendance.shift.name}</p>{/if}
			</Card>
		{/if}
		{#if home.leave}
			<Card title="Leave balance" href={`${base}/leave`}>
				{#if home.leave.length}
					<ul class="space-y-1" data-testid="leave-balance">
						{#each home.leave as l (l.id)}
							<li class="flex justify-between gap-2">
								<span>{l.name}</span><span class="font-medium">
									{l.unlimited ? 'Unlimited' : `${l.available} days`}
								</span>
							</li>
						{/each}
					</ul>
				{:else}
					<p>No leave types apply to you yet.</p>
				{/if}
			</Card>
		{/if}
		{#if home.meals}
			<Card title="Meals today" href={`${base}/meals`}>
				{#if !home.meals.working}
					<p>No meals are served today.</p>
				{:else if home.meals.meals.length}
					<ul class="space-y-1" data-testid="meals-today">
						{#each home.meals.meals as meal (meal.mealTypeId)}
							<li class="flex justify-between gap-2">
								<span>{meal.name}</span><span class="font-medium capitalize">{status(meal.status)}</span>
							</li>
						{/each}
					</ul>
					<p class="mt-2 text-slate-500">
						{home.meals.open ? 'You can still change today’s order.' : 'Today’s order is closed.'}
					</p>
				{:else}
					<p>No meals are set up yet.</p>
				{/if}
			</Card>
		{/if}
		{#if home.approvals.count}
			<Card title={`Waiting for you (${home.approvals.count})`} href={`${base}/approvals`}>
				<ul class="space-y-1" data-testid="approvals">
					{#each home.approvals.items as item (item.kind + item.id)}
						<li>
							<a class="text-brand-700 underline" href={`${base}/${item.link}`}>{item.title}</a> · {item.requestedBy}
						</li>
					{/each}
				</ul>
			</Card>
		{/if}
		{#if home.out}
			<Card title="Out today" href={`${base}/leave`}>
				{#if home.out.length}
					<ul class="space-y-1" data-testid="out-today">
						{#each home.out as o, i (i)}
							<li class="flex justify-between gap-2">
								<span>{o.name}</span><span class="text-slate-500">
									{o.type}{o.session === 'full' ? '' : ` · ${o.session.toUpperCase()}`}
								</span>
							</li>
						{/each}
					</ul>
				{:else}
					<p>Everyone is in today.</p>
				{/if}
			</Card>
		{/if}
		{#if home.headcount}
			<Card title="Headcount this month" href={`${base}/reports/headcount`}>
				<dl class="grid grid-cols-2 gap-2" data-testid="headcount">
					<dt class="text-slate-500">Now</dt>
					<dd class="font-medium">{home.headcount.end}</dd>
					<dt class="text-slate-500">Joined</dt>
					<dd class="font-medium">{home.headcount.joiners}</dd>
					<dt class="text-slate-500">Left</dt>
					<dd class="font-medium">{home.headcount.leavers}</dd>
					<dt class="text-slate-500">Attrition</dt>
					<dd class="font-medium">{home.headcount.attrition ?? '—'}{home.headcount.attrition === null ? '' : '%'}</dd>
				</dl>
			</Card>
		{/if}
		{#if home.probation?.length}
			<Card title="Probation ending" href={`${base}/lifecycle`}>
				<ul class="space-y-1" data-testid="probation">
					{#each home.probation as p (p.id)}
						<li class="flex justify-between gap-2">
							<span>{p.fullName}</span><span class={p.overdue ? 'text-red-700' : 'text-slate-500'}>
								{p.probationEndDate}
							</span>
						</li>
					{/each}
				</ul>
			</Card>
		{/if}
		{#if home.documents?.length}
			<Card title="Documents expiring">
				<ul class="space-y-1" data-testid="documents">
					{#each home.documents as d (d.id)}
						<li class="flex justify-between gap-2">
							<a class="text-brand-700 underline" href={`${base}/employees/${d.employeeId}`}>{d.name} · {d.title}</a>
							<span class={d.expired ? 'text-red-700' : 'text-slate-500'}>
								{d.expired ? 'Expired' : 'Expires'}
								{d.expiresOn}
							</span>
						</li>
					{/each}
				</ul>
			</Card>
		{/if}
		{#if home.payroll}
			<Card title="Last payroll run" href={`${base}/payroll?run=${home.payroll.id}`}>
				<p class="font-medium">
					{home.payroll.title ?? home.payroll.period} · <span class="capitalize">{home.payroll.status}</span>
				</p>
				<p class="text-slate-500" data-testid="payroll">
					{home.payroll.employees} employees · gross {home.payroll.gross} · net {home.payroll.net}
				</p>
			</Card>
		{/if}
	</div>

	{#if home.announcements.length}
		<section class="mt-6 max-w-3xl space-y-3" aria-label="Announcements">
			<h2 class="section-title">
				Announcements
				<a class="ml-2 text-sm font-normal text-brand-700 underline" href={`${base}/announcements`}>See all</a>
			</h2>
			{#each home.announcements as a (a.id)}<AnnouncementCard {a} slug={data.tenant.slug} />{/each}
		</section>
	{/if}
{/if}
