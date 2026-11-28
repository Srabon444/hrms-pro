<script lang="ts">
	import Markdown from '#lib/components/Markdown.svelte';
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import Field from '#lib/components/ui/Field.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const j = $derived(data.job);
	const input = 'mt-1 block w-full input';
</script>

<svelte:head><title>{j.title} · Careers · {data.tenant}</title></svelte:head>

<main class="mx-auto min-h-screen max-w-3xl bg-slate-50 px-4 py-10">
	<a class="text-sm text-brand-700 underline" href={`/careers/${data.slug}`}>All jobs at {data.tenant}</a>
	<h1 class="page-title mt-2">{j.title}</h1>
	{#if j.department || j.designation}
		<p class="mt-1 text-sm text-slate-600">{[j.designation, j.department].filter(Boolean).join(' · ')}</p>
	{/if}
	{#if j.description}
		<section class="mt-6 panel" aria-label="About the job"><Markdown source={j.description} /></section>
	{/if}

	<section class="mt-6 panel" aria-label="Apply">
		<h2 class="section-title">Apply</h2>
		{#if form && 'applied' in form}
			<div class="mt-3"><Alert tone="info" message="Thank you. Your application has been received." /></div>
		{:else}
			<div class="mt-3"><Alert message={form?.message} /></div>
			<form method="POST" enctype="multipart/form-data" class="mt-3 grid gap-3">
				<input type="hidden" name="formToken" value={data.formToken} />
				<label class="sr-only" aria-hidden="true">
					Website
					<input name="website" tabindex="-1" autocomplete="off" />
				</label>
				<Field label="Full name" name="fullName" required maxlength={120} autocomplete="name" />
				<Field label="Email" name="email" type="email" required maxlength={254} autocomplete="email" />
				<Field label="Phone (optional)" name="phone" type="tel" maxlength={40} pattern="[+\d][\d\s\-]*" />
				<label class="block text-sm font-medium text-slate-700">
					CV (PDF, up to 5 MB)
					<input name="cv" type="file" accept="application/pdf,.pdf" required class={input} />
				</label>
				<label class="flex items-start gap-2 text-sm text-slate-700">
					<input name="consent" type="checkbox" required class="mt-1" />
					<span>
						I agree that {data.contact.name} keeps my application and CV while this job is open and for up to {data.retentionDays}
						days after it closes or I am turned down. To have it deleted sooner, contact {data.contact.name}{data
							.contact.address
							? `, ${data.contact.address}`
							: ''}.
					</span>
				</label>
				<div><Button type="submit">Send application</Button></div>
			</form>
		{/if}
	</section>
</main>
