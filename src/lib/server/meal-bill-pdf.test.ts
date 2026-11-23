import { expect, it } from 'vitest';
import { renderBillPdf } from './meal-bill-pdf';

it('renders a bill with Bengali and English text into a PDF', async () => {
	const lines = Array.from({ length: 40 }, (_, i) => ({
		date: `2026-02-${String((i % 28) + 1).padStart(2, '0')}`,
		meal: i % 2 ? 'Lunch' : 'দুপুরের খাবার',
		kind: i === 39 ? 'adjustment' : 'meal',
		plates: 1,
		guests: i % 5 ? 0 : 2,
		amount: 4026
	}));
	const pdf = await renderBillPdf({
		company: 'Acme Ltd',
		period: '2026-02',
		employee: 'আনা রহমান',
		code: 'E-001',
		billingMode: 'direct',
		total: 161040,
		paid: 10050,
		lines
	});
	const text = Buffer.from(pdf).toString('latin1');
	expect(text.startsWith('%PDF-')).toBe(true);
	expect(text.match(/\/Type \/Page\b/g)).toHaveLength(2);
	expect(text).toContain('NotoSansBengali');
});
