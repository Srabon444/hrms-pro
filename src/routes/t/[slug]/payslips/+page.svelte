<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import Field from '#lib/components/ui/Field.svelte';
	import { money } from '#lib/money.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const PDF_MIN = $derived(data.pdf.min);
	const PDF_MAX = $derived(data.pdf.max);
</script>

<svelte:head><title>My payslips · {data.tenant.name}</title></svelte:head>

<h1 class="page-title">My payslips</h1>

{#if data.payslips.length}
	<ul class="mt-6 max-w-xl divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
		{#each data.payslips as p (p.id)}
			<li class="flex items-center justify-between px-4 py-3 text-sm" data-testid="my-payslip">
				<span class="text-slate-800">{p.period}{p.name ? ` · ${p.name}` : ''} · Net {money(p.net, p.currency)}</span>
				<a href="/t/{data.tenant.slug}/payslips/{p.id}/pdf" class="text-brand-700 hover:underline">
					Download PDF of {p.period}{p.name ? ` ${p.name}` : ''}
				</a>
			</li>
		{/each}
	</ul>
{:else}
	<p class="mt-6 text-sm text-slate-500">No payslips yet. They appear here once payroll is paid.</p>
{/if}

{#if data.pdf.canSet}
	<section class="mt-8 max-w-xl space-y-3 panel" aria-label="Payslip PDF password">
		<h2 class="section-title">Payslip PDF password</h2>
		<p class="text-sm text-slate-600">
			{#if data.pdf.emailed}
				Set a password and your payslip email will carry the PDF, locked with it. Without one you get the link only.
			{:else}
				Your organisation sends payslip emails with a link only. A password you set now is used if they start attaching
				the PDF.
			{/if}
			Use {PDF_MIN} to {PDF_MAX} characters, different from your sign-in password. Downloads here are not locked.
		</p>
		<Alert message={form?.message} />
		{#if form && 'pdfPasswordSaved' in form}<Alert tone="info" message="Payslip password saved." />{/if}
		{#if form && 'pdfPasswordRemoved' in form}<Alert tone="info" message="Payslip password removed." />{/if}
		<p class="text-sm font-medium text-slate-800" data-testid="pdf-password-state">
			{data.pdf.passwordSet ? 'A payslip password is set.' : 'No payslip password yet.'}
		</p>
		<form method="POST" action="?/setPdfPassword" class="space-y-3">
			<Field
				label="New payslip password"
				name="password"
				type="password"
				autocomplete="new-password"
				required
				minlength={PDF_MIN}
				maxlength={PDF_MAX}
			/>
			<Field
				label="Repeat it"
				name="confirm"
				type="password"
				autocomplete="new-password"
				required
				minlength={PDF_MIN}
				maxlength={PDF_MAX}
			/>
			<Button type="submit">{data.pdf.passwordSet ? 'Change password' : 'Set password'}</Button>
		</form>
		{#if data.pdf.passwordSet}
			<form method="POST" action="?/removePdfPassword">
				<Button type="submit" variant="secondary">Remove password</Button>
			</form>
		{/if}
	</section>
{/if}
