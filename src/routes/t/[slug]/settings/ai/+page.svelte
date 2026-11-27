<script lang="ts">
	import Alert from '#lib/components/ui/Alert.svelte';
	import Button from '#lib/components/ui/Button.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const s = $derived(data.settings);
	const PROVIDERS = [
		{ id: 'gemini', label: 'Google Gemini' },
		{ id: 'openai', label: 'OpenAI' },
		{ id: 'anthropic', label: 'Anthropic Claude' }
	] as const;
	const FEATURES = [
		{ id: 'ask', label: 'Ask HR', about: 'Answers questions about policies and the asker’s own records.' },
		{ id: 'ocr', label: 'Read files', about: 'Fills receipts, CVs and documents as suggestions to confirm.' },
		{ id: 'write', label: 'Writing help', about: 'Drafts announcements, job descriptions and helpdesk replies.' }
	] as const;
	const USAGE: Record<string, string> = {
		ask: 'Ask HR',
		ocr: 'Read files',
		write: 'Writing help',
		test: 'Connection tests',
		index: 'File indexing'
	};
	const input = 'mt-1 block w-full input';
	const fmt = (n: number) => n.toLocaleString('en');
	const used = $derived(data.usage.reduce((n, u) => n + u.tokens, 0));
	const budget = $derived(s.keyHint ? s.monthlyTokenBudget : Math.min(s.monthlyTokenBudget, data.platformBudget));
</script>

<svelte:head><title>AI · {data.tenant.name}</title></svelte:head>

<h1 class="page-title">AI</h1>
<p class="mt-1 text-sm text-slate-600">
	Use an AI provider to answer questions, read files and help with writing. AI only suggests; people still save
	everything themselves.
</p>

<div class="mt-6 max-w-2xl space-y-5">
	<Alert message={form?.message} />
	{#if form && 'saved' in form}<Alert tone="info" message="AI settings saved." />{/if}
	{#if form && 'removed' in form}<Alert tone="info" message="API key removed." />{/if}
	{#if form && 'tested' in form}
		<Alert
			tone="info"
			message={`Connection works. ${form.tested} answered${form.platform ? ' on the platform key' : ''}.`}
		/>
	{/if}

	<section class="panel space-y-2" aria-labelledby="ai-key">
		<h2 id="ai-key" class="text-sm font-semibold text-slate-800">API key</h2>
		{#if s.keyHint}
			<p class="text-sm text-slate-700">
				Your {PROVIDERS.find((p) => p.id === s.provider)?.label} key ending {s.keyHint} is in use{s.keySetAt
					? `, set ${new Date(s.keySetAt).toLocaleDateString('en-GB')}`
					: ''}. It is stored encrypted and never shown again.
			</p>
		{:else if data.platform}
			<p class="text-sm text-slate-700">
				No key of your own. AI uses the platform Gemini key, up to {fmt(data.platformBudget)} tokens a month.
			</p>
		{:else}
			<p class="text-sm text-slate-700">No key yet. Paste one below to use AI.</p>
		{/if}
		<div class="flex flex-wrap gap-2">
			<form method="POST" action="?/test"><Button type="submit" variant="secondary">Test connection</Button></form>
			{#if s.keyHint}
				<form method="POST" action="?/remove"><Button type="submit" variant="danger">Remove key</Button></form>
			{/if}
		</div>
	</section>

	<form method="POST" action="?/save" class="panel space-y-5" autocomplete="off">
		<label class="flex items-start gap-3">
			<input type="checkbox" name="enabled" checked={s.enabled} class="mt-1" />
			<span class="text-sm font-medium text-slate-800">Turn AI on for this company</span>
		</label>
		{#if !s.enabled}
			<label class="flex items-start gap-3">
				<input type="checkbox" name="consent" class="mt-1" />
				<span class="text-sm text-slate-700">
					I understand that the text and files a feature needs are sent to the chosen AI provider. Salary data is sent
					only if allowed below; ID, passport and bank numbers are never sent.
				</span>
			</label>
		{/if}

		<label class="block">
			<span class="text-sm font-medium text-slate-700">Provider</span>
			<select name="provider" class={input}>
				{#each PROVIDERS as p (p.id)}
					<option value={p.id} selected={s.provider === p.id}>{p.label}</option>
				{/each}
			</select>
		</label>

		<label class="block">
			<span class="text-sm font-medium text-slate-700">New API key</span>
			<input
				name="apiKey"
				type="password"
				autocomplete="off"
				maxlength="400"
				spellcheck="false"
				placeholder={s.keyHint ? 'Leave blank to keep the current key' : 'Paste the key'}
				aria-describedby="ai-key-help"
				class={input}
			/>
			<span id="ai-key-help" class="mt-1 block text-xs text-slate-500">
				The key is tested with one small call before it is saved.
			</span>
		</label>

		{#if data.models.length}
			<label class="block">
				<span class="text-sm font-medium text-slate-700">Model</span>
				<select name="model" class={input}>
					<option value="" selected={!s.model}>Best available (recommended)</option>
					{#each data.models as id (id)}
						<option value={id} selected={s.model === id}>{id}</option>
					{/each}
				</select>
			</label>
		{:else}
			<input type="hidden" name="model" value={s.model ?? ''} />
		{/if}

		<label class="block">
			<span class="text-sm font-medium text-slate-700">Monthly token budget</span>
			<input
				name="budget"
				type="number"
				min="0"
				max="1000000000"
				step="1"
				required
				value={s.monthlyTokenBudget}
				class={input}
			/>
		</label>

		<fieldset class="space-y-3">
			<legend class="text-sm font-medium text-slate-700">Features</legend>
			{#each FEATURES as f (f.id)}
				<label class="flex items-start gap-3">
					<input type="checkbox" name="features" value={f.id} checked={s.features[f.id]} class="mt-1" />
					<span>
						<span class="block text-sm font-medium text-slate-800">{f.label}</span>
						<span class="block text-sm text-slate-600">{f.about}</span>
					</span>
				</label>
			{/each}
		</fieldset>

		<label class="flex items-start gap-3">
			<input type="checkbox" name="sendPayroll" checked={s.sendPayroll} class="mt-1" />
			<span class="text-sm text-slate-700">
				Allow a person’s own payslip figures to be sent when they ask about them
			</span>
		</label>

		<Button type="submit">Save AI settings</Button>
	</form>

	<section class="panel" aria-labelledby="ai-usage">
		<h2 id="ai-usage" class="text-sm font-semibold text-slate-800">This month</h2>
		<p class="mt-1 text-sm text-slate-600">{fmt(used)} of {fmt(budget)} tokens used.</p>
		{#if data.usage.length}
			<div class="mt-3 overflow-x-auto">
				<table class="w-full text-sm">
					<thead class="text-left text-slate-500">
						<tr>
							<th class="py-1 pr-3">Feature</th><th class="py-1 pr-3">Calls</th><th class="py-1 pr-3">Failed</th><th
								class="py-1"
							>
								Tokens
							</th>
						</tr>
					</thead>
					<tbody>
						{#each data.usage as u (u.feature)}
							<tr class="border-t border-slate-100">
								<td class="py-1 pr-3">{USAGE[u.feature] ?? u.feature}</td>
								<td class="py-1 pr-3">{fmt(u.calls)}</td>
								<td class="py-1 pr-3">{fmt(u.failed)}</td>
								<td class="py-1">{fmt(u.tokens)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>
</div>
