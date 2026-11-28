<script lang="ts">
	import Markdown from '#lib/components/Markdown.svelte';
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import { money } from '#lib/money.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const input = 'mt-1 block w-full input';
	const cash = (v: number) => money(v, data.currency);
	const day = (d: Date | string) => new Date(d).toISOString().slice(0, 10);
	const REWARD: Record<string, string> = { pending: 'Pending', due: 'Due', paid: 'Paid', void: 'Void' };
</script>

<svelte:head><title>Internal jobs · {data.tenant.name}</title></svelte:head>

<h1 class="page-title">Internal jobs</h1>

<div class="mt-4 max-w-3xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'done' in form && typeof form.done === 'string'}<Alert tone="info" message={form.done} />{/if}
</div>

<section class="mt-4 max-w-3xl space-y-3" aria-label="Open jobs">
	{#each data.openings as o (o.id)}
		<article class="panel space-y-3" data-testid="job">
			<header>
				<h2 class="section-title">{o.title}</h2>
				<p class="text-sm text-slate-500">
					{[o.department, o.designation].filter(Boolean).join(' · ') || 'No department'}
					{#if o.match !== null}· {o.match}% skill match{/if}
					{#if o.referralBonus}· referral bonus {cash(o.referralBonus)}{/if}
				</p>
			</header>
			{#if o.skills.length}
				<ul class="flex flex-wrap gap-1 text-xs" aria-label="Skills wanted">
					{#each o.skills as s (s.name)}
						<li
							class="rounded-full px-2 py-0.5 {s.have
								? 'bg-emerald-50 text-emerald-800'
								: 'bg-slate-100 text-slate-700'}"
						>
							{s.name}{s.have ? ' ✓' : ''}
						</li>
					{/each}
				</ul>
			{/if}
			{#if o.description}<Markdown source={o.description} />{/if}
			{#if data.isEmployee}
				{#if o.applied}
					<p class="text-sm font-medium text-emerald-700">You applied for this job.</p>
				{:else}
					<form method="POST" action="?/apply" class="space-y-2">
						<input type="hidden" name="openingId" value={o.id} />
						<label class="flex items-center gap-2 text-sm">
							<input type="checkbox" name="tellManager" /> Tell my manager I applied
						</label>
						<Button type="submit">Apply</Button>
					</form>
				{/if}
				<details class="text-sm">
					<summary class="cursor-pointer text-brand-700">Refer someone</summary>
					<form method="POST" action="?/refer" class="mt-2 grid gap-3 sm:grid-cols-2">
						<input type="hidden" name="openingId" value={o.id} />
						<label class="block font-medium text-slate-700">
							Name
							<input name="fullName" required maxlength="120" class={input} />
						</label>
						<label class="block font-medium text-slate-700">
							Email
							<input name="email" type="email" required maxlength="254" class={input} />
						</label>
						<label class="block font-medium text-slate-700">
							Phone
							<input name="phone" type="tel" maxlength="40" pattern="[+\d][\d\s\-]*" class={input} />
						</label>
						<label class="block font-medium text-slate-700 sm:col-span-2">
							Why they fit
							<textarea name="note" maxlength="2000" rows="2" class={input}></textarea>
						</label>
						<div><Button type="submit">Send referral</Button></div>
					</form>
				</details>
			{/if}
		</article>
	{:else}
		<p class="panel text-sm text-slate-600">No internal jobs are open right now.</p>
	{/each}
</section>

{#if data.applications.length}
	<section class="mt-6 max-w-3xl panel" aria-label="My applications">
		<h2 class="section-title">My applications</h2>
		<ul class="mt-2 divide-y divide-slate-100 text-sm">
			{#each data.applications as a (a.id)}
				<li class="py-2" data-testid="application">{a.title} · {a.stage} · applied {day(a.at)}</li>
			{/each}
		</ul>
	</section>
{/if}

{#if data.referrals.length}
	<section class="mt-6 max-w-3xl panel" aria-label="My referrals">
		<h2 class="section-title">My referrals</h2>
		<ul class="mt-2 divide-y divide-slate-100 text-sm">
			{#each data.referrals as r (r.id)}
				<li class="py-2" data-testid="referral">
					{r.name} · {r.title} · {r.stage}
					{#if r.reward && r.amount}· bonus {cash(r.amount)} {REWARD[r.reward].toLowerCase()}{/if}
				</li>
			{/each}
		</ul>
	</section>
{/if}

{#if data.rewards}
	<section class="mt-6 max-w-3xl panel" aria-label="Referral rewards">
		<h2 class="section-title">Referral rewards</h2>
		{#if data.rewards.length}
			<table class="data-table mt-2">
				<thead><tr><th>Referrer</th><th>Hire</th><th>Amount</th><th>Status</th><th>Due</th><th></th></tr></thead>
				<tbody>
					{#each data.rewards as r (r.id)}
						<tr data-testid="reward">
							<td data-label="Referrer">{r.referrer}</td>
							<td data-label="Hire">{r.hire}</td>
							<td data-label="Amount">{cash(r.amount)}</td>
							<td data-label="Status">{REWARD[r.status]}</td>
							<td data-label="Due">{r.dueOn}</td>
							<td>
								{#if data.canPay && (r.status === 'due' || r.status === 'pending')}
									<div class="flex gap-2">
										{#if r.status === 'due'}
											<form method="POST" action="?/settle">
												<input type="hidden" name="rewardId" value={r.id} />
												<input type="hidden" name="to" value="paid" />
												<Button type="submit">Mark paid</Button>
											</form>
										{/if}
										<form method="POST" action="?/settle">
											<input type="hidden" name="rewardId" value={r.id} />
											<input type="hidden" name="to" value="void" />
											<Button type="submit" variant="secondary">Void</Button>
										</form>
									</div>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{:else}
			<p class="mt-2 text-sm text-slate-600">No referral rewards yet.</p>
		{/if}
	</section>
{/if}
