import { describe, expect, it, vi } from 'vitest';
import { askHr, askInput, ASK_TOOLS } from './ask';
import { generate } from './service';

vi.mock('./service', () => ({ generate: vi.fn() }));
vi.mock('../tenancy', () => ({ withTenant: (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock('../lifecycle', () => ({ tenantToday: async () => '2026-11-27' }));

const form = (question: string, history?: string) => {
	const f = new FormData();
	f.set('question', question);
	if (history !== undefined) f.set('history', history);
	return f;
};

describe('askInput', () => {
	it('keeps the question and up to six earlier turns', () => {
		const turns = Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `t${i}` }));
		expect(askInput(form('  How much leave?  ', JSON.stringify(turns)))).toEqual({
			question: 'How much leave?',
			history: turns
		});
		expect(askInput(form('Hi')).history).toEqual([]);
	});

	it('refuses empty or long questions and history it cannot trust', () => {
		expect(() => askInput(form(' '))).toThrow('Type a question first.');
		expect(() => askInput(form('x'.repeat(501)))).toThrow('under 500');
		expect(() => askInput(form('Hi', '{'))).toThrow('Start a new conversation');
		expect(() => askInput(form('Hi', JSON.stringify([{ role: 'system', text: 'x' }])))).toThrow('Start a new');
		expect(() => askInput(form('Hi', JSON.stringify(Array(7).fill({ role: 'user', text: 'x' }))))).toThrow(
			'Start a new'
		);
	});

	it('offers read-only tools only', () => {
		expect(ASK_TOOLS).toEqual([
			'my_leave_balances',
			'my_leave_requests',
			'my_attendance',
			'holidays',
			'search_policies',
			'my_payslip',
			'who_is_out'
		]);
	});
});

describe('askHr', () => {
	it('stops after four tool calls and never runs object keys as tools', async () => {
		const names = ['constructor', '__proto__', 'hasOwnProperty', 'toString', 'valueOf', 'valueOf'];
		const calls = vi.mocked(generate);
		calls.mockReset();
		names.forEach((tool) =>
			calls.mockResolvedValueOnce({ json: { action: 'tool', tool, arg: '', answer: 'done', cites: [] } } as never)
		);
		const m = { tenant: { id: 't' }, user: { userId: 'u' }, access: { employeeId: null, grants: {} } };
		expect(await askHr(m as never, form('Hi'))).toEqual({ answer: 'done', sources: [] });
		expect(calls).toHaveBeenCalledTimes(5);
		const last = calls.mock.calls[4][2].parts.map((p) => ('text' in p ? p.text : ''));
		expect(last.at(-1)).toBe('No more tools: answer now.');
		expect(last.filter((t) => t.startsWith('TOOL RESULT '))).toEqual(
			names.slice(0, 4).map((n) => `TOOL RESULT ${n}():\nThere is no tool called ${n}.`)
		);
	});
});
