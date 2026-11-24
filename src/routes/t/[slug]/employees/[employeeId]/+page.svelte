<script lang="ts">
	import EmployeeForm from '#lib/components/EmployeeForm.svelte';
	import Attachments from '#lib/components/Attachments.svelte';
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const e = $derived(data.employee);
	const size = (n: number) => (n < 1024 * 1024 ? `${Math.ceil(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
	const field = 'input';
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

<a href="/t/{data.tenant.slug}/employees" class="text-sm text-brand-600 hover:underline">Back to employees</a>
<h1 class="page-title mt-2">{e.fullName}</h1>

<dl class="mt-4 grid max-w-3xl gap-x-6 gap-y-2 rounded-xl bg-white p-6 text-sm ring-1 ring-slate-200 sm:grid-cols-2">
	{#each facts as [label, value] (label)}
		<div class="flex gap-2">
			<dt class="w-28 shrink-0 text-slate-500">{label}</dt>
			<dd data-testid="fact-{label}">{value ?? ''}</dd>
		</div>
	{/each}
	{#if data.sensitive}
		<div class="flex gap-2">
			<dt class="w-28 shrink-0 text-slate-500">National ID</dt>
			<dd>{data.sensitive.nationalId ?? ''}</dd>
		</div>
		<div class="flex gap-2">
			<dt class="w-28 shrink-0 text-slate-500">Bank account</dt>
			<dd>{data.sensitive.bankAccountNumber ?? ''}</dd>
		</div>
	{/if}
</dl>

<div class="mt-6 max-w-3xl space-y-2">
	<Alert message={profileMessage} />
	{#if form && 'ownSaved' in form}<Alert tone="info" message="Contact details saved." />{/if}
	{#if form && 'entryAdded' in form}<Alert tone="info" message="Entry added." />{/if}
	{#if form && 'exitRecorded' in form}<Alert tone="info" message="Exit recorded." />{/if}
	{#if form && 'exitWithdrawn' in form}<Alert tone="info" message="Exit withdrawn." />{/if}
	{#if form && 'rehired' in form}<Alert tone="info" message="Rehired." />{/if}
</div>

{#if lists.canEditSelf}
	<form method="POST" action="?/saveOwn" class="mt-6 grid max-w-3xl gap-3 panel sm:grid-cols-2">
		<h2 class="section-title sm:col-span-2">My contact details</h2>
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

{#if lists.canEditSelf}
	<section class="mt-6 max-w-3xl panel" aria-label="Request a change">
		<h2 class="section-title">Request a change</h2>
		{#if form && 'changeRequested' in form}<Alert tone="info" message="Your request was sent to HR." />{/if}
		{#if form && 'changeCancelled' in form}<Alert tone="info" message="Request cancelled." />{/if}
		{#if data.pendingChange}
			<p class="mt-3 text-sm text-slate-700" data-testid="pending-change">
				Waiting for HR: {data.pendingChange.summary}
			</p>
			<form method="POST" action="?/cancelChange" class="mt-3">
				<input type="hidden" name="requestId" value={data.pendingChange.id} />
				<Button type="submit">Cancel request</Button>
			</form>
		{:else}
			<p class="mt-1 text-sm text-slate-600">
				Name, date of birth, identity and bank details change only after HR approves.
			</p>
			<form method="POST" action="?/requestChange" class="mt-4 grid gap-3 sm:grid-cols-2">
				{#each Object.entries(data.changeLabels) as [name, label] (name)}
					<label class="text-sm text-slate-700">
						{label}
						<input
							{name}
							type={name === 'dateOfBirth' ? 'date' : 'text'}
							maxlength={160}
							class="{field} mt-1 block w-full"
						/>
					</label>
				{/each}
				<div class="sm:col-span-2"><Button type="submit">Send to HR</Button></div>
			</form>
		{/if}
	</section>
{/if}

{#each listSections as section (section.kind)}
	<section class="mt-6 max-w-3xl panel" aria-label={section.title}>
		<h2 class="section-title">{section.title}</h2>
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

{#if data.resignation && (data.resignation.pending || (e.status !== 'notice' && e.status !== 'exited'))}
	{@const r = data.resignation}
	<section class="mt-6 max-w-3xl panel" aria-label="Resign">
		<h2 class="section-title">Resign</h2>
		{#if form && 'resigned' in form}<Alert tone="info" message="Your resignation was sent." />{/if}
		{#if form && 'resignationWithdrawn' in form}<Alert tone="info" message="Resignation withdrawn." />{/if}
		{#if r.pending}
			<p class="mt-3 text-sm text-slate-700" data-testid="resignation-pending">
				Submitted on {r.pending.submittedOn}, last day {r.pending.requestedLastDay}. Waiting for
				{r.pending.status === 'pending_manager' ? 'your manager' : 'HR'}.
			</p>
			<form method="POST" action="?/withdrawResignation" class="mt-3">
				<input type="hidden" name="resignationId" value={r.pending.id} />
				<Button type="submit" variant="secondary">Withdraw resignation</Button>
			</form>
			{#if r.files}
				<Attachments slug={data.tenant.slug} attachments={r.files} {form} action="?/resignationFiles" />
			{/if}
		{:else}
			<p class="mt-1 text-sm text-slate-600">
				The notice period is {r.terms.noticeDays} days, so the usual last day is {r.terms.earliest}.
			</p>
			<form method="POST" action="?/resign" class="mt-4 grid gap-3 sm:grid-cols-2">
				<label class="text-sm text-slate-700">
					My last working day
					<input
						name="lastDay"
						type="date"
						required
						min={r.terms.today}
						value={r.terms.earliest}
						class="{field} mt-1 block w-full"
					/>
				</label>
				<label class="text-sm text-slate-700 sm:col-span-2">
					Why are you leaving?
					<textarea name="reason" required maxlength={500} class="{field} mt-1 block w-full"></textarea>
				</label>
				<div class="sm:col-span-2"><Button type="submit" variant="danger">Submit resignation</Button></div>
			</form>
		{/if}
	</section>
{/if}

{#if data.exit.canExit}
	<section class="mt-6 max-w-3xl panel" aria-label="Exit">
		<h2 class="section-title">Exit</h2>
		{#if e.status === 'notice' && e.exitDate}
			<p class="mt-3 text-sm text-slate-700" data-testid="exit-pending">
				Leaving on {e.exitDate} ({e.exitType ?? 'other'}). Access ends automatically after that day.
			</p>
			<form method="POST" action="?/withdrawExit" class="mt-3">
				<Button type="submit" variant="secondary">Withdraw exit</Button>
			</form>
		{:else}
			<form method="POST" action="?/recordExit" class="mt-4 grid gap-3 sm:grid-cols-2">
				<label class="text-sm text-slate-700">
					Last working day
					<input name="exitDate" type="date" required class="{field} mt-1 block w-full" />
				</label>
				<label class="text-sm text-slate-700">
					Exit type
					<select name="exitType" required class="{field} mt-1 block w-full">
						{#each data.exitTypes as t (t)}<option value={t}>{t.replace('_', ' ')}</option>{/each}
					</select>
				</label>
				<label class="text-sm text-slate-700 sm:col-span-2">
					Reason
					<textarea name="exitReason" maxlength={500} class="{field} mt-1 block w-full"></textarea>
				</label>
				<div class="sm:col-span-2"><Button type="submit" variant="danger">Record exit</Button></div>
			</form>
		{/if}
	</section>
{/if}

{#if data.exitInterview}
	{@const iv = data.exitInterview}
	<section class="mt-6 max-w-3xl panel" aria-label="Exit interview">
		<h2 class="section-title">Exit interview</h2>
		{#if form && 'interviewSaved' in form}<Alert tone="info" message="Exit interview saved." />{/if}
		{#if iv.answers}
			<dl class="mt-3 space-y-1 text-sm" data-testid="exit-interview">
				<div class="flex gap-3">
					<dt class="w-28 shrink-0 text-slate-500 sm:w-40">Main reason</dt>
					<dd>{iv.answers.primaryReason.replace('_', ' ')}</dd>
				</div>
				<div class="flex gap-3">
					<dt class="w-28 shrink-0 text-slate-500 sm:w-40">Overall experience</dt>
					<dd>{iv.answers.rating} of 5</dd>
				</div>
				<div class="flex gap-3">
					<dt class="w-28 shrink-0 text-slate-500 sm:w-40">Would recommend</dt>
					<dd>{iv.answers.wouldRecommend ? 'yes' : 'no'}</dd>
				</div>
				<div class="flex gap-3">
					<dt class="w-28 shrink-0 text-slate-500 sm:w-40">Would come back</dt>
					<dd>{iv.answers.wouldRejoin ? 'yes' : 'no'}</dd>
				</div>
				{#if iv.answers.comments}
					<div class="flex gap-3">
						<dt class="w-28 shrink-0 text-slate-500 sm:w-40">Comments</dt>
						<dd class="whitespace-pre-line">{iv.answers.comments}</dd>
					</div>
				{/if}
			</dl>
		{:else if iv.submitted}
			<p class="mt-3 text-sm text-slate-700" data-testid="exit-interview-done">
				Thank you, the exit interview is filled in.
			</p>
		{:else}
			<form method="POST" action="?/exitInterview" class="mt-4 grid gap-3 sm:grid-cols-2">
				<label class="text-sm text-slate-700">
					Main reason for leaving
					<select name="primaryReason" required class="{field} mt-1 block w-full">
						{#each iv.reasons as r (r)}<option value={r}>{r.replace('_', ' ')}</option>{/each}
					</select>
				</label>
				<label class="text-sm text-slate-700">
					Overall experience (1 to 5)
					<select name="rating" required class="{field} mt-1 block w-full">
						{#each [5, 4, 3, 2, 1] as n (n)}<option value={n}>{n}</option>{/each}
					</select>
				</label>
				<label class="flex items-center gap-2 text-sm text-slate-700">
					<input type="checkbox" name="wouldRecommend" /> Would recommend working here
				</label>
				<label class="flex items-center gap-2 text-sm text-slate-700">
					<input type="checkbox" name="wouldRejoin" /> Would come back
				</label>
				<label class="text-sm text-slate-700 sm:col-span-2">
					Anything else?
					<textarea name="comments" maxlength={2000} class="{field} mt-1 block w-full"></textarea>
				</label>
				<div class="sm:col-span-2"><Button type="submit">Submit exit interview</Button></div>
			</form>
		{/if}
	</section>
{/if}

{#if data.leave}
	{@const lv = data.leave}
	<section class="mt-6 max-w-3xl panel" aria-label="Leave balance">
		<h2 class="section-title">
			Leave balance <span class="text-sm font-normal text-slate-500">FY {lv.fy}</span>
		</h2>
		{#if form && 'leaveAdjusted' in form}<Alert tone="info" message="Leave balance adjusted." />{/if}
		<dl class="mt-3 grid gap-2 text-sm sm:grid-cols-2">
			{#each lv.rows as b (b.id)}
				<div class="flex justify-between gap-3 rounded-md bg-slate-50 px-3 py-2" data-testid="leave-balance">
					<dt class="text-slate-600">{b.name}</dt>
					<dd class="font-medium text-slate-900">{b.unlimited ? 'no limit' : `${b.balance} days`}</dd>
				</div>
			{/each}
		</dl>
		{#if lv.canAdjust}
			<form method="POST" action="?/adjustLeave" class="mt-4 grid gap-3 sm:grid-cols-3">
				<label class="text-sm text-slate-700">
					Leave type
					<select name="leaveTypeId" required class="{field} mt-1 block w-full">
						{#each lv.rows.filter((b) => !b.unlimited) as b (b.id)}<option value={b.id}>{b.name}</option>{/each}
					</select>
				</label>
				<label class="text-sm text-slate-700">
					Days to add (negative to remove)
					<input name="days" type="number" step="0.5" min="-366" max="366" required class="{field} mt-1 block w-full" />
				</label>
				<label class="text-sm text-slate-700">
					Reason
					<input name="note" required maxlength={500} class="{field} mt-1 block w-full" />
				</label>
				<div class="sm:col-span-3"><Button type="submit" variant="secondary">Adjust balance</Button></div>
			</form>
		{/if}
	</section>
{/if}

{#if data.shift}
	{@const sh = data.shift}
	<section class="mt-6 max-w-3xl panel" aria-label="Shift">
		<h2 class="section-title">Shift</h2>
		{#if form && 'shiftSaved' in form}<Alert tone="info" message="Shift saved." />{/if}
		<p class="mt-2 text-sm text-slate-700" data-testid="current-shift">
			{sh.current
				? `${sh.current.name} · ${sh.current.startTime.slice(0, 5)}–${sh.current.endTime.slice(0, 5)}`
				: 'No shift'}
		</p>
		{#if sh.history.length}
			<ul class="mt-3 divide-y divide-slate-100 text-sm">
				{#each sh.history as a (a.id)}
					<li class="flex items-center gap-3 py-2" data-testid="shift-assignment">
						<span class="text-slate-800">From {a.effectiveFrom}: {a.name}</span>
						{#if sh.canManage}
							<form method="POST" action="?/removeShift" class="ml-auto">
								<input type="hidden" name="assignmentId" value={a.id} />
								<button
									type="submit"
									class="text-red-700 hover:underline"
									aria-label="Remove shift from {a.effectiveFrom}"
								>
									Remove
								</button>
							</form>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
		{#if sh.canManage}
			<form method="POST" action="?/assignShift" class="mt-4 grid gap-3 sm:grid-cols-3">
				<label class="text-sm text-slate-700">
					Shift
					<select name="shiftId" required class="{field} mt-1 block w-full">
						{#each sh.choices as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
					</select>
				</label>
				<label class="text-sm text-slate-700">
					Starting
					<input name="effectiveFrom" type="date" required min={e.joinDate} class="{field} mt-1 block w-full" />
				</label>
				<div class="flex flex-wrap items-end"><Button type="submit" variant="secondary">Assign shift</Button></div>
			</form>
		{/if}
	</section>
{/if}

{#if data.checklists.length}
	<section class="mt-6 max-w-3xl panel" aria-label="Checklists">
		<h2 class="section-title">Checklists</h2>
		{#if form && 'taskSaved' in form}<Alert tone="info" message="Checklist saved." />{/if}
		{#each data.checklists as c (c.id)}
			<h3 class="mt-4 text-sm font-medium text-slate-800">{c.name} · {c.kind} from {c.anchorDate}</h3>
			<ul class="mt-2 divide-y divide-slate-100 text-sm">
				{#each c.items as i (i.id)}
					<li class="flex items-center gap-3 py-2" data-testid="checklist-item">
						<span class={i.done ? 'text-slate-400 line-through' : 'text-slate-800'}>{i.title}</span>
						<span class="text-slate-500">{data.roleNames[i.assigneeRole] ?? i.assigneeRole} · due {i.dueDate}</span>
						{#if i.canComplete}
							<form method="POST" action="?/task" class="ml-auto">
								<input type="hidden" name="itemId" value={i.id} />
								<input type="hidden" name="done" value={String(!i.done)} />
								<button
									type="submit"
									class="text-brand-700 hover:underline"
									aria-label="{i.done ? 'Undo' : 'Done'}: {i.title}"
								>
									{i.done ? 'Undo' : 'Mark done'}
								</button>
							</form>
						{/if}
					</li>
				{/each}
			</ul>
		{/each}
	</section>
{/if}

{#if data.exit.canRehire}
	<section class="mt-6 max-w-3xl panel" aria-label="Rehire">
		<h2 class="section-title">Rehire</h2>
		<p class="mt-1 text-sm text-slate-600">Left on {e.exitDate}. Rehiring keeps the same code and history.</p>
		<form method="POST" action="?/rehire" class="mt-3 flex flex-wrap items-end gap-3">
			<label class="text-sm text-slate-700">
				New join date
				<input name="joinDate" type="date" required class="{field} mt-1 block" />
			</label>
			<Button type="submit">Rehire</Button>
		</form>
	</section>
{/if}

{#if data.canUpdate && data.choices}
	<form method="POST" action="?/save" class="mt-6 max-w-3xl panel">
		<h2 class="section-title mb-4">Edit record</h2>
		<div class="mb-4 space-y-2">
			<Alert message={form?.message} />
			{#if form && 'saved' in form}<Alert tone="info" message="Employee saved." />{/if}
		</div>
		<EmployeeForm {values} choices={data.choices} sensitive={data.canUpdateSensitive} selfId={e.id} />
		<div class="mt-6"><Button type="submit">Save changes</Button></div>
	</form>
{/if}

{#if data.documents}
	<section class="mt-6 max-w-3xl panel" aria-label="Documents">
		<h2 class="section-title">Documents</h2>
		<div class="mt-3 space-y-2">
			<Alert message={form && 'docMessage' in form ? form.docMessage : null} />
			{#if form && 'uploaded' in form}<Alert tone="info" message="Document uploaded." />{/if}
		</div>
		<ul class="mt-3 divide-y divide-slate-100 text-sm">
			{#each data.documents.rows as d (d.id)}
				<li class="flex items-center gap-3 py-2" data-testid="document">
					<a href="/t/{data.tenant.slug}/employees/{e.id}/documents/{d.id}" class="text-brand-700 hover:underline">
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

{#if data.hiring}
	<Attachments
		slug={data.tenant.slug}
		attachments={{ files: data.hiring.files, canEdit: false }}
		form={null}
		title="Files from hiring"
	/>
	{#if data.hiring.hasResume}
		<p class="mt-2 max-w-3xl text-sm">
			<a
				class="text-brand-700 underline"
				href="/t/{data.tenant.slug}/recruitment/candidates/{data.hiring.candidateId}/resume"
				download
			>
				Download resume
			</a>
		</p>
	{/if}
{/if}

{#if data.history.length}
	<section class="mt-6 max-w-3xl panel" aria-label="History">
		<h2 class="section-title">History</h2>
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
