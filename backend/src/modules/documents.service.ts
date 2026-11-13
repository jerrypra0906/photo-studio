import { Injectable } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PdfPrinter: new (fonts: unknown) => { createPdfKitDocument(d: unknown): any } = require('pdfmake');
import type { TDocumentDefinitions, Content } from 'pdfmake/interfaces';
import {
  TemplateKind, TemplateVars, displayPhone, durationLabel, formatRp, longDateId, monthLabelId, perMinutes, renderTemplate, wibTime,
} from '@jes/shared';
import { AppError } from '../common/http';
import { Db } from '../db';

// pdfmake ships Roboto as base64 in vfs_fonts; feed it to the server printer as Buffers.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vfsRaw = require('pdfmake/build/vfs_fonts');
const vfs: Record<string, string> = vfsRaw.pdfMake?.vfs ?? vfsRaw.vfs ?? vfsRaw;
const font = (f: string) => Buffer.from(vfs[f], 'base64');
const printer = new PdfPrinter({
  Roboto: { normal: font('Roboto-Regular.ttf'), bold: font('Roboto-Medium.ttf'), italics: font('Roboto-Italic.ttf'), bolditalics: font('Roboto-MediumItalic.ttf') },
});

export function render(doc: TDocumentDefinitions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = printer.createPdfKitDocument(doc);
    const chunks: Buffer[] = [];
    pdf.on('data', (c: Buffer) => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
    pdf.end();
  });
}

const CANCEL_LABEL: Record<string, string> = {
  CUSTOMER_CANCELLED: 'Dibatalkan oleh klien', NO_SHOW: 'Klien tidak datang', STUDIO_CANCELLED: 'Dibatalkan oleh studio', OTHER: 'Lainnya',
};

const BRAND = '#33210a';
// resolved relative to dist/modules → backend/assets
const LOGO = (() => {
  try { return `data:image/png;base64,${readFileSync(join(__dirname, '..', '..', 'assets', 'logo.png')).toString('base64')}`; } catch { return null; }
})();

export const invoiceNo = (b: { bookingNo: string; invoiceRev: number }) => `INV-${b.bookingNo}${b.invoiceRev > 0 ? `-R${b.invoiceRev}` : ''}`;

function unitLabel(unit: string) {
  return unit === 'HOUR' ? 'jam' : unit === 'PERSON' ? 'orang' : 'booking';
}

@Injectable()
export class DocumentsService {
  constructor(private db: Db) {}

  private async load(id: string) {
    const b = await this.db.one(`SELECT b.* FROM bookings b WHERE b.id = $1`, [id]);
    if (!b) throw new AppError(404, 'NOT_FOUND', 'Booking tidak ditemukan');
    b.addons = await this.db.many(`SELECT * FROM booking_addons WHERE booking_id = $1 ORDER BY name_snap`, [id]);
    const s = await this.db.one(`SELECT * FROM settings WHERE id = 1`);
    return { b, s };
  }

  private lineItems(b: any): { label: string; qty: string; unit: number; amount: number }[] {
    const rows = [{ label: `${b.typeNameSnap}`, qty: durationLabel(b.durationMin), unit: b.rateSnap, amount: perMinutes(b.rateSnap, b.durationMin) }];
    for (const a of b.addons) rows.push({ label: a.nameSnap, qty: a.unitSnap === 'HOUR' ? `${durationLabel(b.durationMin)}${a.qty > 1 ? ` × ${a.qty}` : ''}` : `${a.qty} ${unitLabel(a.unitSnap)}`, unit: a.priceSnap, amount: a.lineTotal });
    if (b.adjustment) rows.push({ label: `${b.adjustment < 0 ? 'Diskon' : 'Biaya tambahan'}${b.adjustmentReason ? ` (${b.adjustmentReason})` : ''}`, qty: '', unit: b.adjustment, amount: b.adjustment });
    return rows;
  }

  async vars(b: any, s: any, oldStart?: Date | null): Promise<TemplateVars> {
    return {
      client_name: b.clientNameSnap,
      booking_no: b.bookingNo,
      invoice_no: invoiceNo(b),
      type: b.typeNameSnap,
      day_date: longDateId(b.startAt),
      start: wibTime(b.startAt),
      end: wibTime(b.endAt),
      // older templates say "({hours} jam)"; new ones use {duration}
      hours: String(Math.round(b.hours * 100) / 100).replace('.', ','),
      duration: durationLabel(b.durationMin),
      photographer: b.photographerNameSnap ?? '',
      line_items: this.lineItems(b).map((l) => `• ${l.label}${l.qty ? ` (${l.qty})` : ''}: ${formatRp(l.amount)}`).join('\n'),
      total: formatRp(b.total),
      dp: b.paidAmount > 0 ? formatRp(b.paidAmount) : '',
      balance: formatRp(b.total - b.paidAmount),
      bank_name: s.bankName,
      account_no: s.accountNo,
      account_holder: s.accountHolder,
      studio_name: s.studioName,
      studio_phone: displayPhone(s.studioPhone),
      studio_address: s.address,
      maps_url: s.mapsUrl,
      dp_rule: s.dpRuleText,
      old_schedule: oldStart ? `${longDateId(oldStart)}, ${wibTime(oldStart)} WIB` : '',
      cancel_reason: b.cancelReason ? `${CANCEL_LABEL[b.cancelReason] ?? b.cancelReason}${b.cancelNote ? ` — ${b.cancelNote}` : ''}` : '',
    };
  }

  /** L2-2.2: fill the template; the owner can edit the text before copying. */
  async message(id: string, kind: TemplateKind) {
    const { b, s } = await this.load(id);
    let oldStart: Date | null = null;
    if (kind === 'RESCHEDULE') {
      const h = await this.db.one(
        `SELECT old_value FROM booking_history WHERE booking_id = $1 AND action = 'RESCHEDULE' ORDER BY changed_at DESC LIMIT 1`, [id]);
      oldStart = h ? new Date(h.oldValue) : null;
    }
    const tpl = await this.db.one(`SELECT body FROM message_templates WHERE kind = $1`, [kind]);
    const text = renderTemplate(tpl.body, await this.vars(b, s, oldStart));
    const waUrl = b.clientPhoneSnap ? `https://wa.me/${b.clientPhoneSnap}?text=${encodeURIComponent(text)}` : null;
    return { kind, text, waUrl, phone: b.clientPhoneSnap };
  }

  /** L2-2.1 / PRD §9.2: A5 portrait invoice from the booking snapshot. */
  async invoice(id: string) {
    const { b, s } = await this.load(id);
    if (b.status === 'CANCELLED') throw new AppError(409, 'CANCELLED', 'Dibatalkan — tidak ada invoice');
    if (!s.bankName || !s.accountNo || !s.accountHolder) {
      throw new AppError(409, 'NO_BANK', 'Tambahkan data rekening bank di Pengaturan');
    }
    const issued = await this.db.one(`UPDATE bookings SET invoice_issued = true WHERE id = $1 AND NOT invoice_issued RETURNING id`, [id]);
    if (issued) await this.db.many(`INSERT INTO booking_history (booking_id, action, invoice_rev) VALUES ($1, 'INVOICE_ISSUED', $2)`, [id, b.invoiceRev]);

    const rows = this.lineItems(b);
    const muted = '#6f6354';
    const body: Content[] = [
      {
        columns: [
          [LOGO ? { image: LOGO, width: 96, margin: [0, 0, 0, 4] } : { text: s.studioName, style: 'h1' }, { text: s.address, color: muted, fontSize: 8 }, s.studioPhone ? { text: `WhatsApp ${displayPhone(s.studioPhone)}`, color: muted, fontSize: 8 } : ''],
          [{ text: 'INVOICE', style: 'h1', alignment: 'right', color: BRAND }, { text: invoiceNo(b), alignment: 'right', bold: true, fontSize: 9 },
           { text: `Tanggal: ${longDateId(new Date())}`, alignment: 'right', color: muted, fontSize: 8 }],
        ],
      },
      { canvas: [{ type: 'line', x1: 0, y1: 6, x2: 360, y2: 6, lineWidth: 0.5, lineColor: '#e6dfd2' }], margin: [0, 0, 0, 8] },
      {
        columns: [
          [{ text: 'Ditagihkan kepada', style: 'label' }, { text: b.clientNameSnap, bold: true }, b.clientPhoneSnap ? { text: displayPhone(b.clientPhoneSnap), fontSize: 8 } : ''],
          [{ text: 'Sesi', style: 'label' }, { text: `${b.typeNameSnap} · ${durationLabel(b.durationMin)}`, bold: true },
           { text: longDateId(b.startAt), fontSize: 8 }, { text: `${wibTime(b.startAt)} – ${wibTime(b.endAt)} WIB`, fontSize: 8 },
           b.photographerNameSnap ? { text: `Fotografer: ${b.photographerNameSnap}`, fontSize: 8 } : ''],
        ],
        margin: [0, 0, 0, 10],
      },
      {
        table: {
          headerRows: 1,
          widths: ['*', 'auto', 'auto', 'auto'],
          body: [
            [{ text: 'Deskripsi', style: 'th' }, { text: 'Qty', style: 'th' }, { text: 'Harga', style: 'th', alignment: 'right' }, { text: 'Jumlah', style: 'th', alignment: 'right' }],
            ...rows.map((r) => [r.label, r.qty, { text: formatRp(r.unit), alignment: 'right' as const }, { text: formatRp(r.amount), alignment: 'right' as const }]),
          ],
        },
        layout: { hLineWidth: (i: number) => (i <= 1 ? 0.6 : 0.3), vLineWidth: () => 0, hLineColor: () => '#e6dfd2', paddingTop: () => 4, paddingBottom: () => 4 },
        fontSize: 8,
      },
      {
        table: {
          widths: ['*', 'auto'],
          body: [
            ['Total', { text: formatRp(b.total), alignment: 'right', bold: true }],
            ['DP / sudah dibayar', { text: formatRp(b.paidAmount), alignment: 'right' }],
            [{ text: 'Sisa pembayaran', bold: true }, { text: formatRp(b.total - b.paidAmount), alignment: 'right', bold: true, color: BRAND }],
          ],
        },
        layout: 'noBorders', margin: [160, 8, 0, 10], fontSize: 9,
      },
      { text: 'Pembayaran', style: 'label' },
      { text: `${s.bankName} ${s.accountNo} a/n ${s.accountHolder}`, bold: true, fontSize: 9, margin: [0, 0, 0, 8] },
      s.dpRuleText || s.termsText ? { text: 'Ketentuan', style: 'label' } : '',
      s.dpRuleText ? { text: s.dpRuleText, fontSize: 7.5, color: muted } : '',
      s.termsText ? { text: s.termsText, fontSize: 7.5, color: muted } : '',
      s.mapsUrl ? { text: s.mapsUrl, fontSize: 7.5, color: BRAND, link: s.mapsUrl, margin: [0, 4, 0, 0] } : '',
    ];
    const pdf = await render({
      pageSize: 'A5', pageMargins: [28, 28, 28, 28],
      info: { title: invoiceNo(b), author: s.studioName },
      content: body,
      defaultStyle: { font: 'Roboto', fontSize: 9, color: BRAND },
      styles: { h1: { fontSize: 14, bold: true }, label: { fontSize: 7, color: muted, bold: true, margin: [0, 0, 0, 2] }, th: { bold: true, color: muted } },
    });
    const safe = b.clientNameSnap.replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_|_$/g, '');
    return { pdf, filename: `Invoice_${safe}_${b.startAt.toISOString().slice(0, 10)}.pdf` };
  }

  /** FR-26: one-page recap PDF. */
  async recapPdf(recap: any) {
    const s = await this.db.one(`SELECT studio_name FROM settings WHERE id = 1`);
    const row = (l: string, v: number, bold = false) => [{ text: l, bold }, { text: formatRp(v), alignment: 'right' as const, bold }];
    const pdf = await render({
      pageSize: 'A4', pageMargins: [40, 40, 40, 40],
      content: [
        { text: `${s.studioName} — Rekap ${monthLabelId(recap.month)}`, fontSize: 15, bold: true },
        { text: `Basis pendapatan: ${recap.basis === 'BILLED' ? 'Ditagih' : 'Diterima (per bulan sesi)'}`, color: '#6b6460', margin: [0, 2, 0, 12] },
        {
          table: {
            widths: ['*', 'auto'],
            body: [
              ...recap.revenue.byType.map((t: any) => row(`Pendapatan — ${t.name} (${t.count} booking)`, t.amount)),
              row('Pendapatan — Add-on', recap.revenue.addons),
              ...(recap.revenue.adjustments ? [row('Penyesuaian harga', recap.revenue.adjustments)] : []),
              ...(recap.revenue.uncollected ? [row('Belum diterima', -recap.revenue.uncollected)] : []),
              row('Total pendapatan', recap.revenue.total, true),
              ...recap.expenses.byCategory.map((c: any) => row(c.name, -c.amount)),
              row('Total pengeluaran', -recap.expenses.total, true),
              row(`Laba bersih (margin ${recap.marginPct ?? 0}%)`, recap.netProfit, true),
              row('Piutang (sisa pembayaran)', recap.receivables.total),
            ],
          },
          layout: 'lightHorizontalLines',
        },
        recap.drafts.count ? { text: `${recap.drafts.count} biaya draft (${formatRp(recap.drafts.amount)}) tidak termasuk.`, color: '#b45309', margin: [0, 10, 0, 0] } : '',
      ],
      defaultStyle: { font: 'Roboto', fontSize: 10 },
    });
    return pdf;
  }
}
