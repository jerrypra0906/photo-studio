import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { displayPhone, formatRp, longDateId, wibTime } from '@jes/shared';
import { ApiError, api } from '../api';
import { useIsOwner } from '../App';
import { CANCEL_REASONS } from '../hooks';
import { Banner, BottomBar, Button, Card, Chip, Field, Input, Money, MoneyInput, Page, PageHeader, PayBadge, Sheet, Spinner, StatusBadge, cx, inputCls, useToast } from '../ui';

const SYNC_LABEL: Record<string, [string, string]> = {
  SYNCED: ['Tersinkron', 'text-ok'], PENDING: ['Menunggu sinkron…', 'text-warn'], FAILED: ['Kalender belum diperbarui', 'text-bad'],
};
const ACTION_LABEL: Record<string, string> = {
  CREATE: 'Dibuat', GCAL_LINK: 'Diambil dari Google Calendar', EDIT: 'Diubah', RESCHEDULE: 'Dijadwal ulang', CANCEL: 'Dibatalkan', COMPLETE: 'Diselesaikan', PAYMENT: 'Pembayaran dicatat',
  INVOICE_SENT: 'Invoice ditandai terkirim', INVOICE_SENT_UNDO: 'Tanda terkirim dibatalkan', INVOICE_ISSUED: 'Invoice dibuat',
};
const FIELD_LABEL: Record<string, string> = {
  typeNameSnap: 'Jenis', rateSnap: 'Tarif', hours: 'Durasi', startAt: 'Jadwal', clientNameSnap: 'Nama', clientPhoneSnap: 'Telepon',
  photographerNameSnap: 'Fotografer', adjustment: 'Penyesuaian', adjustmentReason: 'Alasan', dpAmount: 'DP', total: 'Total', addons: 'Add-on', notes: 'Catatan', paidAmount: 'Dibayar', status: 'Status',
};
const fmtHist = (field: string, v: string | null) => {
  if (v == null || v === '') return '—';
  if (field === 'startAt') return `${longDateId(v)} ${wibTime(v)}`;
  if (['rateSnap', 'adjustment', 'dpAmount', 'total', 'paidAmount'].includes(field)) return formatRp(Number(v));
  return v;
};

/** S6 Booking detail (PRD §8.5). */
export default function BookingDetail() {
  const { id } = useParams();
  const loc = useLocation();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const owner = useIsOwner();
  const q = useQuery({
    queryKey: ['booking', id],
    queryFn: () => api.get(`/bookings/${id}`),
    // TD 4.1 step 6: poll while the calendar sync is pending
    refetchInterval: (query) => (query.state.data?.gcalSyncStatus === 'PENDING' ? 5000 : false),
  });
  const b = q.data;
  const [sheet, setSheet] = useState<null | 'invoice' | 'wa' | 'cancel' | 'complete' | 'payment' | 'menu'>(null);
  const [waKind, setWaKind] = useState('NEW');
  const firstOpen = useRef(true);

  // after a reschedule, offer the updated invoice + Reschedule template (L2-1.3.6)
  useEffect(() => {
    if (b && firstOpen.current) {
      firstOpen.current = false;
      if ((loc.state as any)?.rescheduled) { setWaKind('RESCHEDULE'); setSheet('wa'); }
    }
  }, [b, loc.state]);

  const refresh = (data?: any) => {
    if (data) qc.setQueryData(['booking', id], data);
    qc.invalidateQueries({ queryKey: ['bookings'] });
    qc.invalidateQueries({ queryKey: ['schedule'] });
  };

  if (q.isLoading) return (<><PageHeader title="Booking" back /><Spinner /></>);
  if (!b) return (<><PageHeader title="Booking" back /><Page><Banner tone="bad">Booking tidak ditemukan.</Banner></Page></>);

  const cancelled = b.status === 'CANCELLED';
  const canEdit = !cancelled && (b.status !== 'COMPLETED' || owner);
  const ended = new Date(b.endAt).getTime() <= Date.now();
  const sync = SYNC_LABEL[b.gcalSyncStatus];
  const retrySync = async () => {
    try { refresh(await api.post(`/bookings/${id}/sync`)); toast('Sinkron diulang'); } catch (e) { toast((e as ApiError).message, 'bad'); }
  };

  return (
    <>
      <PageHeader title={b.bookingNo} back
        action={<button className="size-11 grid place-items-center rounded-full active:bg-accent-soft text-xl" aria-label="Menu lainnya" onClick={() => setSheet('menu')}>⋯</button>} />
      <Page className="pb-40">
        {/* Header card */}
        <Card className="space-y-3">
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <h2 className="text-xl font-semibold truncate">{b.clientNameSnap}</h2>
              {b.clientPhoneSnap ? <a href={`tel:+${b.clientPhoneSnap}`} className="text-sm text-accent-text">{displayPhone(b.clientPhoneSnap)}</a> : <p className="text-sm text-muted">Tanpa nomor</p>}
            </div>
            <div className="flex flex-col items-end gap-1">
              <StatusBadge status={b.status} />
              {!cancelled ? <PayBadge total={b.total} paid={b.paidAmount} /> : null}
            </div>
          </div>
          <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <span className="text-muted">Tanggal</span><span>{longDateId(b.startAt)}</span>
            <span className="text-muted">Jam</span><span className="tabular">{wibTime(b.startAt)} – {wibTime(b.endAt)} WIB ({b.hours} jam)</span>
            <span className="text-muted">Jenis</span><span>{b.typeNameSnap}</span>
            {b.photographerNameSnap ? (<><span className="text-muted">Fotografer</span><span>{b.photographerNameSnap}</span></>) : null}
            {b.notes ? (<><span className="text-muted">Catatan</span><span className="whitespace-pre-wrap">{b.notes}</span></>) : null}
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            {b.backDated ? <span className="rounded-full bg-sunken px-2 py-0.5 text-muted">Back-dated</span> : null}
            {b.afterHoursReason ? <span className="rounded-full bg-warn-soft px-2 py-0.5 text-warn">Di luar jam buka: {b.afterHoursReason}</span> : null}
            {b.invoiceSentAt ? <span className="rounded-full bg-ok-soft px-2 py-0.5 text-ok">Invoice terkirim {wibTime(b.invoiceSentAt)}</span> : null}
          </div>
          {sync ? (
            <div className="flex items-center gap-2 text-sm">
              <span className={cx('font-medium', sync[1])}>📅 {sync[0]}</span>
              {b.gcalSyncStatus === 'FAILED' ? <Button variant="secondary" className="min-h-9 py-1 text-sm" onClick={retrySync}>Coba lagi</Button> : null}
            </div>
          ) : null}
        </Card>

        {cancelled ? (
          <Banner tone="bad">Dibatalkan — {CANCEL_REASONS.find(([k]) => k === b.cancelReason)?.[1] ?? b.cancelReason}{b.cancelNote ? ` · ${b.cancelNote}` : ''}. Tidak ada invoice.</Banner>
        ) : null}
        {cancelled && b.paidAmount > 0 ? <Banner tone="warn">DP {formatRp(b.paidAmount)} tercatat — selesaikan refund atau hangus di luar aplikasi.</Banner> : null}
        {!cancelled && b.status === 'CONFIRMED' && ended ? (
          <Banner tone="warn" action={owner ? <Button className="min-h-9 py-1 text-sm" onClick={() => setSheet('complete')}>Tandai selesai</Button> : undefined}>
            {owner ? 'Sesi sudah lewat.' : 'Sesi sudah lewat — Owner akan menandai selesai dan pembayarannya.'}
          </Banner>
        ) : null}

        {/* Breakdown */}
        <Card className="space-y-2">
          <h3 className="font-semibold">Rincian</h3>
          <Line label={`${b.typeNameSnap} · ${b.hours} jam × ${formatRp(b.rateSnap)}`} value={b.rateSnap * b.hours} />
          {b.addons.map((a: any) => (
            <Line key={a.addonId} label={`${a.nameSnap}${a.unitSnap === 'HOUR' ? ` · ${b.hours} jam` : ''}${a.qty > 1 ? ` × ${a.qty}` : ''}`} value={a.lineTotal} />
          ))}
          {b.adjustment ? <Line label={`${b.adjustment < 0 ? 'Diskon' : 'Biaya tambahan'} — ${b.adjustmentReason}`} value={b.adjustment} /> : null}
          <div className="border-t border-line pt-2 space-y-1">
            <Line label="Total" value={b.total} strong />
            <Line label="DP / dibayar" value={b.paidAmount} />
            <Line label="Sisa" value={b.balance} strong accent={b.balance > 0} />
          </div>
          {owner && b.status === 'COMPLETED' && b.balance > 0 ? <Button variant="secondary" className="w-full" onClick={() => setSheet('payment')}>Catat pembayaran</Button> : null}
        </Card>

        {/* Linked costs and margin (FR-27, Owner only) */}
        {owner && b.expenses?.length ? (
          <Card className="space-y-2">
            <h3 className="font-semibold">Biaya terkait</h3>
            {b.expenses.map((e: any) => (
              <Link key={e.id} to={`/finance/expenses/${e.id}`} className="flex justify-between gap-2 text-sm min-h-9 items-center">
                <span className="truncate">{e.categoryName}{e.payee ? ` · ${e.payee}` : ''} {e.status === 'DRAFT' ? <StatusBadge status="DRAFT" /> : null}</span>
                <span className="tabular">{e.amount == null ? '—' : `−${formatRp(e.amount)}`}</span>
              </Link>
            ))}
            <div className="border-t border-line pt-2"><Line label="Margin booking" value={b.margin.margin} strong /></div>
          </Card>
        ) : null}

        {/* History */}
        <details className="rounded-3xl glass border border-line p-4">
          <summary className="font-semibold cursor-pointer">Riwayat ({b.history.length}) · Invoice R{b.invoiceRev}</summary>
          <ol className="mt-3 space-y-2 text-sm">
            {b.history.map((h: any) => (
              <li key={h.id} className="border-l-2 border-line pl-3">
                <div className="text-muted text-xs">{longDateId(h.changedAt)} {wibTime(h.changedAt)} · {h.changedByName ?? 'Sistem'}{h.invoiceRev != null ? ` · R${h.invoiceRev}` : ''}</div>
                <div>{ACTION_LABEL[h.action] ?? h.action}{h.field && h.action !== 'CREATE' ? ` — ${FIELD_LABEL[h.field] ?? h.field}: ${fmtHist(h.field, h.oldValue)} → ${fmtHist(h.field, h.newValue)}` : ''}</div>
              </li>
            ))}
          </ol>
        </details>
      </Page>

      {!cancelled ? (
        <BottomBar>
          <div className="grid grid-cols-2 gap-3">
            <Button variant="secondary" onClick={() => setSheet('invoice')}>Invoice (PDF)</Button>
            <Button onClick={() => { setWaKind(b.status === 'COMPLETED' || b.balance <= 0 ? 'NEW' : 'NEW'); setSheet('wa'); }}>WhatsApp</Button>
          </div>
        </BottomBar>
      ) : (
        <BottomBar><Button className="w-full" variant="secondary" onClick={() => { setWaKind('CANCEL'); setSheet('wa'); }}>Kirim pemberitahuan batal</Button></BottomBar>
      )}

      <Sheet open={sheet === 'menu'} onClose={() => setSheet(null)} title="Aksi">
        <div className="grid gap-2">
          {canEdit ? <Button variant="secondary" onClick={() => nav(`/bookings/${id}/edit`)}>Ubah / jadwal ulang</Button> : null}
          {owner && b.status === 'CONFIRMED' ? <Button variant="secondary" onClick={() => setSheet('complete')}>Tandai selesai</Button> : null}
          <Button variant="secondary" onClick={() => nav('/bookings/new', { state: { duplicate: b } })}>Duplikat</Button>
          {b.gcalSyncStatus !== 'NONE' ? <Button variant="secondary" onClick={() => { setSheet(null); retrySync(); }}>Sinkron ulang kalender</Button> : null}
          {b.status === 'CONFIRMED' ? <Button variant="danger" onClick={() => setSheet('cancel')}>Batalkan booking</Button> : null}
        </div>
      </Sheet>

      {sheet === 'invoice' ? <InvoiceSheet b={b} onClose={() => setSheet(null)} /> : null}
      {sheet === 'wa' ? <WhatsAppSheet b={b} initialKind={waKind} onClose={() => setSheet(null)} onSent={refresh} /> : null}
      {sheet === 'cancel' ? <CancelSheet b={b} onClose={() => setSheet(null)} onDone={(d) => { refresh(d); setSheet(null); toast('Booking dibatalkan'); }} /> : null}
      {sheet === 'complete' || sheet === 'payment' ? (
        <PaymentSheet b={b} mode={sheet} onClose={() => setSheet(null)} onDone={(d) => { refresh(d); setSheet(null); toast(sheet === 'complete' ? 'Booking selesai' : 'Pembayaran dicatat'); }} />
      ) : null}
    </>
  );
}

function Line({ label, value, strong, accent }: { label: string; value: number; strong?: boolean; accent?: boolean }) {
  return (
    <div className={cx('flex justify-between gap-3 text-sm', strong && 'font-semibold text-base', accent && 'text-accent-text')}>
      <span className={cx(!strong && 'text-muted')}>{label}</span>
      <Money value={value} />
    </div>
  );
}

/** S7 Invoice preview: Download / Share via the phone share sheet (US-16). */
function InvoiceSheet({ b, onClose }: { b: any; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const filename = `Invoice_${b.clientNameSnap.replace(/[^\p{L}\p{N}]+/gu, '_')}_${b.startAt.slice(0, 10)}.pdf`;
  useEffect(() => {
    let u: string | null = null;
    api.blob(`/bookings/${b.id}/invoice.pdf`).then((blob) => {
      u = URL.createObjectURL(blob);
      setUrl(u);
      setFile(new File([blob], filename, { type: 'application/pdf' }));
    }).catch((e) => setError(e));
    return () => { if (u) URL.revokeObjectURL(u); };
  }, [b.id, b.version, filename]);
  const canShare = !!file && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
  const invNo = `INV-${b.bookingNo}${b.invoiceRev > 0 ? `-R${b.invoiceRev}` : ''}`;
  return (
    <Sheet open onClose={onClose} title={invNo}
      footer={url ? (
        <div className="grid grid-cols-2 gap-3">
          <a href={url} download={filename} className="min-h-11 rounded-2xl border border-line glass grid place-items-center font-medium">Unduh</a>
          <Button disabled={!canShare} onClick={() => navigator.share({ files: [file!], title: invNo }).catch(() => undefined)}>Bagikan</Button>
        </div>
      ) : undefined}>
      {error ? (
        error.code === 'NO_BANK' ? <Banner tone="warn" action={<Link to="/admin/settings" className="underline font-medium">Pengaturan</Link>}>{error.message}</Banner> : <Banner tone="bad">{error.message}</Banner>
      ) : !url ? <Spinner /> : (
        // inline PDF embeds don't render on Android Chrome, so show a summary and hand the file to the native viewer
        <>
          <Card className="space-y-1 text-sm">
            <div className="flex items-center gap-3">
              <span className="size-12 rounded-xl bg-accent-soft text-accent-text grid place-items-center font-semibold text-xs">PDF</span>
              <div className="min-w-0">
                <div className="font-semibold truncate">{filename}</div>
                <div className="text-muted">A5 · {file ? Math.max(1, Math.round(file.size / 1024)) : 0} KB</div>
              </div>
            </div>
            <div className="pt-2 flex justify-between"><span className="text-muted">Total</span><Money value={b.total} /></div>
            <div className="flex justify-between"><span className="text-muted">DP / dibayar</span><Money value={b.paidAmount} /></div>
            <div className="flex justify-between font-semibold"><span>Sisa</span><Money value={b.balance} /></div>
          </Card>
          <a href={url} target="_blank" rel="noreferrer" className="block text-center text-accent-text font-medium min-h-11 leading-[44px]">Buka PDF</a>
          {!canShare ? <p className="text-xs text-muted">Berbagi file tidak didukung di perangkat ini — unduh lalu lampirkan di WhatsApp.</p> : null}
        </>
      )}
    </Sheet>
  );
}

const WA_KINDS: [string, string][] = [['NEW', 'Booking baru'], ['BALANCE', 'Pelunasan'], ['RESCHEDULE', 'Jadwal ulang'], ['CANCEL', 'Pembatalan']];

/** S8 WhatsApp message (L2-2.2): editable text, Copy, Open WhatsApp, record "sent". */
function WhatsAppSheet({ b, initialKind, onClose, onSent }: { b: any; initialKind: string; onClose: () => void; onSent: (d: any) => void }) {
  const toast = useToast();
  const [kind, setKind] = useState(initialKind);
  const [text, setText] = useState('');
  const [copyHint, setCopyHint] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const msg = useQuery({ queryKey: ['message', b.id, kind, b.version], queryFn: () => api.get(`/bookings/${b.id}/message?kind=${kind}`) });
  useEffect(() => { if (msg.data) setText(msg.data.text); }, [msg.data]);
  const hasReschedule = b.history.some((h: any) => h.action === 'RESCHEDULE');
  const kinds = WA_KINDS.filter(([k]) => (b.status === 'CANCELLED' ? k === 'CANCEL' : k !== 'CANCEL' && (k !== 'RESCHEDULE' || hasReschedule)));

  const markSent = async () => {
    if (b.invoiceSentAt) return;
    try { onSent(await api.post(`/bookings/${b.id}/invoice-sent`)); } catch { /* not critical */ }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Tersalin');
      markSent();
    } catch {
      // US-17.5: clipboard blocked → select the text for a manual copy
      area.current?.focus();
      area.current?.select();
      setCopyHint(true);
    }
  };
  const waHref = b.clientPhoneSnap ? `https://wa.me/${b.clientPhoneSnap}?text=${encodeURIComponent(text)}` : undefined;
  const undo = async () => { onSent(await api.del(`/bookings/${b.id}/invoice-sent`)); };

  return (
    <Sheet open onClose={onClose} title="Pesan WhatsApp"
      footer={
        <div className="grid grid-cols-2 gap-3">
          <Button variant="secondary" onClick={copy} disabled={!text}>Salin</Button>
          {waHref ? (
            <a href={waHref} target="_blank" rel="noreferrer" onClick={markSent} className="min-h-11 rounded-xl bg-accent text-accent-ink grid place-items-center font-medium">Buka WhatsApp</a>
          ) : <Button disabled title="Tambahkan nomor telepon">Buka WhatsApp</Button>}
        </div>
      }>
      <div className="flex gap-2 overflow-x-auto -mx-4 px-4 pb-1">
        {kinds.map(([k, l]) => <Chip key={k} active={kind === k} onClick={() => setKind(k)}>{l}</Chip>)}
      </div>
      {msg.isLoading ? <Spinner /> : (
        <textarea ref={area} className={cx(inputCls, 'min-h-[45dvh] text-sm leading-relaxed')} value={text} onChange={(e) => setText(e.target.value)} aria-label="Teks pesan" />
      )}
      {!b.clientPhoneSnap ? <p className="text-sm text-muted">Tambahkan nomor telepon untuk membuka WhatsApp langsung. Salin tetap bisa.</p> : null}
      {copyHint ? <Banner tone="info">Tekan lama pada teks lalu pilih Salin.</Banner> : null}
      {b.invoiceSentAt ? (
        <p className="text-sm text-muted">Ditandai terkirim {wibTime(b.invoiceSentAt)} · <button className="text-accent-text underline" onClick={undo}>Belum terkirim</button></p>
      ) : null}
    </Sheet>
  );
}

function CancelSheet({ b, onClose, onDone }: { b: any; onClose: () => void; onDone: (d: any) => void }) {
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!reason) { setError('Pilih alasan'); return; }
    setBusy(true);
    try { onDone(await api.post(`/bookings/${b.id}/cancel`, { reason, note: note || null })); }
    catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  };
  return (
    <Sheet open onClose={onClose} title="Batalkan booking"
      footer={<div className="grid grid-cols-2 gap-3"><Button variant="secondary" onClick={onClose}>Kembali</Button><Button variant="danger" busy={busy} onClick={submit}>Batalkan</Button></div>}>
      <Card className="text-sm">
        <div className="font-semibold">{b.bookingNo} · {b.clientNameSnap}</div>
        <div className="text-muted">{longDateId(b.startAt)}, {wibTime(b.startAt)}–{wibTime(b.endAt)} · {formatRp(b.total)}</div>
      </Card>
      {b.paidAmount > 0 ? <Banner tone="warn">DP {formatRp(b.paidAmount)} tercatat — selesaikan refund atau hangus di luar aplikasi.</Banner> : null}
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-muted mb-1">Alasan</legend>
        {CANCEL_REASONS.map(([k, l]) => (
          <label key={k} className={cx('flex items-center gap-3 rounded-xl border px-3 min-h-11', reason === k ? 'border-accent-text bg-accent-soft shadow-[0_0_0_4px_var(--color-accent-soft)]' : 'border-line glass')}>
            <input type="radio" name="reason" value={k} checked={reason === k} onChange={() => { setReason(k); setError(''); }} className="accent-[var(--color-accent)]" />
            {l}
          </label>
        ))}
      </fieldset>
      <Field label="Catatan (opsional)" htmlFor="cnote"><Input id="cnote" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      {error ? <p className="text-sm text-bad" role="alert">{error}</p> : null}
    </Sheet>
  );
}

/** L2-1.5: complete with payment status; later payments for receivables. */
function PaymentSheet({ b, mode, onClose, onDone }: { b: any; mode: 'complete' | 'payment'; onClose: () => void; onDone: (d: any) => void }) {
  const [paid, setPaid] = useState<number | null>(mode === 'complete' ? b.paidAmount : b.total);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const over = (paid ?? 0) > b.total;
  const submit = async () => {
    setBusy(true);
    try { onDone(await api.post(`/bookings/${b.id}/${mode}`, { paidAmount: paid ?? 0 })); }
    catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  };
  return (
    <Sheet open onClose={onClose} title={mode === 'complete' ? 'Tandai selesai' : 'Catat pembayaran'}
      footer={<Button className="w-full" busy={busy} disabled={over || paid == null} onClick={submit}>{mode === 'complete' ? 'Tandai selesai' : 'Simpan pembayaran'}</Button>}>
      <p className="text-sm text-muted">Total {formatRp(b.total)} · DP {formatRp(b.dpAmount)}</p>
      <div className="flex flex-wrap gap-2">
        <Chip active={paid === b.total} onClick={() => setPaid(b.total)}>Lunas</Chip>
        {b.dpAmount > 0 && b.dpAmount < b.total ? <Chip active={paid === b.dpAmount} onClick={() => setPaid(b.dpAmount)}>DP saja</Chip> : null}
        <Chip active={paid === 0} onClick={() => setPaid(0)}>Belum bayar</Chip>
      </div>
      <Field label="Total sudah dibayar" htmlFor="paid" error={over ? 'Pembayaran tidak boleh melebihi total' : error}>
        <MoneyInput id="paid" value={paid} onChange={setPaid} invalid={over} />
      </Field>
      <p className="text-sm">Sisa: <Money value={Math.max(0, b.total - (paid ?? 0))} className="font-semibold" /></p>
      {mode === 'complete' && b.photographerNameSnap ? <p className="text-sm text-muted">Draft fee fotografer untuk {b.photographerNameSnap} akan dibuat di Keuangan.</p> : null}
    </Sheet>
  );
}
