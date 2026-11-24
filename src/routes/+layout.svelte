<script lang="ts">
	import '../app.css';
	import favicon from '#lib/assets/favicon.svg';
	import { labelTables } from '#lib/tableLabels.ts';

	let { children } = $props();

	$effect(() => {
		document.documentElement.dataset.hydrated = '';
	});

	$effect(() => {
		let queued = false;
		const run = () => {
			queued = false;
			labelTables();
		};
		run();
		const observer = new MutationObserver(() => {
			if (queued) return;
			queued = true;
			requestAnimationFrame(run);
		});
		observer.observe(document.body, { childList: true, subtree: true });
		return () => observer.disconnect();
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>HRMS</title>
</svelte:head>

{@render children()}
