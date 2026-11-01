/**
 * Pricing per PRD §6.2. Used live by the web app and authoritatively by the API (TD D7).
 * All amounts are whole rupiah integers.
 */
export type PricingUnit = 'HOUR' | 'BOOKING' | 'PERSON';

export interface PricingAddon {
  addonId?: string;
  name: string;
  unit: PricingUnit;
  price: number;
  qty: number;
}

export interface PricingInput {
  typeName: string;
  rate: number;
  hours: number;
  addons: PricingAddon[];
  adjustment?: number;
  dp?: number;
  paid?: number;
}

export interface PriceLine {
  kind: 'BASE' | 'ADDON' | 'ADJUSTMENT';
  label: string;
  qty: number;
  unitPrice: number;
  amount: number;
  unit?: PricingUnit;
  addonId?: string;
}

export interface PricingResult {
  lines: PriceLine[];
  base: number;
  addonsTotal: number;
  adjustment: number;
  total: number;
  dp: number;
  paid: number;
  balance: number;
  errors: { field: string; message: string }[];
}

export function addonLineAmount(a: PricingAddon, hours: number): number {
  const qty = Math.max(1, Math.trunc(a.qty));
  if (a.unit === 'HOUR') return a.price * hours * qty;
  return a.price * qty;
}

export function priceBooking(input: PricingInput): PricingResult {
  const hours = Math.trunc(input.hours);
  const adjustment = Math.trunc(input.adjustment ?? 0);
  const dp = Math.trunc(input.dp ?? 0);
  const paid = Math.max(dp, Math.trunc(input.paid ?? dp));
  const lines: PriceLine[] = [];

  const base = input.rate * hours;
  lines.push({ kind: 'BASE', label: input.typeName, qty: hours, unitPrice: input.rate, amount: base, unit: 'HOUR' });

  let addonsTotal = 0;
  for (const a of input.addons) {
    const qty = Math.max(1, Math.trunc(a.qty));
    const amount = addonLineAmount(a, hours);
    addonsTotal += amount;
    lines.push({
      kind: 'ADDON',
      label: a.name,
      qty: a.unit === 'HOUR' ? hours * qty : qty,
      unitPrice: a.price,
      amount,
      unit: a.unit,
      addonId: a.addonId,
    });
  }

  if (adjustment !== 0) {
    lines.push({ kind: 'ADJUSTMENT', label: adjustment < 0 ? 'Diskon' : 'Biaya tambahan', qty: 1, unitPrice: adjustment, amount: adjustment });
  }

  const total = base + addonsTotal + adjustment;
  const errors: PricingResult['errors'] = [];
  if (total < 0) errors.push({ field: 'adjustment', message: 'Total tidak boleh di bawah Rp0' });
  if (dp < 0) errors.push({ field: 'dpAmount', message: 'DP tidak boleh negatif' });
  if (dp > total) errors.push({ field: 'dpAmount', message: 'DP tidak boleh melebihi total' });
  if (paid > total) errors.push({ field: 'paidAmount', message: 'Pembayaran tidak boleh melebihi total' });

  return { lines, base, addonsTotal, adjustment, total, dp, paid, balance: total - paid, errors };
}
