import { expect, it } from 'vitest';
import { renderSignatureCertificate } from './esign';

const signer = (i: number) => ({
	sortOrder: i,
	name: i % 2 ? `Nguyễn রহিম ${i}` : `Signer ${i}`,
	email: `s${i}@example.com`,
	signedAt: new Date('2026-11-28T06:00:00Z'),
	typedName: `Signer ${i}`,
	method: i % 2 ? ('email_otp' as const) : ('session' as const),
	ip: '198.51.100.7',
	userAgent: 'Mozilla/5.0 '.repeat(40)
});

it('renders every signer of a long request onto further pages', async () => {
	const pdf = Buffer.from(
		await renderSignatureCertificate({
			company: 'Acme Ltd',
			request: {
				id: '00000000-0000-4000-8000-000000000000',
				title: 'Employment contract',
				fileName: 'contract.pdf',
				fileSize: 1234,
				sha256: 'a'.repeat(64),
				sentAt: new Date('2026-11-27T06:00:00Z'),
				completedAt: new Date('2026-11-28T06:00:00Z')
			},
			signers: Array.from({ length: 10 }, (_, i) => signer(i + 1))
		})
	).toString('latin1');
	expect(pdf.startsWith('%PDF-')).toBe(true);
	expect(pdf.match(/\/Type \/Page\b/g)!.length).toBeGreaterThan(1);
	expect(pdf).toContain('NotoSansBengali');
});
