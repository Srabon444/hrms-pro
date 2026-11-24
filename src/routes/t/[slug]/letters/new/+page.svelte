<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import Field from '#lib/components/ui/Field.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const values = $derived((form?.values ?? { subject: data.subject, body: data.body }) as Record<string, string>);
</script>

<svelte:head><title>Prepare letter · {data.tenant.name}</title></svelte:head>

<a class="text-sm text-brand-700 underline" href={`/t/${data.tenant.slug}/letters`}>All letters</a>
<h1 class="page-title mt-2">{data.template.name} for {data.employee.name}</h1>
<p class="mt-1 max-w-3xl text-sm text-slate-600">
	Check the text and fill in anything still in double braces. The letter is saved as a PDF and shared with the employee
	once you issue it.
</p>

<div class="mt-4 max-w-3xl"><Alert message={form?.message} /></div>

<form
	method="POST"
	action={`?employeeId=${data.employee.id}&templateId=${data.template.id}&/issue`}
	class="mt-4 grid max-w-3xl gap-3"
>
	<input type="hidden" name="employeeId" value={data.employee.id} />
	<input type="hidden" name="templateId" value={data.template.id} />
	<Field label="Subject" name="subject" required maxlength={160} value={values.subject} />
	<label class="block text-sm font-medium text-slate-700">
		Letter
		<textarea name="body" required maxlength={20000} rows="16" class="mt-1 block w-full input font-mono"
			>{values.body}</textarea
		>
	</label>
	<div><Button type="submit">Issue letter</Button></div>
</form>
