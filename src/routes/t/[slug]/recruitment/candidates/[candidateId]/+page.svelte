<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const v = $derived(data.view);
	const c = $derived(v.candidate);
	const stage = $derived(v.stages.find((s) => s.id === c.stageId));
	const targets = $derived(v.stages.filter((s) => s.id !== c.stageId && s.kind !== 'hired'));
	const input = 'mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm';
	const base = $derived(`/t/${data.tenant.slug}/recruitment`);
	const when = (d: Date | string) => new Date(d).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
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
