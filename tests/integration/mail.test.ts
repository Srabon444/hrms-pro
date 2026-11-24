import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import { processors } from '../../src/lib/server/jobs';
import { sendMail } from '../../src/lib/server/mail';
import { closeQueues, startWorker } from '../../src/lib/server/queue';
import { waitForMail } from '../mailpit';

const worker = startWorker('mail', processors.mail);

afterAll(async () => {
	await worker.close();
	await closeQueues();
});

it('delivers queued mail through the worker to SMTP', async () => {
	const to = `${randomUUID()}@test.local`;
	await sendMail({ to, subject: 'Queued hello', text: 'Body line http://localhost/x' });
	const got = await waitForMail(to);
	expect(got.subject).toBe('Queued hello');
	expect(got.text).toContain('Body line');
});
