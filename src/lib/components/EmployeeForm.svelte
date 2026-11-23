<script lang="ts">
	import Field from '#lib/components/ui/Field.svelte';

	type Choice = { id: string; name: string };
	let {
		values = {},
		choices,
		sensitive = false,
		selfId = null
	}: {
		values?: Record<string, unknown>;
		choices: {
			departments: Choice[];
			designations: Choice[];
			grades: Choice[];
			branches: Choice[];
			managers: Choice[];
		};
		sensitive?: boolean;
		selfId?: string | null;
	} = $props();

	const v = (k: string) => (typeof values[k] === 'string' ? (values[k] as string) : '');
	const select = 'mt-1 block w-full rounded-md border border-slate-300 px-3 py-2';
	const lists = $derived([
		{ name: 'departmentId', label: 'Department', options: choices.departments },
		{ name: 'designationId', label: 'Designation', options: choices.designations },
		{ name: 'gradeId', label: 'Grade', options: choices.grades },
		{ name: 'branchId', label: 'Branch', options: choices.branches },
		{ name: 'managerId', label: 'Manager', options: choices.managers.filter((m) => m.id !== selfId) }
	]);
</script>

<fieldset class="grid gap-4 sm:grid-cols-2">
	<legend class="mb-2 font-semibold text-slate-900">Personal</legend>
	<Field label="Full name" name="fullName" required maxlength={160} value={v('fullName')} />
	<Field label="Work email" name="workEmail" type="email" value={v('workEmail')} />
	<Field label="Personal email" name="personalEmail" type="email" value={v('personalEmail')} />
	<Field label="Phone" name="phone" maxlength={30} value={v('phone')} />
	<Field label="Date of birth" name="dateOfBirth" type="date" value={v('dateOfBirth')} />
	<label class="block text-sm font-medium text-slate-700">
		Gender
		<select name="gender" class={select}>
			<option value="">Not set</option>
			{#each ['female', 'male', 'other', 'undisclosed'] as g (g)}<option value={g} selected={v('gender') === g}>
					{g}
				</option>{/each}
		</select>
	</label>
	<label class="block text-sm font-medium text-slate-700">
		Blood group
		<select name="bloodGroup" class={select}>
			<option value="">Not set</option>
			{#each ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as g (g)}<option
					value={g}
					selected={v('bloodGroup') === g}
				>
					{g}
				</option>{/each}
		</select>
	</label>
	<div class="sm:col-span-2">
		<Field label="Present address" name="presentAddress" maxlength={500} value={v('presentAddress')} />
	</div>
	<div class="sm:col-span-2">
		<Field label="Permanent address" name="permanentAddress" maxlength={500} value={v('permanentAddress')} />
	</div>
</fieldset>

<fieldset class="mt-6 grid gap-4 sm:grid-cols-2">
	<legend class="mb-2 font-semibold text-slate-900">Employment</legend>
	{#each lists as list (list.name)}
		<label class="block text-sm font-medium text-slate-700">
			{list.label}
			<select name={list.name} class={select}>
				<option value="">None</option>
				{#each list.options as o (o.id)}<option value={o.id} selected={v(list.name) === o.id}>{o.name}</option>{/each}
			</select>
		</label>
	{/each}
	<label class="block text-sm font-medium text-slate-700">
		Employment type
		<select name="employmentType" class={select}>
			{#each [['full_time', 'Full time'], ['part_time', 'Part time'], ['contract', 'Contract'], ['intern', 'Intern']] as [val, label] (val)}
				<option value={val} selected={(v('employmentType') || 'full_time') === val}>{label}</option>
			{/each}
		</select>
	</label>
	<label class="block text-sm font-medium text-slate-700">
		Status
		<select name="status" class={select}>
			{#each ['onboarding', 'probation', 'active', 'notice'] as s (s)}
				<option value={s} selected={(v('status') || 'onboarding') === s}>{s}</option>
			{/each}
		</select>
	</label>
	<Field label="Join date" name="joinDate" type="date" required value={v('joinDate')} />
	<Field label="Probation ends" name="probationEndDate" type="date" value={v('probationEndDate')} />
	<Field label="Confirmed on" name="confirmationDate" type="date" value={v('confirmationDate')} />
</fieldset>

{#if sensitive}
	<fieldset class="mt-6 grid gap-4 sm:grid-cols-2">
		<legend class="mb-2 font-semibold text-slate-900">Identity and bank</legend>
		<Field label="National ID" name="nationalId" maxlength={40} value={v('nationalId')} />
		<Field label="Passport number" name="passportNumber" maxlength={40} value={v('passportNumber')} />
		<Field label="Tax ID (TIN)" name="taxId" maxlength={40} value={v('taxId')} />
		<Field label="Bank name" name="bankName" maxlength={120} value={v('bankName')} />
		<Field label="Account name" name="bankAccountName" maxlength={160} value={v('bankAccountName')} />
		<Field label="Account number" name="bankAccountNumber" maxlength={40} value={v('bankAccountNumber')} />
	</fieldset>
{/if}
