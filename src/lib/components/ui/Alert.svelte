<script lang="ts">
	let { message, tone = 'error' }: { message?: string | null; tone?: 'error' | 'info' } = $props();
</script>

{#if message}
	<p
		role={tone === 'error' ? 'alert' : 'status'}
		class={[
			'rounded-lg px-3 py-2 text-sm ring-1 ring-inset',
			tone === 'error' ? 'bg-red-50 text-red-700 ring-red-200' : 'bg-brand-50 text-brand-800 ring-brand-200'
		]}
	>
		{message}
	</p>
{/if}
