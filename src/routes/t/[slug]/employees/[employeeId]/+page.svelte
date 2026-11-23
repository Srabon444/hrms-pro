<script lang="ts">
	import EmployeeForm from '#lib/components/EmployeeForm.svelte';
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const e = $derived(data.employee);
	const size = (n: number) => (n < 1024 * 1024 ? `${Math.ceil(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
	const field = 'rounded-md border border-slate-300 px-3 py-2 text-sm';
	const values = $derived(form && 'values' in form ? form.values : { ...e, ...(data.sensitive ?? {}) });
	const lists = $derived(data.lists);
	const profileMessage = $derived(form && 'profileMessage' in form ? (form.profileMessage as string) : null);
	const listSections = $derived([
		{
			kind: 'contact',
			title: 'Emergency contacts',
			rows: lists.contacts.map((c) => ({ id: c.id, text: `${c.name} (${c.relation}) · ${c.phone}` })),
			inputs: [
				{ name: 'name', label: 'Contact name', type: 'text', required: true, max: 160 },
				{ name: 'relation', label: 'Relation', type: 'text', required: true, max: 60 },
				{ name: 'phone', label: 'Contact phone', type: 'tel', required: true, max: 30 }
			]
		},
		{
			kind: 'education',
			title: 'Education',
			rows: lists.education.map((d) => ({
				id: d.id,
				text: `${d.degree}, ${d.institution}${d.passingYear ? ` (${d.passingYear})` : ''}`
			})),
			inputs: [
				{ name: 'degree', label: 'Degree', type: 'text', required: true, max: 160 },
				{ name: 'institution', label: 'Institution', type: 'text', required: true, max: 160 },
				{ name: 'passingYear', label: 'Passing year', type: 'number', required: false, max: 4 }
			]
		},
		{
			kind: 'experience',
			title: 'Experience',
			rows: lists.experience.map((x) => ({
				id: x.id,
				text: `${x.title} at ${x.company} · ${x.startDate} – ${x.endDate ?? 'present'}`
			})),
			inputs: [
				{ name: 'company', label: 'Company', type: 'text', required: true, max: 160 },
				{ name: 'title', label: 'Job title', type: 'text', required: true, max: 160 },
				{ name: 'startDate', label: 'Start date', type: 'date', required: true, max: 10 },
				{ name: 'endDate', label: 'End date', type: 'date', required: false, max: 10 }
			]
		}
	]);
	const facts = $derived([
		['Code', e.code],
		['Status', e.status],
		['Department', data.names.department],
		['Designation', data.names.designation],
		['Grade', data.names.grade],
		['Branch', data.names.branch],
		['Manager', data.names.managerName && `${data.names.managerName} (${data.names.managerCode})`],
		['Joined', e.joinDate],
		['Work email', e.workEmail],
		['Phone', e.phone]
	]);
</script>

<svelte:head><title>{e.fullName} · {data.tenant.name}</title></svelte:head>

<a href="/t/{data.tenant.slug}/employees" class="text-sm text-indigo-600 hover:underline">Back to employees</a>
<h1 class="mt-2 text-2xl font-semibold text-slate-900">{e.fullName}</h1>

<dl class="mt-4 grid max-w-3xl gap-x-6 gap-y-2 rounded-xl bg-white p-6 text-sm ring-1 ring-slate-200 sm:grid-cols-2">
	{#each facts as [label, value] (label)}
		<div class="flex gap-2">
			<dt class="w-28 text-slate-500">{label}</dt>
			<dd data-testid="fact-{label}">{value ?? ''}</dd>
		</div>
	{/each}
	{#if data.sensitive}
		<div class="flex gap-2">
			<dt class="w-28 text-slate-500">National ID</dt>
			<dd>{data.sensitive.nationalId ?? ''}</dd>
		</div>
		<div class="flex gap-2">
			<dt class="w-28 text-slate-500">Bank account</dt>
			<dd>{data.sensitive.bankAccountNumber ?? ''}</dd>
		</div>
	{/if}
</dl>

<div class="mt-6 max-w-3xl space-y-2">
	<Alert message={profileMessage} />
	{#if form && 'ownSaved' in form}<Alert tone="info" message="Contact details saved." />{/if}
	{#if form && 'entryAdded' in form}<Alert tone="info" message="Entry added." />{/if}
</div>

{#if lists.canEditSelf}
	<form
		method="POST"
		action="?/saveOwn"
		class="mt-6 grid max-w-3xl gap-3 rounded-xl bg-white p-6 ring-1 ring-slate-200 sm:grid-cols-2"
	>
		<h2 class="font-semibold text-slate-900 sm:col-span-2">My contact details</h2>
		<input
			name="phone"
			type="tel"
			aria-label="My phone"
			placeholder="Phone"
			maxlength={30}
			value={e.phone ?? ''}
			class={field}
		/>
		<input
			name="personalEmail"
			type="email"
			aria-label="My personal email"
			placeholder="Personal email"
			value={e.personalEmail ?? ''}
			class={field}
		/>
		<textarea
			name="presentAddress"
			aria-label="My present address"
			placeholder="Present address"
			maxlength={500}
			class={field}>{e.presentAddress ?? ''}</textarea
		>
		<textarea
			name="permanentAddress"
			aria-label="My permanent address"
			placeholder="Permanent address"
			maxlength={500}
			class={field}>{e.permanentAddress ?? ''}</textarea
		>
		<div class="sm:col-span-2"><Button type="submit">Save my details</Button></div>
	</form>
{/if}

{#each listSections as section (section.kind)}
	<section class="mt-6 max-w-3xl rounded-xl bg-white p-6 ring-1 ring-slate-200" aria-label={section.title}>
		<h2 class="font-semibold text-slate-900">{section.title}</h2>
		<ul class="mt-3 divide-y divide-slate-100 text-sm">
			{#each section.rows as row (row.id)}
				<li class="flex items-center gap-3 py-2" data-testid="entry-{section.kind}">
					<span>{row.text}</span>
					{#if lists.canEditLists}
						<form method="POST" action="?/removeEntry" class="ml-auto">
							<input type="hidden" name="kind" value={section.kind} />
							<input type="hidden" name="entryId" value={row.id} />
							<button type="submit" class="text-red-600 hover:underline" aria-label="Remove {row.text}">Remove</button>
						</form>
					{/if}
				</li>
			{:else}
				<li class="py-2 text-slate-500">Nothing added yet.</li>
			{/each}
		</ul>
		{#if lists.canEditLists}
			<form method="POST" action="?/addEntry" class="mt-4 grid gap-3 sm:grid-cols-2">
				<input type="hidden" name="kind" value={section.kind} />
				{#each section.inputs as input (input.name)}
					<label class="text-sm text-slate-700">
						{input.label}
						<input
							name={input.name}
							type={input.type}
							required={input.required}
							maxlength={input.type === 'text' || input.type === 'tel' ? input.max : undefined}
							min={input.type === 'number' ? 1950 : undefined}
							max={input.type === 'number' ? 2100 : undefined}
							class="{field} mt-1 block w-full"
						/>
					</label>
				{/each}
				<div class="sm:col-span-2"><Button type="submit">Add to {section.title.toLowerCase()}</Button></div>
			</form>
		{/if}
	</section>
{/each}

{#if data.canUpdate && data.choices}
	<form method="POST" action="?/save" class="mt-6 max-w-3xl rounded-xl bg-white p-6 ring-1 ring-slate-200">
		<h2 class="mb-4 font-semibold text-slate-900">Edit record</h2>
		<div class="mb-4 space-y-2">
			<Alert message={form?.message} />
			{#if form && 'saved' in form}<Alert tone="info" message="Employee saved." />{/if}
		</div>
		<EmployeeForm {values} choices={data.choices} sensitive={data.canUpdateSensitive} selfId={e.id} />
		<div class="mt-6"><Button type="submit">Save changes</Button></div>
	</form>
{/if}

{#if data.documents}
	<section class="mt-6 max-w-3xl rounded-xl bg-white p-6 ring-1 ring-slate-200" aria-label="Documents">
		<h2 class="font-semibold text-slate-900">Documents</h2>
		<div class="mt-3 space-y-2">
			<Alert message={form && 'docMessage' in form ? form.docMessage : null} />
			{#if form && 'uploaded' in form}<Alert tone="info" message="Document uploaded." />{/if}
		</div>
		<ul class="mt-3 divide-y divide-slate-100 text-sm">
			{#each data.documents.rows as d (d.id)}
				<li class="flex items-center gap-3 py-2" data-testid="document">
					<a href="/t/{data.tenant.slug}/employees/{e.id}/documents/{d.id}" class="text-indigo-700 hover:underline">
						{d.title}
					</a>
					<span class="text-slate-500">{d.category} · {size(d.sizeBytes)}</span>
					{#if d.expiresOn}<span class="text-slate-500">expires {d.expiresOn}</span>{/if}
					{#if data.documents.canManage}
						<form method="POST" action="?/removeDocument" class="ml-auto">
							<input type="hidden" name="documentId" value={d.id} />
							<button type="submit" class="text-red-600 hover:underline" aria-label="Delete {d.title}">Delete</button>
						</form>
					{/if}
				</li>
			{:else}
				<li class="py-2 text-slate-500">No documents yet.</li>
			{/each}
		</ul>
		{#if data.documents.canManage}
			<form method="POST" action="?/upload" enctype="multipart/form-data" class="mt-4 grid gap-3 sm:grid-cols-2">
				<select name="category" aria-label="Document type" required class={field}>
					{#each data.documentCategories as c (c)}<option value={c}>{c}</option>{/each}
				</select>
				<input name="title" aria-label="Document title" placeholder="Title" required maxlength={160} class={field} />
				<label class="text-sm text-slate-700">
					Expires on
					<input name="expiresOn" type="date" class="{field} mt-1 block w-full" />
				</label>
				<input
					name="file"
					type="file"
					aria-label="File"
					required
					accept=".pdf,.png,.jpg,.jpeg,.webp,.docx,.xlsx"
					class="text-sm"
				/>
				<div class="sm:col-span-2"><Button type="submit">Upload document</Button></div>
			</form>
		{/if}
	</section>
{/if}

{#if data.history.length}
	<section class="mt-6 max-w-3xl rounded-xl bg-white p-6 ring-1 ring-slate-200" aria-label="History">
		<h2 class="font-semibold text-slate-900">History</h2>
		<ul class="mt-3 space-y-1 text-sm">
			{#each data.history as h, i (i)}
				<li data-testid="history">
					<span class="text-slate-500">{h.at.toLocaleDateString()}</span>
					{h.label}: {h.oldValue ?? 'none'} → {h.newValue ?? 'none'}
				</li>
			{/each}
		</ul>
	</section>
{/if}
