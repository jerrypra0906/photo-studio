import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceBooking } from './pricing.ts';

// PRD §6.3 worked examples
const PP = { typeName: 'Photo Package', rate: 599_000 };
const SO = { typeName: 'Studio Only', rate: 170_000 };

test('Studio Only, 2 hours = 340.000', () => {
  assert.equal(priceBooking({ ...SO, minutes: 120, addons: [] }).total, 340_000);
});

test('Photo Package 1h + decoration flat 250K = 849.000', () => {
  const r = priceBooking({ ...PP, minutes: 60, addons: [{ name: 'Dekorasi', unit: 'BOOKING', price: 250_000, qty: 1 }] });
  assert.equal(r.total, 849_000);
});

test('Photo Package 1h + MUA hairdo + decoration, DP 500K → 1.449.000, balance 949.000', () => {
  const r = priceBooking({
    ...PP, minutes: 60, dp: 500_000,
    addons: [
      { name: 'MUA + Hairdo', unit: 'BOOKING', price: 600_000, qty: 1 },
      { name: 'Dekorasi', unit: 'BOOKING', price: 250_000, qty: 1 },
    ],
  });
  assert.equal(r.total, 1_449_000);
  assert.equal(r.balance, 949_000);
  assert.deepEqual(r.errors, []);
});

test('Photo Package 2h + 7 extra persons = 1.373.000', () => {
  const r = priceBooking({ ...PP, minutes: 120, addons: [{ name: 'Extra person', unit: 'PERSON', price: 25_000, qty: 7 }] });
  assert.equal(r.total, 1_373_000);
});

test('Studio Only 6h − 420K promo = 600.000', () => {
  const r = priceBooking({ ...SO, minutes: 360, addons: [], adjustment: -420_000 });
  assert.equal(r.total, 600_000);
  assert.equal(r.lines.at(-1)?.kind, 'ADJUSTMENT');
});

test('per-hour add-on doubles with hours (US-04.2)', () => {
  const deco = { name: 'Dekorasi', unit: 'HOUR' as const, price: 125_000, qty: 1 };
  assert.equal(priceBooking({ ...PP, minutes: 120, addons: [deco] }).addonsTotal, 250_000);
});

test('DP over total and negative total are errors (US-10.4, 10.5)', () => {
  assert.ok(priceBooking({ ...SO, minutes: 120, addons: [], dp: 400_000 }).errors.some((e) => e.field === 'dpAmount'));
  assert.ok(priceBooking({ ...SO, minutes: 120, addons: [], adjustment: -500_000 }).errors.some((e) => e.field === 'adjustment'));
});

test('minutes are pro-rated: Studio Only 90 minutes = 255.000, Photo Package 30 minutes = 299.500', () => {
  assert.equal(priceBooking({ ...SO, minutes: 90, addons: [] }).total, 255_000);
  assert.equal(priceBooking({ ...PP, minutes: 30, addons: [] }).total, 299_500);
  const deco = { name: 'Dekorasi', unit: 'HOUR' as const, price: 125_000, qty: 1 };
  assert.equal(priceBooking({ ...PP, minutes: 45, addons: [deco] }).addonsTotal, 93_750);
});
