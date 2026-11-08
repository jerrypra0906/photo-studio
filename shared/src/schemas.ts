import { z } from 'zod';
import { ADDON_UNITS, CANCEL_REASONS, EXPENSE_KINDS, FEE_UNITS, REVENUE_BASES, ROLES, TEMPLATE_KINDS } from './enums';

const money = z.number().int().min(0).max(1_000_000_000);
const uuid = z.string().uuid();
const hhmm = z.string().regex(/^\d{2}:\d{2}$/, 'Format HH:mm');
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format YYYY-MM-DD');

export const loginSchema = z.object({
  email: z.string().email().max(120),
  password: z.string().min(1).max(200),
});

export const bookingAddonInput = z.object({
  addonId: uuid,
  qty: z.number().int().min(1).max(100).default(1),
});

export const bookingInput = z.object({
  typeId: uuid,
  hours: z.number().int().min(1).max(24),
  date: ymd,
  startTime: hhmm,
  clientName: z.string().trim().min(2, 'Nama klien minimal 2 karakter').max(60),
  clientPhone: z.string().trim().max(30).optional().nullable(),
  photographerId: uuid.optional().nullable(),
  addons: z.array(bookingAddonInput).max(30).default([]),
  adjustment: z.number().int().min(-1_000_000_000).max(1_000_000_000).default(0),
  adjustmentReason: z.string().trim().max(200).optional().nullable(),
  dpAmount: money.default(0),
  notes: z.string().trim().max(1000).optional().nullable(),
  afterHoursReason: z.string().trim().max(200).optional().nullable(),
  /** On edit: re-price add-ons and type from the current master (L2-1.3.4); default keep snapshot. */
  applyCurrentPrices: z.boolean().optional(),
});
export type BookingInput = z.infer<typeof bookingInput>;

export const cancelInput = z.object({
  reason: z.enum(CANCEL_REASONS),
  note: z.string().trim().max(200).optional().nullable(),
});

export const completeInput = z.object({
  paidAmount: money,
});

export const paymentInput = z.object({
  paidAmount: money,
});

export const bookingTypeInput = z.object({
  name: z.string().trim().min(1, 'Nama wajib diisi').max(60),
  hourlyRate: money,
  requiresPhotographer: z.boolean(),
  minHours: z.number().int().min(1).max(24).default(1),
  maxHours: z.number().int().min(1).max(24).default(8),
  calendarKeyword: z.string().trim().max(30).default(''),
  colorId: z.string().max(4).optional().nullable(),
  active: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});

export const photographerInput = z.object({
  name: z.string().trim().min(1, 'Nama wajib diisi').max(60),
  phone: z.string().trim().max(30).optional().nullable(),
  email: z.string().email().max(120).optional().nullable().or(z.literal('')),
  defaultFee: money.optional().nullable(),
  feeUnit: z.enum(FEE_UNITS).default('SESSION'),
  active: z.boolean().default(true),
});

export const addonInput = z.object({
  name: z.string().trim().min(1, 'Nama wajib diisi').max(60),
  price: money,
  unit: z.enum(ADDON_UNITS),
  typeIds: z.array(uuid).min(1, 'Pilih minimal satu jenis booking'),
  vendorFee: money.optional().nullable(),
  vendorName: z.string().trim().max(60).optional().nullable(),
  active: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});

export const expenseCategoryInput = z.object({
  name: z.string().trim().min(1, 'Nama wajib diisi').max(60),
  kind: z.enum(EXPENSE_KINDS),
  recurring: z.boolean().default(false),
  defaultAmount: money.optional().nullable(),
  active: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});

export const expenseInput = z.object({
  categoryId: uuid,
  amount: z.number().int().min(1, 'Masukkan jumlah di atas Rp0').max(1_000_000_000),
  paidOn: ymd,
  payee: z.string().trim().max(80).optional().nullable(),
  note: z.string().trim().max(500).optional().nullable(),
  bookingId: uuid.optional().nullable(),
  force: z.boolean().optional(),
});

/** Draft confirmation allows Rp0 (PRD 4.2.2: "no fee"). */
export const confirmExpenseInput = z.object({
  amount: money,
});

const dayHours = z.object({ open: hhmm, close: hhmm, closed: z.boolean().default(false) });

export const settingsInput = z.object({
  studioName: z.string().trim().min(1).max(80),
  studioPhone: z.string().trim().max(30).default(''),
  address: z.string().trim().max(300).default(''),
  mapsUrl: z.string().trim().max(300).default(''),
  bankName: z.string().trim().max(60).default(''),
  accountNo: z.string().trim().max(40).default(''),
  accountHolder: z.string().trim().max(80).default(''),
  openHours: z.array(dayHours).length(7),
  slotStepMin: z.union([z.literal(30), z.literal(60)]),
  maxHours: z.number().int().min(1).max(24),
  bufferMin: z.number().int().min(0).max(120),
  dpRuleText: z.string().trim().max(300).default(''),
  termsText: z.string().trim().max(2000).default(''),
  revenueBasis: z.enum(REVENUE_BASES),
  gcalCancelMode: z.enum(['DELETE', 'MARK']),
  gcalMarkCompleted: z.boolean(),
}).superRefine((s, ctx) => {
  s.openHours.forEach((h, i) => {
    if (!h.closed && h.close <= h.open) ctx.addIssue({ code: 'custom', path: ['openHours', i, 'close'], message: 'Jam tutup harus setelah jam buka' });
  });
});

export const templateInput = z.object({
  kind: z.enum(TEMPLATE_KINDS),
  body: z.string().min(1).max(4000),
});

/** ≥ 10 characters with at least one letter and one digit (pen-test SEC-A15). */
export const passwordRule = z.string()
  .min(10, 'Minimal 10 karakter')
  .max(200, 'Maksimal 200 karakter')
  .regex(/[A-Za-z]/, 'Harus mengandung huruf')
  .regex(/\d/, 'Harus mengandung angka');

export const userInput = z.object({
  name: z.string().trim().min(2, 'Nama minimal 2 karakter').max(60),
  email: z.string().trim().toLowerCase().email('Email tidak valid').max(120),
  password: passwordRule.optional(),
  role: z.enum(ROLES),
  active: z.boolean().default(true),
}).refine((u) => !u.password || u.password.toLowerCase() !== u.email, { path: ['password'], message: 'Kata sandi tidak boleh sama dengan email' });

export const profileInput = z.object({
  name: z.string().trim().min(2, 'Nama minimal 2 karakter').max(60),
});

export const passwordChangeInput = z.object({
  currentPassword: z.string().min(1, 'Masukkan kata sandi saat ini').max(200),
  newPassword: passwordRule,
}).refine((p) => p.currentPassword !== p.newPassword, { path: ['newPassword'], message: 'Kata sandi baru harus berbeda' });

export const reopenInput = z.object({ reason: z.string().trim().min(3, 'Alasan wajib diisi').max(200) });
