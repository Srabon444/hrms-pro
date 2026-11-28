<script lang="ts">
	import Attachments from '#lib/components/Attachments.svelte';
	import Markdown from '#lib/components/Markdown.svelte';
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const input = 'mt-1 block w-full input';
	const base = $derived(`/t/${data.tenant.slug}/learning`);
	const values = $derived((form && 'values' in form ? form.values : {}) as Record<string, string>);
	const dots = (...parts: unknown[]) => parts.filter((p) => p || p === 0).join(' · ');
	const STATUS = { assigned: 'In progress', passed: 'Passed', failed: 'Out of attempts' } as const;
</script>

<svelte:head><title>Learning · {data.tenant.name}</title></svelte:head>

<div class="flex flex-wrap items-center justify-between gap-2">
	<h1 class="page-title">Learning</h1>
	{#if data.canReport}<a class="text-sm text-brand-700 underline" href="{base}/report">Training report</a>{/if}
</div>

<div class="mt-4 max-w-3xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'done' in form && typeof form.done === 'string'}<Alert tone="info" message={form.done} />{/if}
</div>

{#if data.isEmployee}
	<section class="mt-4 max-w-3xl panel" aria-label="My courses">
		<h2 class="section-title">My courses</h2>
		{#if data.mine.length}
			<ul class="mt-3 divide-y divide-slate-100 text-sm">
				{#each data.mine as e (e.id)}
					<li class="flex flex-wrap items-center justify-between gap-2 py-2" data-testid="my-course">
						<span>
							<a class="font-medium text-brand-700 underline" href="{base}/{e.courseId}">{e.title}</a>
							<span class="text-slate-500">
								· {dots(
									STATUS[e.status],
									`${e.done}/${e.lessons} lessons`,
									e.dueOn && e.status !== 'passed' && `due ${e.dueOn}`,
									e.mandatory && 'required',
									e.expiresOn && `renew by ${e.expiresOn}`
								)}
							</span>
							{#if e.overdue}<span class="text-red-700">Overdue</span>{/if}
						</span>
						{#if e.certificateId}
							<a class="text-brand-700 underline" href="{base}/certificates/{e.certificateId}" data-sveltekit-reload>
								Certificate
							</a>
						{/if}
					</li>
				{/each}
			</ul>
		{:else}
			<p class="mt-2 text-sm text-slate-600">You are not on any course yet.</p>
		{/if}
	</section>
{/if}

<section class="mt-6 max-w-3xl panel" aria-label="Course catalogue">
	<h2 class="section-title">Course catalogue</h2>
	{#if data.catalogue.length}
		<ul class="mt-3 divide-y divide-slate-100 text-sm">
			{#each data.catalogue as c (c.id)}
				<li class="flex flex-wrap items-start justify-between gap-2 py-2">
					<div class="min-w-0">
						<a class="font-medium text-brand-700 underline" href="{base}/{c.id}">{c.title}</a>
						{#if c.description}<Markdown class="mt-1 text-slate-600" source={c.description} />{/if}
					</div>
					{#if data.isEmployee}
						<form method="POST" action="?/enrol">
							<input type="hidden" name="courseId" value={c.id} />
							<Button type="submit" variant="secondary">Start course</Button>
						</form>
					{/if}
				</li>
			{/each}
		</ul>
	{:else}
		<p class="mt-2 text-sm text-slate-600">No other courses are open right now.</p>
	{/if}
</section>

{#if data.isEmployee}
	<section class="mt-6 max-w-3xl panel" aria-label="My certifications">
		<h2 class="section-title">My certifications</h2>
		<p class="mt-1 text-sm text-slate-600">Certificates you earned outside this company, with their expiry.</p>
		{#if data.certifications.length}
			<ul class="mt-3 divide-y divide-slate-100 text-sm">
				{#each data.certifications as c (c.id)}
					<li class="py-2" data-testid="certification">
						<div class="flex flex-wrap items-center justify-between gap-2">
							<span>
								<span class="font-medium text-slate-900">{c.name}</span>
								<span class="text-slate-500">
									· {dots(c.issuer, `issued ${c.issuedOn}`, c.expiresOn && `expires ${c.expiresOn}`)}
								</span>
							</span>
							<form method="POST" action="?/uncertify">
								<input type="hidden" name="id" value={c.id} />
								<Button type="submit" variant="secondary">Remove</Button>
							</form>
						</div>
						<Attachments
							slug={data.tenant.slug}
							attachments={{ files: c.files, canEdit: true }}
							{form}
							action="?/certificationFiles"
							ownerId={c.id}
							title="Certificate file"
							compact
						/>
					</li>
				{/each}
			</ul>
		{/if}
		<form method="POST" action="?/certify" class="mt-4 grid gap-3 sm:grid-cols-2">
			<label class="block text-sm font-medium text-slate-700">
				Certification
				<input name="name" required maxlength="160" value={values.name ?? ''} class={input} />
			</label>
			<label class="block text-sm font-medium text-slate-700">
				Issued by
				<input name="issuer" maxlength="160" value={values.issuer ?? ''} class={input} />
			</label>
			<label class="block text-sm font-medium text-slate-700">
				Issued on
				<input type="date" name="issuedOn" required value={values.issuedOn ?? ''} class={input} />
			</label>
			<label class="block text-sm font-medium text-slate-700">
				Expires on
				<input type="date" name="expiresOn" value={values.expiresOn ?? ''} class={input} />
			</label>
			<div><Button type="submit">Add certification</Button></div>
		</form>
	</section>
{/if}

{#if data.manage}
	<section class="mt-6 max-w-3xl panel" aria-label="Manage courses">
		<h2 class="section-title">Manage courses</h2>
		{#if data.manage.length}
			<ul class="mt-3 divide-y divide-slate-100 text-sm">
				{#each data.manage as c (c.id)}
					<li class="py-2">
						<a class="font-medium text-brand-700 underline" href="{base}/{c.id}">{c.title}</a>
						<span class="text-slate-500">· {c.status} · {c.lessons} lessons · {c.enrolled} people</span>
					</li>
				{/each}
			</ul>
		{/if}
		<form method="POST" action="?/create" class="mt-4 grid gap-3 sm:grid-cols-2">
			<label class="block text-sm font-medium text-slate-700 sm:col-span-2">
				Course title
				<input name="title" required maxlength="160" value={values.title ?? ''} class={input} />
			</label>
			<label class="block text-sm font-medium text-slate-700">
				Pass mark (%)
				<input type="number" name="passMark" min="1" max="100" value={values.passMark ?? '70'} class={input} />
			</label>
			<label class="block text-sm font-medium text-slate-700">
				Attempts allowed
				<input type="number" name="maxAttempts" min="1" max="10" value={values.maxAttempts ?? '3'} class={input} />
			</label>
			<div><Button type="submit">Create course</Button></div>
		</form>
	</section>
{/if}
