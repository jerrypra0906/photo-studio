export const ROLES = ['OWNER', 'STAFF'] as const;
export type Role = (typeof ROLES)[number];

export const BOOKING_STATUSES = ['CONFIRMED', 'COMPLETED', 'CANCELLED'] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const ADDON_UNITS = ['HOUR', 'BOOKING', 'PERSON'] as const;
export type AddonUnit = (typeof ADDON_UNITS)[number];

export const FEE_UNITS = ['SESSION', 'HOUR'] as const;
export type FeeUnit = (typeof FEE_UNITS)[number];

export const PAYMENT_STATUSES = ['UNPAID', 'DP_PAID', 'PAID'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const SYNC_STATUSES = ['NONE', 'PENDING', 'SYNCED', 'FAILED'] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

export const CANCEL_REASONS = ['CUSTOMER_CANCELLED', 'NO_SHOW', 'STUDIO_CANCELLED', 'OTHER'] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];

export const EXPENSE_KINDS = ['FIXED', 'VARIABLE'] as const;
export const EXPENSE_STATUSES = ['DRAFT', 'CONFIRMED'] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];
export const EXPENSE_SOURCES = ['MANUAL', 'BOOKING_FEE', 'RECURRING'] as const;

export const TEMPLATE_KINDS = ['NEW', 'BALANCE', 'RESCHEDULE', 'CANCEL'] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

export const REVENUE_BASES = ['BILLED', 'COLLECTED'] as const;
export type RevenueBasis = (typeof REVENUE_BASES)[number];

/** Payment status is derived from amounts, never entered separately (review C5). */
export function paymentStatusOf(total: number, paid: number): PaymentStatus {
  if (paid <= 0) return 'UNPAID';
  if (paid >= total) return 'PAID';
  return 'DP_PAID';
}
