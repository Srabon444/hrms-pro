import { expect, it } from 'vitest';
import { perDiemFor, tripDays } from './travel';

const rates = [
	{ country: 'India', city: null, dailyAmount: 200_000 },
	{ country: 'India', city: 'Mumbai', dailyAmount: 300_000 },
	{ country: 'Nepal', city: 'Kathmandu', dailyAmount: 150_000 }
];
const trip = (country: string, city: string | null, departOn = '2027-03-01', returnOn = '2027-03-04') => ({
	country,
	city,
	departOn,
	returnOn
});

it('counts both travel days', () => {
	expect(tripDays(trip('India', null, '2027-02-28', '2027-02-28'))).toBe(1);
	expect(tripDays(trip('India', null, '2028-02-28', '2028-03-01'))).toBe(3);
	expect(tripDays(trip('India', null, '2027-03-27', '2027-03-29'))).toBe(3);
});

it('prefers the city rate, falls back to the country rate, ignoring case and spaces', () => {
	expect(perDiemFor(rates, trip('india', ' MUMBAI '))).toEqual({
		daily: 300_000,
		days: 4,
		total: 1_200_000,
		city: true
	});
	expect(perDiemFor(rates, trip('India', 'Pune'))).toEqual({ daily: 200_000, days: 4, total: 800_000, city: false });
	expect(perDiemFor(rates, trip('India', null))?.daily).toBe(200_000);
});

it('gives no guidance where no rate covers the place', () => {
	expect(perDiemFor(rates, trip('Nepal', 'Pokhara'))).toBeNull();
	expect(perDiemFor(rates, trip('France', 'Paris'))).toBeNull();
});
