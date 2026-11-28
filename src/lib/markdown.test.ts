import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown';

describe('renderMarkdown', () => {
	it('renders the safe subset', () => {
		expect(
			renderMarkdown('# Role\n\nWe **build** things *fast*.\nSecond line\n\n- one\n- two\n\n1. first\n2. second')
		).toBe(
			'<h3>Role</h3><p>We <strong>build</strong> things <em>fast</em>.<br>Second line</p>' +
				'<ul><li>one</li><li>two</li></ul><ol><li>first</li><li>second</li></ol>'
		);
		expect(renderMarkdown('See [our site](https://example.com/a?b=1&c=2).')).toBe(
			'<p>See <a href="https://example.com/a?b=1&amp;c=2" rel="noopener nofollow ugc" target="_blank">our site</a>.</p>'
		);
		expect(renderMarkdown('[x](https://e.com/*a*)')).toContain('href="https://e.com/*a*"');
	});

	const corpus = [
		'<script>alert(1)</script>',
		'<img src=x onerror=alert(1)>',
		'![pic](https://e.com/p.png)',
		'[x](javascript:alert(1))',
		'[x](JAVASCRIPT:alert(1))',
		'[x](data:text/html,<script>alert(1)</script>)',
		'[x](https://e.com" onmouseover="alert(1))',
		"[x](https://e.com' onmouseover='alert(1))",
		'[<img src=x onerror=alert(1)>](https://e.com)',
		'**<svg onload=alert(1)>**',
		'# <iframe src="https://evil">',
		'- <a href="javascript:alert(1)">x</a>',
		'<style>body{display:none}</style>',
		'\uE000[x](https://e.com)\uE0000\uE000',
		'&lt;script&gt;',
		'[x](https://e.com/\n"onclick="alert(1))'
	];

	it.each(corpus)('never emits active markup for %s', (input) => {
		const html = renderMarkdown(input);
		for (const [tag, name, attrs] of html.matchAll(/<\/?([a-z0-9]+)([^>]*)>/gi)) {
			expect(['p', 'br', 'strong', 'em', 'ul', 'ol', 'li', 'h3', 'h4', 'h5', 'a'], tag).toContain(name);
			expect(attrs.replace(/ href="https?:\/\/[^"'<>\s]+" rel="noopener nofollow ugc" target="_blank"/, ''), tag).toBe(
				''
			);
		}
	});
});
