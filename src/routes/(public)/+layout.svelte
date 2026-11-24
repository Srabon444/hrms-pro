<script lang="ts">
	let { children } = $props();
</script>

<div class="grid min-h-screen md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
	<aside class="hidden flex-col justify-between bg-brand-950 p-10 text-brand-100 md:flex">
		<p class="flex items-center gap-2.5 text-lg font-semibold text-white">
			<span class="grid size-9 place-items-center rounded-lg bg-brand-500" aria-hidden="true">H</span>
			HRMS
		</p>
		<p class="max-w-sm text-2xl leading-snug font-medium text-white">
			People, time and pay for the whole company, in one place.
		</p>
		<p class="text-sm text-brand-300">Each organisation sees only its own data.</p>
	</aside>
	<main class="grid place-items-center bg-slate-50 px-4 py-10">
		<div class="w-full max-w-sm">
			<p class="mb-6 text-center text-2xl font-bold tracking-tight text-brand-700 md:hidden">HRMS</p>
			<div class="panel space-y-5">
				{@render children()}
			</div>
		</div>
	</main>
</div>
