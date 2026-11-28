<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const input = 'mt-1 block w-full input';
	const LEVELS = ['1 · Beginner', '2 · Working', '3 · Skilled', '4 · Advanced', '5 · Expert'];
	const listed = $derived(new Set(data.mine.map((s) => s.skillId)));
</script>

<svelte:head><title>Skills · {data.tenant.name}</title></svelte:head>

<h1 class="page-title">Skills</h1>

<div class="mt-4 max-w-3xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'done' in form && typeof form.done === 'string'}<Alert tone="info" message={form.done} />{/if}
</div>

{#if data.isEmployee}
	<section class="mt-4 max-w-3xl panel" aria-label="My skills">
		<h2 class="section-title">My skills</h2>
		{#if data.mine.length}
			<ul class="mt-3 divide-y divide-slate-100 text-sm">
				{#each data.mine as s (s.id)}
					<li class="flex flex-wrap items-center justify-between gap-2 py-2" data-testid="my-skill">
						<span>
							<span class="font-medium text-slate-900">{s.name}</span>
							<span class="text-slate-500">
								· level {s.level} · {s.validated ? 'Validated' : 'Waiting for validation'}
							</span>
						</span>
						<form method="POST" action="?/drop">
							<input type="hidden" name="skillId" value={s.skillId} />
							<Button type="submit" variant="secondary">Remove</Button>
						</form>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="mt-2 text-sm text-slate-600">You have not listed any skills yet.</p>
		{/if}
		{#if data.catalogue.length}
			<form method="POST" action="?/set" class="mt-4 grid gap-3 sm:grid-cols-3">
				<label class="block text-sm font-medium text-slate-700 sm:col-span-2">
					Skill
					<select name="skillId" required class={input}>
						<option value="">Choose a skill</option>
						{#each data.catalogue as c (c.id)}
							<option value={c.id}>{c.name}{listed.has(c.id) ? ' (listed)' : ''}</option>
						{/each}
					</select>
				</label>
				<label class="block text-sm font-medium text-slate-700">
					Level
					<select name="level" required class={input}>
						{#each LEVELS as l, i (l)}<option value={i + 1}>{l}</option>{/each}
					</select>
				</label>
				<div><Button type="submit">Save skill</Button></div>
			</form>
		{:else}
			<p class="mt-2 text-sm text-slate-600">HR has not set up the skills catalogue yet.</p>
		{/if}
	</section>
{/if}

{#if data.pending.length}
	<section class="mt-6 max-w-3xl panel" aria-label="Waiting for validation">
		<h2 class="section-title">Waiting for your validation</h2>
		<ul class="mt-3 divide-y divide-slate-100 text-sm">
			{#each data.pending as p (p.id)}
				<li class="flex flex-wrap items-center justify-between gap-2 py-2" data-testid="pending-skill">
					<span><span class="font-medium text-slate-900">{p.employee}</span> · {p.name} · level {p.level}</span>
					<form method="POST" action="?/validate">
						<input type="hidden" name="id" value={p.id} />
						<input type="hidden" name="level" value={p.level} />
						<Button type="submit">Validate</Button>
					</form>
				</li>
			{/each}
		</ul>
	</section>
{/if}

{#if data.canManage}
	<section class="mt-6 max-w-3xl panel" aria-label="Catalogue">
		<h2 class="section-title">Catalogue</h2>
		<form method="POST" action="?/add" class="mt-3 flex flex-wrap items-end gap-3">
			<label class="block grow text-sm font-medium text-slate-700">
				New skill
				<input name="name" required maxlength="60" class={input} />
			</label>
			<Button type="submit">Add skill</Button>
		</form>
		<ul class="mt-3 divide-y divide-slate-100 text-sm">
			{#each data.catalogue as c (c.id)}
				<li class="flex items-center justify-between gap-2 py-2">
					<span>{c.name}</span>
					<form method="POST" action="?/remove">
						<input type="hidden" name="skillId" value={c.id} />
						<Button type="submit" variant="secondary">Remove</Button>
					</form>
				</li>
			{/each}
		</ul>
	</section>
{/if}
