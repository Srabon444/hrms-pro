<script lang="ts" module>
	const TONES: Record<string, string> = {
		approved: 'good',
		paid: 'good',
		active: 'good',
		available: 'good',
		resolved: 'good',
		deducted: 'good',
		present: 'good',
		ordered: 'good',
		open: 'info',
		in_progress: 'info',
		assigned: 'info',
		issued: 'info',
		requested: 'warn',
		submitted: 'warn',
		pending: 'warn',
		waiting: 'warn',
		partially_paid: 'warn',
		on_hold: 'warn',
		repair: 'warn',
		invited: 'warn',
		rejected: 'bad',
		cancelled: 'bad',
		void: 'bad',
		lost: 'bad',
		disabled: 'bad',
		suspended: 'bad',
		ex_employee: 'bad'
	};
	const CLASSES: Record<string, string> = {
		good: 'bg-brand-50 text-brand-800 ring-brand-200',
		info: 'bg-sky-50 text-sky-800 ring-sky-200',
		warn: 'bg-amber-50 text-amber-800 ring-amber-200',
		bad: 'bg-red-50 text-red-700 ring-red-200',
		neutral: 'bg-slate-100 text-slate-700 ring-slate-200'
	};
</script>

<script lang="ts">
	let { status, label }: { status: string; label?: string } = $props();
</script>

<span
	class={[
		'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset',
		CLASSES[TONES[status] ?? 'neutral']
	]}
>
	{label ?? status.replace(/_/g, ' ')}
</span>
