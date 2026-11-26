import { describe, expect, it } from 'vitest';
import { icsCalendar, icsEscape, icsFold, type IcsEvent } from './ics';

type Prop = { name: string; params: Record<string, string>; value: string };
type Component = { name: string; props: Prop[]; children: Component[] };

const CONTENT_LINE = /^([A-Za-z0-9-]+)((?:;[A-Za-z0-9-]+=(?:"[^"]*"|[^";:,]*))*):(.*)$/;
const DATE = /^\d{8}$/;
const UTC = /^\d{8}T\d{6}Z$/;

function parse(text: string): Component {
	expect(text.endsWith('\r\n')).toBe(true);
	const physical = text.slice(0, -2).split('\r\n');
	for (const line of physical) {
		expect(new TextEncoder().encode(line).length, line).toBeLessThanOrEqual(75);
		expect(line).not.toMatch(/[\r\n]/);
	}
	const logical = text
		.slice(0, -2)
		.replace(/\r\n[ \t]/g, '')
		.split('\r\n');
	const stack: Component[] = [{ name: 'ROOT', props: [], children: [] }];
	for (const line of logical) {
		const m = CONTENT_LINE.exec(line);
		expect(m, line).not.toBeNull();
		const [, name, rawParams, value] = m!;
		const params = Object.fromEntries(
			rawParams
				.split(';')
				.filter(Boolean)
				.map((p) => p.split('='))
		);
		if (name === 'BEGIN') {
			const c = { name: value, props: [], children: [] };
			stack.at(-1)!.children.push(c);
			stack.push(c);
		} else if (name === 'END') {
			expect(stack.pop()!.name).toBe(value);
		} else stack.at(-1)!.props.push({ name, params, value });
	}
	expect(stack).toHaveLength(1);
	expect(stack[0].children).toHaveLength(1);
	return stack[0].children[0];
}

const unescape = (v: string) => v.replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
const one = (c: Component, name: string) => {
	const found = c.props.filter((p) => p.name === name);
	expect(found, `${c.name} ${name}`).toHaveLength(1);
	return found[0];
};

function checkEvent(e: Component) {
	one(e, 'UID');
	expect(one(e, 'DTSTAMP').value).toMatch(UTC);
	const start = one(e, 'DTSTART');
	const end = one(e, 'DTEND');
	expect(start.params.VALUE).toBe(end.params.VALUE);
	expect(start.value).toMatch(start.params.VALUE === 'DATE' ? DATE : UTC);
	expect(end.value).toMatch(end.params.VALUE === 'DATE' ? DATE : UTC);
	expect(end.value > start.value).toBe(true);
	for (const p of e.props)
		if (['SUMMARY', 'DESCRIPTION', 'LOCATION'].includes(p.name)) expect(p.value).not.toMatch(/(^|[^\\])[,;]/);
}

const events: IcsEvent[] = [
	{
		uid: 'holiday-1@hrms-pro',
		summary: 'New Year; office closed, see you',
		start: { date: '2027-01-01' },
		end: { date: '2027-01-02' }
	},
	{
		uid: 'event-2@hrms-pro',
		summary: 'Ünïcödé 祝日 — ' + 'long title '.repeat(12),
		description: 'Line one\nLine two with a back\\slash',
		location: 'Room 4, Floor 2',
		start: { utc: '2026-12-01T09:30:00.000Z' },
		end: { utc: '2026-12-01T11:00:00.000Z' }
	}
];

describe('ics writer', () => {
	it('escapes text and strips control characters', () => {
		expect(icsEscape('a,b;c\\d\ne\u0007')).toBe('a\\,b\\;c\\\\d\\ne');
	});

	it('folds at 75 octets without splitting a multi-byte character', () => {
		const folded = icsFold(`SUMMARY:${'祝'.repeat(40)}`);
		const lines = folded.split('\r\n');
		expect(lines.length).toBeGreaterThan(1);
		for (const l of lines) expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
		expect(folded.replace(/\r\n /g, '')).toBe(`SUMMARY:${'祝'.repeat(40)}`);
	});

	it('writes a calendar that parses back to the same events', () => {
		const cal = parse(icsCalendar('Team, Acme', new Date('2026-11-26T06:00:00Z'), events));
		expect(cal.name).toBe('VCALENDAR');
		expect(one(cal, 'VERSION').value).toBe('2.0');
		one(cal, 'PRODID');
		expect(unescape(one(cal, 'X-WR-CALNAME').value)).toBe('Team, Acme');
		expect(cal.children.map((c) => c.name)).toEqual(['VEVENT', 'VEVENT']);
		cal.children.forEach(checkEvent);
		const [holiday, event] = cal.children;
		expect(one(holiday, 'DTSTART').value).toBe('20270101');
		expect(one(holiday, 'DTEND').value).toBe('20270102');
		expect(unescape(one(holiday, 'SUMMARY').value)).toBe(events[0].summary);
		expect(one(event, 'DTSTART').value).toBe('20261201T093000Z');
		expect(unescape(one(event, 'SUMMARY').value)).toBe(events[1].summary);
		expect(unescape(one(event, 'DESCRIPTION').value)).toBe(events[1].description);
		expect(unescape(one(event, 'LOCATION').value)).toBe(events[1].location);
	});

	it('writes an empty calendar', () => {
		expect(parse(icsCalendar('Empty', new Date(), [])).children).toEqual([]);
	});
});
