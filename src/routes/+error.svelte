<script lang="ts">
	import { page } from '$app/state';
</script>

<main class="grid min-h-screen place-items-center px-4 py-10">
	<div class="panel w-full max-w-md space-y-3 text-center">
		<p class="text-sm font-medium text-brand-700">Error {page.status}</p>
		<h1 class="page-title">{page.error?.message ?? 'Something went wrong'}</h1>
		<p class="text-sm text-slate-600">Check the link, or go back to where you were.</p>
		<a
			href="/"
			class="inline-block rounded-lg bg-brand-600 px-3.5 py-1.5 text-sm font-medium text-white no-underline hover:bg-brand-700"
		>
			Go to home
		</a>
	</div>
</main>
