const base = () => process.env.MAILPIT_URL ?? 'http://localhost:58025';

export type ReceivedMail = { subject: string; text: string };

export async function waitForMail(to: string, timeoutMs = 15_000, subject?: string): Promise<ReceivedMail> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const res = await fetch(
			`${base()}/api/v1/search?query=${encodeURIComponent(`to:"${to}"${subject ? ` subject:"${subject}"` : ''}`)}`
		);
		const found = (await res.json()) as { messages: { ID: string; Subject: string }[] };
		const latest = found.messages?.[0];
		if (latest) {
			const msg = (await (await fetch(`${base()}/api/v1/message/${latest.ID}`)).json()) as { Text: string };
			return { subject: latest.Subject, text: msg.Text };
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(`no mail for ${to} within ${timeoutMs}ms`);
}

export const mailLink = (text: string): string => {
	const m = text.match(/https?:\/\/\S+/);
	if (!m) throw new Error(`no link in mail: ${text}`);
	return m[0];
};
