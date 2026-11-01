/** WhatsApp template placeholders (PRD §9.3) plus the variant-specific ones. */
export const PLACEHOLDERS = [
  'client_name', 'booking_no', 'invoice_no', 'type', 'day_date', 'start', 'end', 'hours', 'photographer',
  'line_items', 'total', 'dp', 'balance', 'bank_name', 'account_no', 'account_holder',
  'studio_name', 'studio_phone', 'studio_address', 'maps_url', 'dp_rule', 'old_schedule', 'cancel_reason',
] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];
export type TemplateVars = Partial<Record<Placeholder, string>>;

const RE = /\{([a-z_]+)\}/g;

export function unknownPlaceholders(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(RE)) if (!(PLACEHOLDERS as readonly string[]).includes(m[1])) out.add(m[1]);
  return [...out];
}

/** Fills placeholders; a line whose placeholders are all empty is removed (PRD §9.3). */
export function renderTemplate(body: string, vars: TemplateVars): string {
  const lines = body.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const names = [...line.matchAll(RE)].map((m) => m[1]);
    if (names.length > 0 && names.every((n) => !(vars as Record<string, string | undefined>)[n])) continue;
    out.push(line.replace(RE, (_, n: string) => (vars as Record<string, string | undefined>)[n] ?? ''));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export const DEFAULT_TEMPLATES: Record<'NEW' | 'BALANCE' | 'RESCHEDULE' | 'CANCEL', string> = {
  NEW: `Halo kak {client_name} 😊
Berikut detail booking di {studio_name}:

📅 {day_date}, {start} – {end} WIB ({hours} jam)
📸 {type}
Fotografer: {photographer}
No. booking: {booking_no}

Rincian:
{line_items}
*Total: {total}*
DP diterima: {dp}
Sisa pembayaran: {balance}
{dp_rule}

Transfer ke:
{bank_name} {account_no} a/n {account_holder}

Alamat studio: {studio_address}
{maps_url}

Bila sudah transfer, mohon kirim bukti ya kak. Terima kasih 🙏`,
  BALANCE: `Halo kak {client_name} 😊
Pengingat pelunasan booking {booking_no} ({day_date}, {start} WIB):

*Total: {total}*
DP diterima: {dp}
*Sisa pelunasan: {balance}*

Transfer ke:
{bank_name} {account_no} a/n {account_holder}

Pelunasan sebelum photoshoot dimulai ya kak. Terima kasih 🙏`,
  RESCHEDULE: `Halo kak {client_name} 😊
Jadwal booking {booking_no} sudah kami ubah:

Sebelumnya: {old_schedule}
*Jadwal baru: {day_date}, {start} – {end} WIB ({hours} jam)*

Rincian:
{line_items}
*Total: {total}*
Sisa pembayaran: {balance}

Sampai jumpa di studio ya kak 🙏`,
  CANCEL: `Halo kak {client_name},
Booking {booking_no} untuk {day_date}, {start} WIB telah dibatalkan.
Alasan: {cancel_reason}

Terima kasih kak 🙏`,
};
