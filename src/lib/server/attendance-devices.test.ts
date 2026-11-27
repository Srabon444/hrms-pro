import { describe, expect, it } from 'vitest';
import { DEVICE_KEY, readBatch } from './attendance-devices';
import { OPENAPI } from './public/openapi';

const throws = (raw: unknown) => {
	try {
		readBatch(raw);
		return 'ok';
	} catch (e) {
		return (e as { issues: { message: string }[] }).issues[0].message;
	}
};

describe('device punch batches', () => {
	it('keeps good punches and lists bad ones by position', () => {
		const { ok, rejected } = readBatch({
			punches: [
				{ deviceUserId: ' 101 ', at: '2026-11-27T09:00:00+06:00', direction: 'in' },
				{ employeeCode: 'E-1', at: '2026-11-27T03:00:00Z' },
				{ at: '2026-11-27T09:00:00+06:00' },
				{ deviceUserId: '1', at: '2026-11-27 09:00' },
				{ deviceUserId: '1', at: '2026-11-27T09:00:00+06:00', direction: 'up' },
				{ deviceUserId: 'x'.repeat(33), at: '2026-11-27T09:00:00+06:00' },
				'nope'
			]
		});
		expect(ok.map((p) => [p.index, p.deviceUserId ?? p.employeeCode, p.at.toISOString(), p.direction])).toEqual([
			[0, '101', '2026-11-27T03:00:00.000Z', 'in'],
			[1, 'E-1', '2026-11-27T03:00:00.000Z', undefined]
		]);
		expect(rejected.map((r) => [r.index, r.reason])).toEqual([2, 3, 4, 5, 6].map((i) => [i, 'invalid']));
		expect(rejected[0].message).toBe('Send deviceUserId or employeeCode.');
	});

	it('refuses a batch that is not a list of 1 to 500', () => {
		expect(throws({ punches: [] })).toBe('Send at least one punch.');
		expect(throws({ punches: Array(501).fill({}) })).toBe('Send at most 500 punches at a time.');
		expect(throws({ punches: 'x' })).toBe('Send punches as a list.');
		expect(throws([])).toBe('Send a JSON object with a punches list.');
		expect(throws({ punches: Array(500).fill({}) })).toBe('ok');
	});

	it('only accepts keys shaped like device keys and documents the endpoint', () => {
		expect(DEVICE_KEY.test(`hrd_0a1b2c3d_${'A'.repeat(43)}`)).toBe(true);
		expect(DEVICE_KEY.test(`hrp_0a1b2c3d_${'A'.repeat(43)}`)).toBe(false);
		expect(DEVICE_KEY.test(`hrd_0A1B2C3D_${'A'.repeat(43)}`)).toBe(false);
		expect(DEVICE_KEY.test(`hrd_0a1b2c3d_${'A'.repeat(42)}`)).toBe(false);
		const spec = OPENAPI as { paths: Record<string, { post?: { security: unknown } }> };
		expect(spec.paths['/punches'].post?.security).toEqual([{ device: [] }]);
	});
});
