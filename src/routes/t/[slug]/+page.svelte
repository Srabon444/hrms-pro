<script lang="ts">
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head><title>{data.tenant.name} · HRMS</title></svelte:head>

<h1 class="text-2xl font-semibold text-slate-900">Welcome to {data.tenant.name}</h1>
{#if data.membership.status === 'ex_employee'}
	<p class="mt-2 text-slate-600">Your employment has ended. You can still download your documents and payslips.</p>
{/if}
