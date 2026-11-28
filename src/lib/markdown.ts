const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c]);

function inline(raw: string) {
	const links: string[] = [];
	const text = escape(raw)
		.replace(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s()<>]{1,2000})\)/g, (_, label: string, url: string) => {
			links.push(`<a href="${url}" rel="noopener nofollow ugc" target="_blank">${label}</a>`);
			return `\uE000${links.length - 1}\uE000`;
		})
		.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
		.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
	return text.replace(/\uE000(\d+)\uE000/g, (_, i: string) => links[Number(i)]);
}

const LIST = { ul: /^\s*[-*]\s+(.*)$/, ol: /^\s*\d{1,3}[.)]\s+(.*)$/ } as const;

export function renderMarkdown(source: string): string {
	const out: string[] = [];
	let para: string[] = [];
	let list = null as { tag: 'ul' | 'ol'; items: string[] } | null;
	const flush = () => {
		if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
		if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
		para = [];
		list = null;
	};
	for (const line of source.replaceAll('\uE000', '').split(/\r?\n/)) {
		const heading = /^(#{1,3})\s+(.*)$/.exec(line);
		const item = (['ul', 'ol'] as const).map((tag) => [tag, LIST[tag].exec(line)] as const).find(([, m]) => m);
		if (!line.trim()) flush();
		else if (heading) {
			flush();
			out.push(`<h${heading[1].length + 2}>${inline(heading[2])}</h${heading[1].length + 2}>`);
		} else if (item) {
			const [tag, m] = item;
			if (para.length || list?.tag !== tag) flush();
			list ??= { tag, items: [] };
			list.items.push(m![1]);
		} else {
			if (list) flush();
			para.push(line.trim());
		}
	}
	flush();
	return out.join('');
}
