<script lang="ts">
	import AudienceFields from '#lib/components/AudienceFields.svelte';
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import Field from '#lib/components/ui/Field.svelte';
	import type { PageProps } from './$types';

	type Draft = { kind: string; prompt: string; options: string; required: boolean };
	let { data, form }: PageProps = $props();
	const values = $derived((form && 'values' in form ? form.values : {}) as Record<string, string>);
	const KINDS: Record<string, string> = {
		scale: 'Rating 1 to 5',
		enps: 'eNPS (0 to 10)',
		choice: 'One choice from a list',
		text: 'Written answer'
	};
	const ENPS = 'How likely are you to recommend working here to a friend?';
	const restore = (): Draft[] => {
		try {
			const saved = JSON.parse(values.questions ?? '') as {
				kind: string;
				prompt: string;
				options: string[];
				required: boolean;
			}[];
			return saved.map((q) => ({ ...q, options: q.options.join('\n') }));
		} catch {
			return [{ kind: 'enps', prompt: ENPS, options: '', required: true }];
		}
	};
	let questions = $state<Draft[]>(restore());
	const anonymousAtStart = () => values.title === undefined || values.anonymous === 'on';
	let anonymous = $state(anonymousAtStart());
	const payload = $derived(
		JSON.stringify(
			questions.map((q) => ({
				kind: q.kind,
				prompt: q.prompt,
				required: q.required,
				options:
					q.kind === 'choice'
						? q.options
								.split('\n')
								.map((o) => o.trim())
								.filter(Boolean)
						: []
			}))
		)
	);
	const add = (q: Draft) => {
		if (questions.length < data.maxQuestions) questions.push(q);
	};
</script>

<svelte:head><title>New survey · {data.tenant.name}</title></svelte:head>

<a class="text-sm text-brand-700 underline" href={`/t/${data.tenant.slug}/surveys`}>Surveys</a>
<h1 class="page-title mt-2">New survey</h1>

<div class="mt-4 max-w-3xl"><Alert message={form?.message} /></div>

<form method="POST" action="?/create" class="mt-4 max-w-3xl space-y-6">
	<section class="panel grid gap-3 sm:grid-cols-2" aria-label="About the survey">
		<Field label="Title" name="title" required maxlength={160} value={values.title ?? ''} />
		<Field label="Closes on" name="closesOn" type="date" required min={data.today} value={values.closesOn ?? ''} />
		<AudienceFields
			label="Who is asked"
			audience={values.audience || 'all'}
			departmentId={values.departmentId ?? ''}
			branchId={values.branchId ?? ''}
			departments={data.departments}
			branches={data.branches}
		/>
		<Field
			label="Smallest group shown in results"
			name="minGroupSize"
			type="number"
			min={5}
			max={50}
			required
			value={values.minGroupSize ?? '5'}
		/>
		<label class="flex items-center gap-2 text-sm text-slate-700 sm:col-span-2">
			<input type="checkbox" name="anonymous" bind:checked={anonymous} />
			Anonymous (no names kept; results only after it closes, groups smaller than the limit hidden)
		</label>
		<label class="block text-sm font-medium text-slate-700 sm:col-span-2">
			Introduction (optional)
			<textarea name="intro" maxlength={2000} rows="3" class="mt-1 block w-full input">{values.intro ?? ''}</textarea>
		</label>
	</section>

	<section class="space-y-3" aria-label="Questions">
		<h2 class="section-title">Questions</h2>
		{#each questions as q, i (i)}
			<div class="panel grid gap-3 sm:grid-cols-2" data-testid="question">
				<label class="block text-sm font-medium text-slate-700">
					Question {i + 1} type
					<select bind:value={q.kind} class="mt-1 block w-full input">
						{#each Object.entries(KINDS) as [value, label] (value)}<option {value}>{label}</option>{/each}
					</select>
				</label>
				<label class="block text-sm font-medium text-slate-700">
					Question {i + 1}
					<input bind:value={q.prompt} required maxlength={300} class="mt-1 block w-full input" />
				</label>
				{#if q.kind === 'choice'}
					<label class="block text-sm font-medium text-slate-700 sm:col-span-2">
						Question {i + 1} choices, one per line
						<textarea bind:value={q.options} required rows="3" class="mt-1 block w-full input"></textarea>
					</label>
				{/if}
				<div class="flex flex-wrap items-center justify-between gap-2 sm:col-span-2">
					<label class="flex items-center gap-2 text-sm text-slate-700">
						<input type="checkbox" bind:checked={q.required} /> Question {i + 1} must be answered
					</label>
					{#if questions.length > 1}
						<Button type="button" variant="secondary" onclick={() => questions.splice(i, 1)}>
							Remove question {i + 1}
						</Button>
					{/if}
				</div>
			</div>
		{/each}
		<div class="flex flex-wrap gap-2">
			<Button
				type="button"
				variant="secondary"
				disabled={questions.length >= data.maxQuestions}
				onclick={() => add({ kind: 'scale', prompt: '', options: '', required: true })}
			>
				Add question
			</Button>
			<Button
				type="button"
				variant="secondary"
				disabled={questions.length >= data.maxQuestions}
				onclick={() => add({ kind: 'enps', prompt: ENPS, options: '', required: true })}
			>
				Add eNPS question
			</Button>
		</div>
	</section>

	<input type="hidden" name="questions" value={payload} />
	<Button type="submit">Save as draft</Button>
</form>
