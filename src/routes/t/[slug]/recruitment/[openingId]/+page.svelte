<script lang="ts">
	import AiAssist from '#lib/components/AiAssist.svelte';
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import Field from '#lib/components/ui/Field.svelte';
	import Markdown from '#lib/components/Markdown.svelte';
	import { taka } from '#lib/money.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const v = $derived(data.view);
	const o = $derived(v.opening);
	const input = 'mt-1 block w-full input';
	const statusLabel: Record<string, string> = { open: 'Open', on_hold: 'On hold', closed: 'Closed' };
	const sourceLabel: Record<string, string> = {
		referral: 'Referral',
		job_board: 'Job board',
		website: 'Website',
		agency: 'Agency',
		walk_in: 'Walk-in',
		internal: 'Internal',
		other: 'Other'
	};
	const base = $derived(`/t/${data.tenant.slug}/recruitment`);
	const visibilityOptions = $derived(
		(
			[
				['none', 'Only the hiring team', true],
				['internal', 'Internal job board', data.talent],
				['public', 'Public careers page', data.careers],
				['both', 'Job board and careers page', data.talent && data.careers]
			] as const
		).filter(([value, , shown]) => shown || value === o.visibility)
	);
	const careersLink = $derived(
		data.careers && o.publicSlug && (o.visibility === 'public' || o.visibility === 'both') && o.status === 'open'
			? `/careers/${data.tenant.slug}/${o.publicSlug}`
			: null
	);
</script>

<svelte:head><title>{o.title} · Recruitment · {data.tenant.name}</title></svelte:head>

<a class="text-sm text-brand-700 underline" href={base}>All openings</a>
<h1 class="page-title mt-2">{o.title} · {statusLabel[o.status]}</h1>
{#if careersLink}<p class="mt-1 text-sm">
		On the careers page: <a class="text-brand-700 underline" href={careersLink}>{careersLink}</a>
	</p>{/if}

<div class="mt-4 max-w-5xl space-y-2">
	<Alert message={form?.message} />
	{#if form && 'done' in form}<Alert tone="info" message={form.done} />{/if}
</div>

<section class="mt-4 max-w-5xl" aria-label="Pipeline">
	<h2 class="section-title">Pipeline</h2>
	<div class="mt-3 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
		{#each v.stages as s (s.id)}
			<div class="rounded-xl bg-white p-3 ring-1 ring-slate-200" role="group" aria-label={s.name}>
				<h3 class="text-sm font-semibold text-slate-700">
					{s.name} <span class="text-slate-400">{v.funnel.find((f) => f.stageId === s.id)?.count ?? 0}</span>
				</h3>
				<ul class="mt-2 space-y-1 text-sm">
					{#each v.candidates.filter((c) => c.stageId === s.id) as c (c.id)}
						<li><a class="text-brand-700 underline" href={`${base}/candidates/${c.id}`}>{c.fullName}</a></li>
					{/each}
				</ul>
			</div>
		{/each}
	</div>
</section>

{#if data.canManage}
	{#if o.status === 'open'}
		<section class="mt-6 max-w-5xl panel" aria-label="Add candidate">
			<h2 class="section-title">Add candidate</h2>
			<form method="POST" action="?/add" enctype="multipart/form-data" class="mt-3 grid gap-3 sm:grid-cols-2">
				<Field label="Full name" name="fullName" required maxlength={120} />
				<Field label="Email" name="email" type="email" maxlength={254} />
				<Field label="Phone" name="phone" type="tel" maxlength={40} pattern="[+\d][\d\s\-]*" />
				<label class="block text-sm font-medium text-slate-700">
					Source
					<select name="source" class={input}>
						{#each data.sources as s (s)}<option value={s} selected={s === 'other'}>{sourceLabel[s]}</option>{/each}
					</select>
				</label>
				<Field label="Tags (comma separated)" name="tags" maxlength={330} />
				<label class="block text-sm font-medium text-slate-700">
					Resume (PDF, Word or image, up to 10 MB)
					<input
						name="resume"
						type="file"
						accept=".pdf,.docx,.png,.jpg,.jpeg,.webp,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/png,image/jpeg,image/webp"
						class="mt-1 block w-full text-sm"
					/>
				</label>
				{#if data.ai.ocr}
					<div class="sm:col-span-2">
						<AiAssist url={`/t/${data.tenant.slug}/recruitment/${o.id}/cv`} label="Read CV" file="resume" />
					</div>
				{/if}
				<label class="block text-sm font-medium text-slate-700 sm:col-span-2">
					Notes
					<textarea name="notes" rows="3" maxlength="2000" class={input}></textarea>
				</label>
				<div><Button type="submit">Add candidate</Button></div>
			</form>
		</section>
	{/if}

	<section class="mt-6 max-w-5xl panel" aria-label="Edit opening">
		<h2 class="section-title">Edit opening</h2>
		<form method="POST" action="?/save" class="mt-3 grid gap-3 sm:grid-cols-2">
			<Field label="Job title" name="title" required maxlength={120} value={o.title} />
			<Field label="Headcount" name="headcount" type="number" min="1" max="500" step="1" value={o.headcount} required />
			<label class="block text-sm font-medium text-slate-700">
				Department
				<select name="departmentId" class={input}>
					<option value="">None</option>
					{#each v.departments as d (d.id)}<option value={d.id} selected={d.id === o.departmentId}>
							{d.name}
						</option>{/each}
				</select>
			</label>
			<label class="block text-sm font-medium text-slate-700">
				Designation
				<select name="designationId" class={input}>
					<option value="">None</option>
					{#each v.designations as d (d.id)}<option value={d.id} selected={d.id === o.designationId}>
							{d.name}
						</option>{/each}
				</select>
			</label>
			<label class="block text-sm font-medium text-slate-700">
				Status
				<select name="status" class={input}>
					{#each data.statuses as s (s)}<option value={s} selected={s === o.status}>{statusLabel[s]}</option>{/each}
				</select>
			</label>
			{#if data.talent || data.careers}
				<label class="block text-sm font-medium text-slate-700">
					Who can see it
					<select name="visibility" class={input}>
						{#each visibilityOptions as [value, label] (value)}<option {value} selected={value === o.visibility}>
								{label}
							</option>{/each}
					</select>
				</label>
			{:else}
				<input type="hidden" name="visibility" value={o.visibility} />
			{/if}
			{#if data.careers}
				<label class="block text-sm font-medium text-slate-700">
					Careers page link
					<span class="block text-xs font-normal text-slate-500">
						/careers/{data.tenant.slug}/…, left blank uses the title
					</span>
					<input
						name="publicSlug"
						maxlength="63"
						pattern={'[a-z0-9][a-z0-9\\-]{0,62}'}
						class={input}
						value={o.publicSlug ?? ''}
					/>
				</label>
			{:else}
				<input type="hidden" name="publicSlug" value={o.publicSlug ?? ''} />
			{/if}
			{#if data.talent}
				<label class="block text-sm font-medium text-slate-700">
					Referral bonus
					<input
						name="referralBonus"
						inputmode="decimal"
						pattern={'\\d{1,6}(\\.\\d{1,2})?'}
						class={input}
						value={o.referralBonus ? taka(o.referralBonus) : ''}
					/>
				</label>
				<label class="block text-sm font-medium text-slate-700 sm:col-span-2">
					Skills wanted
					<input type="hidden" name="skillsShown" value="1" />
					<select name="skillId" multiple size={Math.min(6, Math.max(2, v.skills.length))} class={input}>
						{#each v.skills as sk (sk.id)}<option value={sk.id} selected={v.skillIds.includes(sk.id)}>
								{sk.name}
							</option>{/each}
					</select>
				</label>
			{:else}
				<input type="hidden" name="referralBonus" value={o.referralBonus ? taka(o.referralBonus) : ''} />
			{/if}
			<label class="block text-sm font-medium text-slate-700 sm:col-span-2">
				Description
				<span class="block text-xs font-normal text-slate-500">
					Supports **bold**, *italic*, # headings, - lists and [links](https://…).
				</span>
				<textarea name="description" rows="4" maxlength="5000" class={input} value={o.description}></textarea>
			</label>
			{#if data.ai.write}
				<div class="sm:col-span-2">
					<AiAssist
						url={`/t/${data.tenant.slug}/recruitment/draft`}
						label="Draft with AI"
						send={['title', 'departmentId', 'designationId']}
					/>
				</div>
			{/if}
			<div><Button type="submit">Save opening</Button></div>
		</form>
	</section>
{:else if o.description}
	<section class="mt-6 max-w-5xl panel" aria-label="Description">
		<h2 class="section-title">Description</h2>
		<Markdown class="mt-2" source={o.description} />
	</section>
{/if}
