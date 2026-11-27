import { describe, expect, it } from 'vitest';
import { weakPin } from './kiosk';

describe('weak kiosk PINs', () => {
	it.each([
		'000000',
		'777777',
		'123456',
		'654321',
		'890123',
		'21098765',
		'121212',
		'123123',
		'45674567',
		'150390',
		'031590',
		'900315',
		'15031990',
		'03151990',
		'19900315',
		'000417'
	])('refuses %s', (pin) => {
		expect(weakPin(pin, '1990-03-15', 'EMP-000417')).toBe(true);
	});

	it.each(['482915', '73019264', '5821937'])('accepts %s', (pin) => {
		expect(weakPin(pin, '1990-03-15', 'EMP-000417')).toBe(false);
		expect(weakPin(pin, null, 'X')).toBe(false);
	});
});
