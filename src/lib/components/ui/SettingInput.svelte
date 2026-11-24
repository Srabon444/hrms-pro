<script lang="ts">
	import type { SettingField } from '#lib/settings-sections.ts';
	import Field from './Field.svelte';

	let { field, value, locked = false }: { field: SettingField; value: number | boolean; locked?: boolean } = $props();
	const id = $props.id();
</script>

{#if field.kind === 'int'}
	<Field
		label="{field.label} ({field.unit})"
		name={field.key}
		type="number"
		required
		min={field.min}
		max={field.max}
		step={1}
		value={value as number}
		help={field.help}
	/>
{:else}
	<div>
		<label class="flex items-center gap-2 text-sm text-slate-700">
			<input
				type="checkbox"
				name={field.key}
				checked={value as boolean}
				disabled={locked}
				aria-describedby="{id}-help"
			/>
			{field.label}
		</label>
		<p id="{id}-help" class="mt-1 ml-6 text-xs text-slate-500">{field.help}</p>
	</div>
	{#if locked && value}<input type="hidden" name={field.key} value="on" />{/if}
{/if}
