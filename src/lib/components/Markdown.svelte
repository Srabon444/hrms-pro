<script lang="ts">
	import { renderMarkdown } from '#lib/markdown.ts';

	let { source, class: klass = '' }: { source: string; class?: string } = $props();
</script>

<div class="markdown {klass}">{@html renderMarkdown(source)}</div>
