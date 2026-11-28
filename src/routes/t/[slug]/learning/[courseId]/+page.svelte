<script lang="ts">
	import Attachments from '#lib/components/Attachments.svelte';
	import Markdown from '#lib/components/Markdown.svelte';
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const input = 'mt-1 block w-full input';
	const base = $derived(`/t/${data.tenant.slug}/learning`);
	const c = $derived(data.course);
	const e = $derived(data.enrolment);
	const quiz = $derived(form && 'quiz' in form ? form.quiz : null);
	const canLearn = $derived(c.status === 'published' && e?.status === 'assigned');
	const dots = (...parts: unknown[]) => parts.filter((p) => p || p === 0).join(' · ');
	const KINDS = { text: 'Reading', link: 'Link', file: 'File', quiz: 'Quiz' } as const;
	const AUDIENCE = { all: 'Everyone', department: 'Department', branch: 'Branch', employee: 'Person' } as const;
	let kind = $state('text');
	let audience = $state('all');
</script>

<svelte:head><title>{c.title} · {data.tenant.name}</title></svelte:head>

<a class="text-sm text-brand-700 underline" href={base}>Learning</a>
<h1 class="page-title mt-1">{c.title}</h1>
<p class="mt-1 text-sm text-slate-600">
	{dots(`Pass mark ${c.passMark}%`, `${c.maxAttempts} attempts per quiz`, c.status !== 'published' && c.status)}
</p>
{#if c.description}<Markdown class="mt-3 max-w-3xl text-sm" source={c.description} />{/if}

<div class="mt-4 max-w-3xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'done' in form && typeof form.done === 'string'}<Alert tone="info" message={form.done} />{/if}
	{#if quiz}
		<Alert
			tone={quiz.passed ? 'info' : 'error'}
			message={quiz.passed
				? `You scored ${quiz.score}%. Quiz passed.`
				: `You scored ${quiz.score}%. ${quiz.attemptsLeft ? `${quiz.attemptsLeft} attempts left.` : 'No attempts left.'}`}
		/>
	{/if}
</div>

{#if e}
	<section class="mt-4 max-w-3xl panel" aria-label="My progress">
		<h2 class="section-title">My progress</h2>
		{#if e.status === 'passed'}
			<p class="mt-2 text-sm text-slate-700">
				{e.score === null ? 'Passed.' : `Passed with ${e.score}%.`}
				{e.expiresOn ? `Renew by ${e.expiresOn}.` : ''}
				<a class="text-brand-700 underline" href="{base}/certificates/{e.id}" data-sveltekit-reload>
					Download certificate
				</a>
			</p>
		{:else if e.status === 'failed'}
			<p class="mt-2 text-sm text-red-700">You have used all your attempts. Ask HR for another try.</p>
		{:else}
			<p class="mt-2 text-sm text-slate-700">
				{dots(
					`${data.lessons.filter((l) => l.progress?.completedAt).length} of ${data.lessons.length} lessons done`,
					e.dueOn && `due ${e.dueOn}`
				)}
			</p>
		{/if}
		{#if data.certificateId && e.status !== 'passed'}
			<p class="mt-2 text-sm">
				<a class="text-brand-700 underline" href="{base}/certificates/{data.certificateId}" data-sveltekit-reload>
					Download your last certificate
				</a>
			</p>
		{/if}
	</section>
{:else if c.status === 'published'}
	<form method="POST" action="{base}?/enrol" class="mt-4">
		<input type="hidden" name="courseId" value={c.id} />
		<Button type="submit">Start course</Button>
	</form>
{/if}

<ol class="mt-6 max-w-3xl space-y-4">
	{#each data.lessons as l, i (l.id)}
		<li class="panel" aria-label="Lesson {i + 1}">
			<div class="flex flex-wrap items-center justify-between gap-2">
				<h2 class="section-title">{i + 1}. {l.title}</h2>
				<span class="text-xs text-slate-500">
					{dots(
						KINDS[l.kind],
						l.progress?.completedAt ? 'done' : l.progress?.attempts && `${l.progress.attempts} tries`
					)}
				</span>
			</div>
			{#if l.body}<Markdown class="mt-2 text-sm" source={l.body} />{/if}
			{#if l.url}
				<p class="mt-2 text-sm">
					<a class="break-all text-brand-700 underline" href={l.url} target="_blank" rel="noopener noreferrer nofollow">
						{l.url}
					</a>
				</p>
			{/if}
			{#if l.kind === 'file'}
				<Attachments
					slug={data.tenant.slug}
					attachments={{ files: l.files, canEdit: !!data.manage }}
					{form}
					action="?/lessonFiles"
					ownerId={l.id}
					title="Lesson file"
					compact
				/>
			{/if}
			{#if l.kind === 'quiz' && canLearn && !l.progress?.completedAt}
				<form method="POST" action="?/quiz" class="mt-3 space-y-4">
					<input type="hidden" name="lessonId" value={l.id} />
					{#each l.questions as q, n (q.id)}
						<fieldset class="text-sm">
							<legend class="font-medium text-slate-900">
								{n + 1}. {q.prompt}{q.multiple ? ' (choose all that apply)' : ''}
							</legend>
							{#each q.options as o (o.id)}
								<label class="mt-1 flex items-center gap-2">
									<input type={q.multiple ? 'checkbox' : 'radio'} name="q:{q.id}" value={o.id} required={!q.multiple} />
									{o.text}
								</label>
							{/each}
						</fieldset>
					{/each}
					<Button type="submit">Submit answers</Button>
				</form>
			{:else if l.kind !== 'quiz' && canLearn && !l.progress?.completedAt}
				<form method="POST" action="?/complete" class="mt-3">
					<input type="hidden" name="lessonId" value={l.id} />
					<Button type="submit" variant="secondary">Mark as done</Button>
				</form>
			{/if}
			{#if data.manage}
				{#if l.kind === 'quiz'}
					<ul class="mt-3 divide-y divide-slate-100 text-sm">
						{#each l.questions as q (q.id)}
							<li class="flex flex-wrap items-start justify-between gap-2 py-2">
								<div class="min-w-0">
									<p class="font-medium">{q.prompt}</p>
									<pre class="whitespace-pre-wrap text-slate-600">{data.manage.answers[q.id]}</pre>
								</div>
								<form method="POST" action="?/dropQuestion">
									<input type="hidden" name="questionId" value={q.id} />
									<Button type="submit" variant="secondary">Remove question</Button>
								</form>
							</li>
						{/each}
					</ul>
					<form method="POST" action="?/question" class="mt-3 grid gap-2" aria-label="New question for {l.title}">
						<input type="hidden" name="lessonId" value={l.id} />
						<label class="block text-sm font-medium text-slate-700">
							Question
							<input name="prompt" required maxlength="500" class={input} />
						</label>
						<label class="block text-sm font-medium text-slate-700">
							Options, one per line, * before each correct one
							<textarea name="options" required rows="4" class={input}></textarea>
						</label>
						<div><Button type="submit">Add question</Button></div>
					</form>
				{/if}
				<form method="POST" action="?/dropLesson" class="mt-3">
					<input type="hidden" name="lessonId" value={l.id} />
					<Button type="submit" variant="danger">Remove lesson</Button>
				</form>
			{/if}
		</li>
	{/each}
</ol>

{#if data.manage}
	{@const mg = data.manage}
	<section class="mt-6 max-w-3xl panel" aria-label="New lesson">
		<h2 class="section-title">New lesson</h2>
		<form method="POST" action="?/lesson" class="mt-3 grid gap-3">
			<label class="block text-sm font-medium text-slate-700">
				Type
				<select name="kind" bind:value={kind} class={input}>
					{#each Object.entries(KINDS) as [k, label] (k)}<option value={k}>{label}</option>{/each}
				</select>
			</label>
			<label class="block text-sm font-medium text-slate-700">
				Lesson title
				<input name="title" required maxlength="160" class={input} />
			</label>
			{#if kind === 'link'}
				<label class="block text-sm font-medium text-slate-700">
					Link (a video or page)
					<input type="url" name="url" required maxlength="2000" class={input} />
				</label>
			{/if}
			<label class="block text-sm font-medium text-slate-700">
				Text
				<textarea name="body" rows="4" maxlength="20000" class={input}></textarea>
			</label>
			<div><Button type="submit">Add lesson</Button></div>
		</form>
	</section>

	<section class="mt-6 max-w-3xl panel" aria-label="Course settings">
		<h2 class="section-title">Course settings</h2>
		<form method="POST" action="?/save" class="mt-3 grid gap-3 sm:grid-cols-2">
			<label class="block text-sm font-medium text-slate-700 sm:col-span-2">
				Course title
				<input name="title" required maxlength="160" value={c.title} class={input} />
			</label>
			<label class="block text-sm font-medium text-slate-700 sm:col-span-2">
				Description
				<textarea name="description" rows="3" maxlength="5000" class={input}>{c.description}</textarea>
			</label>
			<label class="block text-sm font-medium text-slate-700">
				Pass mark (%)
				<input type="number" name="passMark" min="1" max="100" value={c.passMark} class={input} />
			</label>
			<label class="block text-sm font-medium text-slate-700">
				Attempts allowed
				<input type="number" name="maxAttempts" min="1" max="10" value={c.maxAttempts} class={input} />
			</label>
			<div><Button type="submit">Save course</Button></div>
		</form>
		<form method="POST" action="?/status" class="mt-4 flex flex-wrap gap-2">
			{#if c.status !== 'published'}<Button type="submit" name="status" value="published">Publish</Button>{/if}
			{#if c.status !== 'archived'}<Button type="submit" name="status" value="archived" variant="secondary">
					Archive
				</Button>{/if}
			{#if c.status !== 'draft'}<Button type="submit" name="status" value="draft" variant="secondary">
					Back to draft
				</Button>{/if}
		</form>
	</section>

	{#if c.status === 'published'}
		<section class="mt-6 max-w-3xl panel" aria-label="Assign">
			<h2 class="section-title">Assign</h2>
			{#if mg.assignments.length}
				<ul class="mt-3 divide-y divide-slate-100 text-sm">
					{#each mg.assignments as a (a.id)}
						<li class="flex flex-wrap items-center justify-between gap-2 py-2" data-testid="assignment">
							<span>
								{AUDIENCE[a.audience]}{a.department || a.branch || a.employee
									? `: ${a.department ?? a.branch ?? a.employee}`
									: ''}
								<span class="text-slate-500">
									· {dots(
										`${a.dueInDays} days`,
										a.mandatory ? 'required' : 'optional',
										a.renewEveryMonths && `renew every ${a.renewEveryMonths} months`,
										`${a.enrolled} people`
									)}
								</span>
							</span>
							<form method="POST" action="?/unassign">
								<input type="hidden" name="assignmentId" value={a.id} />
								<Button type="submit" variant="secondary">Remove</Button>
							</form>
						</li>
					{/each}
				</ul>
			{/if}
			<form method="POST" action="?/assign" class="mt-4 grid gap-3 sm:grid-cols-2">
				<label class="block text-sm font-medium text-slate-700">
					Who takes it
					<select name="audience" bind:value={audience} class={input}>
						{#each Object.entries(AUDIENCE) as [k, label] (k)}<option value={k}>{label}</option>{/each}
					</select>
				</label>
				{#if audience === 'department'}
					<label class="block text-sm font-medium text-slate-700">
						Department
						<select name="departmentId" required class={input}>
							{#each mg.departments as d (d.id)}<option value={d.id}>{d.name}</option>{/each}
						</select>
					</label>
				{:else if audience === 'branch'}
					<label class="block text-sm font-medium text-slate-700">
						Branch
						<select name="branchId" required class={input}>
							{#each mg.branches as b (b.id)}<option value={b.id}>{b.name}</option>{/each}
						</select>
					</label>
				{:else if audience === 'employee'}
					<label class="block text-sm font-medium text-slate-700">
						Person
						<select name="employeeId" required class={input}>
							{#each mg.employees as p (p.id)}<option value={p.id}>{p.name} ({p.code})</option>{/each}
						</select>
					</label>
				{/if}
				<label class="block text-sm font-medium text-slate-700">
					Days to finish
					<input type="number" name="dueInDays" required min="1" max="365" value="30" class={input} />
				</label>
				<label class="block text-sm font-medium text-slate-700">
					Renew every (months)
					<input type="number" name="renewEveryMonths" min="1" max="120" class={input} />
				</label>
				<label class="flex items-center gap-2 text-sm font-medium text-slate-700">
					<input type="checkbox" name="mandatory" checked /> Required
				</label>
				<div><Button type="submit">Assign course</Button></div>
			</form>
		</section>
	{/if}

	{#if mg.failed.length}
		<section class="mt-6 max-w-3xl panel" aria-label="Out of attempts">
			<h2 class="section-title">Out of attempts</h2>
			<ul class="mt-3 divide-y divide-slate-100 text-sm">
				{#each mg.failed as f (f.id)}
					<li class="flex items-center justify-between gap-2 py-2">
						<span>{f.name}</span>
						<form method="POST" action="?/retry">
							<input type="hidden" name="enrolmentId" value={f.id} />
							<Button type="submit" variant="secondary">Allow another try</Button>
						</form>
					</li>
				{/each}
			</ul>
		</section>
	{/if}
{/if}
