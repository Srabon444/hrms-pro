export type IcsTime = { date: string } | { utc: string };

export type IcsEvent = {
	uid: string;
	summary: string;
	description?: string;
	location?: string;
	start: IcsTime;
	end: IcsTime;
};

const encoder = new TextEncoder();

export const icsEscape = (value: string) =>
	value
		.replace(/[\\;,]/g, (c) => `\\${c}`)
		.replace(/\r\n|\r|\n/g, '\\n')
		.replace(/\p{Cc}/gu, '');

export function icsFold(line: string): string {
	const parts: string[] = [];
	let current = '';
	let size = 0;
	for (const ch of line) {
		const n = encoder.encode(ch).length;
		if (size + n > (parts.length ? 74 : 75)) {
			parts.push(current);
			current = '';
			size = 0;
		}
		current += ch;
		size += n;
	}
	parts.push(current);
	return parts.join('\r\n ');
}

const compact = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d+/, '');

const timeProp = (name: string, t: IcsTime) =>
	'date' in t ? `${name};VALUE=DATE:${compact(t.date)}` : `${name}:${compact(t.utc)}`;

export function icsCalendar(name: string, stamp: Date, events: IcsEvent[]): string {
	const dtstamp = compact(stamp.toISOString());
	const lines = [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//HRMS Pro//Team calendar//EN',
		'CALSCALE:GREGORIAN',
		'METHOD:PUBLISH',
		`X-WR-CALNAME:${icsEscape(name)}`
	];
	for (const e of events) {
		lines.push(
			'BEGIN:VEVENT',
			`UID:${e.uid}`,
			`DTSTAMP:${dtstamp}`,
			timeProp('DTSTART', e.start),
			timeProp('DTEND', e.end),
			`SUMMARY:${icsEscape(e.summary)}`
		);
		if (e.description) lines.push(`DESCRIPTION:${icsEscape(e.description)}`);
		if (e.location) lines.push(`LOCATION:${icsEscape(e.location)}`);
		lines.push('TRANSP:TRANSPARENT', 'END:VEVENT');
	}
	lines.push('END:VCALENDAR');
	return `${lines.map(icsFold).join('\r\n')}\r\n`;
}
