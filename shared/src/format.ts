/** Money, phone and WIB date helpers. Indonesia has no DST, so WIB is a fixed UTC+7. */

export const WIB_OFFSET_MIN = 7 * 60;
export const TZ = 'Asia/Jakarta';

const DAYS = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

/** 1449000 → "Rp1.449.000"; -450000 → "−Rp450.000" */
export function formatRp(n: number): string {
  const abs = Math.abs(Math.trunc(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${n < 0 ? '−' : ''}Rp${abs}`;
}

/** Short axis/tile form: 14745000 → "Rp14,7 jt", −3498000 → "−Rp3,5 jt", 250000 → "Rp250 rb" */
export function formatRpCompact(n: number): string {
  const a = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  const dec = (v: number) => (Math.round(v * 10) / 10).toString().replace('.', ',');
  if (a >= 1e9) return `${sign}Rp${dec(a / 1e9)} M`;
  if (a >= 1e6) return `${sign}Rp${dec(a / 1e6)} jt`;
  if (a >= 1e3) return `${sign}Rp${dec(a / 1e3)} rb`;
  return `${sign}Rp${a}`;
}

/** "2026-03" → "Mar" (or "Mar 26" with the year) */
export function shortMonthId(month: string, withYear = false): string {
  const [y, m] = month.split('-').map(Number);
  return `${MONTHS[m - 1].slice(0, 3)}${withYear ? ` ${String(y).slice(2)}` : ''}`;
}

/** 1449000 → "1.449.000" */
export function formatThousands(n: number): string {
  return Math.trunc(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** "1.449.000" / "Rp 1,449,000" → 1449000 (NaN if empty) */
export function parseAmount(s: string): number {
  const neg = /^\s*[-−]/.test(s);
  const digits = s.replace(/[^\d]/g, '');
  if (!digits) return NaN;
  return (neg ? -1 : 1) * parseInt(digits, 10);
}

/** "0821 2350 0508" / "+62 821-2350-0508" / "8212350..." → "6282123500508"; invalid → null */
export function normalizePhone(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (/[^\d\s+\-().]/.test(s)) return null;
  let d = s.replace(/\D/g, '');
  if (d.startsWith('0')) d = '62' + d.slice(1);
  else if (d.startsWith('8')) d = '62' + d;
  if (!/^62\d{8,13}$/.test(d)) return null;
  return d;
}

/** Display: 6282123500508 → "0821-2350-0508" */
export function displayPhone(e164: string | null | undefined): string {
  if (!e164) return '';
  const local = e164.startsWith('62') ? '0' + e164.slice(2) : e164;
  return local.replace(/^(\d{4})(\d{4})(\d+)$/, '$1-$2-$3');
}

export interface WibParts { y: number; m: number; d: number; hh: number; mm: number; dow: number }

export function wibParts(date: Date | string): WibParts {
  const t = new Date(typeof date === 'string' ? date : date.getTime());
  const w = new Date(t.getTime() + WIB_OFFSET_MIN * 60000);
  return { y: w.getUTCFullYear(), m: w.getUTCMonth() + 1, d: w.getUTCDate(), hh: w.getUTCHours(), mm: w.getUTCMinutes(), dow: w.getUTCDay() };
}

const p2 = (n: number) => String(n).padStart(2, '0');

/** WIB "YYYY-MM-DD" of an instant */
export function wibDate(date: Date | string): string {
  const p = wibParts(date);
  return `${p.y}-${p2(p.m)}-${p2(p.d)}`;
}

/** WIB "HH:mm" of an instant */
export function wibTime(date: Date | string): string {
  const p = wibParts(date);
  return `${p2(p.hh)}:${p2(p.mm)}`;
}

/** WIB "YYYY-MM" of an instant */
export function wibMonth(date: Date | string): string {
  return wibDate(date).slice(0, 7);
}

/** ("2026-10-30", "14:00") in WIB → UTC Date */
export function fromWib(dateStr: string, timeStr = '00:00'): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - WIB_OFFSET_MIN * 60000);
}

/** "Jumat, 30 Oktober 2026" */
export function longDateId(date: Date | string): string {
  const p = wibParts(date);
  return `${DAYS[p.dow]}, ${p.d} ${MONTHS[p.m - 1]} ${p.y}`;
}

/** "30 Okt" */
export function shortDateId(date: Date | string): string {
  const p = wibParts(date);
  return `${p.d} ${MONTHS[p.m - 1].slice(0, 3)}`;
}

/** "2026-10" → "Oktober 2026" */
export function monthLabelId(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

export function dayNameId(dow: number): string {
  return DAYS[dow];
}

/** "2026-10" → "2026-09" / "2026-11" */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${t.getUTCFullYear()}-${p2(t.getUTCMonth() + 1)}`;
}

/** "HH:mm" → minutes since midnight */
export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function fromMinutes(min: number): string {
  return `${p2(Math.floor(min / 60) % 24)}:${p2(min % 60)}`;
}
