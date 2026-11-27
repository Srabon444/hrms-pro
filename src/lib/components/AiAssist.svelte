<script lang="ts">
	import Button from '#lib/components/ui/Button.svelte';

	let {
		url,
		label,
		file,
		send = [],
		prefix = '',
		done = 'Filled in. Check every value before you save.'
	}: { url: string; label: string; file?: string; send?: string[]; prefix?: string; done?: string } = $props();

	let busy = $state(false);
	let message = $state('');
	let failed = $state(false);

	const field = (form: HTMLFormElement, name: string) =>
		form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;

	async function run(event: MouseEvent) {
		const form = (event.currentTarget as HTMLElement).closest('form');
		if (!form) return;
		const body = new FormData();
		const chosen = file ? (field(form, prefix + file) as HTMLInputElement | null)?.files?.[0] : undefined;
		if (file && !chosen) {
			failed = true;
			message = 'Choose a file first.';
			return;
		}
		if (chosen) body.set('file', chosen);
		send.forEach((name) => body.set(name, field(form, prefix + name)?.value ?? ''));
		busy = true;
		message = 'Working…';
		failed = false;
		const res = await fetch(url, { method: 'POST', body }).catch(() => null);
		const out = (await res?.json().catch(() => null)) as {
			fill?: Record<string, string>;
			note?: string;
			error?: string;
		} | null;
		busy = false;
		if (!res?.ok || !out?.fill) {
			failed = true;
			message = res?.redirected
				? 'Your session ended. Sign in again.'
				: (out?.error ?? 'AI is unavailable right now. Try again shortly.');
			return;
		}
		Object.entries(out.fill).forEach(([name, value]) => {
			const el = field(form, prefix + name);
			if (!el) return;
			el.value = value;
			el.dispatchEvent(new Event('input', { bubbles: true }));
			el.dispatchEvent(new Event('change', { bubbles: true }));
		});
		failed = !!out.note;
		message = out.note ? `${out.note} ${done}` : done;
	}
</script>

<span class="inline-flex flex-wrap items-center gap-2">
	<Button type="button" variant="secondary" disabled={busy} onclick={run}>{busy ? 'Working…' : label}</Button>
	<span aria-live="polite" data-testid="ai-note" class={['text-xs', failed ? 'text-amber-700' : 'text-slate-500']}>
		{message}
	</span>
</span>
