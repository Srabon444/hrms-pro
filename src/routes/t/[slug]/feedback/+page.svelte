<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const values = $derived((form && 'values' in form ? form.values : {}) as Record<string, string>);
	const when = (d: Date | string) => new Date(d).toISOString().slice(0, 10);
	const VISIBILITY: Record<string, string> = { shared: 'Shared with them', manager_only: 'Manager and HR only' };
	const STATUS: Record<string, string> = { open: 'Waiting', answered: 'Answered', declined: 'Declined' };
</script>

<svelte:head><title>Feedback · {data.tenant.name}</title></svelte:head>

<h1 class="page-title">Feedback</h1>

<div class="mt-4 max-w-3xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'done' in form && typeof form.done === 'string'}<Alert tone="info" message={form.done} />{/if}
</div>

{#snippet visibility()}
	<fieldset class="text-sm text-slate-700">
		<legend class="font-medium">Who can read it</legend>
		<label class="mt-1 flex items-center gap-2">
			<input type="radio" name="visibility" value="shared" checked /> Them, their manager and HR
		</label>
		<label class="mt-1 flex items-center gap-2">
			<input type="radio" name="visibility" value="manager_only" /> Only their manager and HR
		</label>
	</fieldset>
{/snippet}

{#if data.waiting.length}
	<section class="mt-4 max-w-3xl space-y-3" aria-label="Asked of you">
		<h2 class="section-title">Asked of you</h2>
		{#each data.waiting as w (w.id)}
			<article class="panel space-y-3" data-testid="feedback-request">
				<p class="text-sm text-slate-900"><span class="font-semibold">{w.requester}</span> asked for your feedback</p>
				{#if w.note}<p class="text-sm break-words whitespace-pre-line text-slate-700">{w.note}</p>{/if}
				<form method="POST" action="?/give" class="space-y-3">
					<input type="hidden" name="requestId" value={w.id} />
					<input type="hidden" name="toEmployeeId" value={w.aboutEmployeeId} />
					<label class="block text-sm font-medium text-slate-700">
						Your feedback
						<textarea name="text" required maxlength={2000} rows="3" class="mt-1 block w-full input"></textarea>
					</label>
					{@render visibility()}
					<Button type="submit">Answer</Button>
				</form>
				<form method="POST" action="?/decline">
					<input type="hidden" name="requestId" value={w.id} />
					<Button type="submit" variant="secondary">Decline</Button>
				</form>
			</article>
		{/each}
	</section>
{/if}

<section class="mt-4 max-w-3xl panel" aria-label="Give feedback">
	<h2 class="section-title">Give feedback</h2>
	<form method="POST" action="?/give" class="mt-3 space-y-3">
		<label class="block text-sm font-medium text-slate-700">
			About
			<select name="toEmployeeId" required class="mt-1 block w-full input">
				<option value="">Choose a colleague</option>
				{#each data.people as p (p.membershipId)}
					<option value={p.employeeId} selected={values.toEmployeeId === p.employeeId}>{p.name}</option>
				{/each}
			</select>
		</label>
		<label class="block text-sm font-medium text-slate-700">
			Feedback
			<textarea name="text" required maxlength={2000} rows="3" class="mt-1 block w-full input"
				>{values.requestId ? '' : (values.text ?? '')}</textarea
			>
		</label>
		{@render visibility()}
		<Button type="submit">Send feedback</Button>
	</form>
</section>

<section class="mt-6 max-w-3xl panel" aria-label="Ask for feedback">
	<h2 class="section-title">Ask for feedback</h2>
	<form method="POST" action="?/request" class="mt-3 space-y-3">
		<label class="block text-sm font-medium text-slate-700">
			Ask
			<select name="askedMembershipId" required class="mt-1 block w-full input">
				<option value="">Choose a colleague</option>
				{#each data.people as p (p.membershipId)}<option value={p.membershipId}>{p.name}</option>{/each}
			</select>
		</label>
		<label class="block text-sm font-medium text-slate-700">
			Note (optional)
			<textarea name="note" maxlength={500} rows="2" class="mt-1 block w-full input"></textarea>
		</label>
		<Button type="submit" variant="secondary">Ask</Button>
	</form>
	{#if data.asked.length}
		<ul class="mt-3 space-y-1 text-sm text-slate-700">
			{#each data.asked as a (a.id)}<li>{a.asked} · {STATUS[a.status]}</li>{/each}
		</ul>
	{/if}
</section>

<section class="mt-6 max-w-3xl space-y-3" aria-label="Feedback for you">
	<h2 class="section-title">Feedback for you</h2>
	{#each data.received as f (f.id)}
		<article class="panel" data-testid="feedback-received">
			<p class="text-xs text-slate-500">
				<span class="font-medium text-slate-800">{f.from}</span> · {when(f.createdAt)}
			</p>
			<p class="mt-1 text-sm break-words whitespace-pre-line text-slate-800">{f.text}</p>
		</article>
	{:else}
		<p class="text-sm text-slate-600">No feedback shared with you yet.</p>
	{/each}
</section>

{#if data.given.length}
	<section class="mt-6 max-w-3xl space-y-3" aria-label="Feedback you gave">
		<h2 class="section-title">Feedback you gave</h2>
		{#each data.given as g (g.id)}
			<article class="panel">
				<p class="text-xs text-slate-500">
					<span class="font-medium text-slate-800">{g.to}</span> · {when(g.createdAt)} · {VISIBILITY[g.visibility]}
				</p>
				<p class="mt-1 text-sm break-words whitespace-pre-line text-slate-800">{g.text}</p>
			</article>
		{/each}
	</section>
{/if}
