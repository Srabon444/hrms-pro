<script lang="ts">
	let { children } = $props();
</script>

<main class="grid min-h-screen place-items-center bg-slate-50 px-4 py-10">
	<div class="w-full max-w-sm">
		<p class="mb-6 text-center text-2xl font-bold tracking-tight text-indigo-700">HRMS</p>
		<div class="space-y-5 rounded-xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
			{@render children()}
		</div>
	</div>
</main>
