import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatRp, monthLabelId, shortDateId, wibMonth } from '@jes/shared';
import { ApiError, api } from '../api';
import { Banner, Button, Card, Field, Input, Money, Page, Sheet, Spinner, cx, useToast } from '../ui';
import { ExpenseRow, FinanceHeader, useMonthParam } from './Finance';

/** Laporan: the formal monthly statement (L2-4.3, PRD §6.5) — income, expenses, net, receivables, export, close. */
export default function Recap() {
  const [month, setMonth] = useMonthParam();
  const [basis, setBasis] = useState<'' | 'BILLED' | 'COLLECTED'>('');
  const qc = useQueryClient();
  const toast = useToast();
  const recap = useQuery({ queryKey: ['recap', month, basis], queryFn: () => api.get(`/reports/recap?month=${month}${basis ? `&basis=${basis}` : ''}`) });
  const [drill, setDrill] = useState<null | { title: string; kind: 'cat' | 'type' | 'addons'; key?: string }>(null);
  const [closeOpen, setCloseOpen] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const r = recap.data;

  const download = async (kind: 'csv' | 'pdf') => {
    try {
      const blob = await api.blob(`/reports/recap.${kind}?month=${month}`);
      const file = new File([blob], `rekap-${month}.${kind}`, { type: blob.type });
      if (kind === 'pdf' && navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: `Rekap ${monthLabelId(month)}` }).catch(() => undefined); return; }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = file.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) { toast((e as ApiError).message, 'bad'); }
  };

  const act = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    setErr('');
    try { await fn(); qc.invalidateQueries({ queryKey: ['recap'] }); toast(msg); setCloseOpen(false); setReopenOpen(false); setReason(''); }
    catch (e) { setErr((e as ApiError).message); }
    finally { setBusy(false); }
  };

  const empty = r && r.revenue.bookingCount === 0 && r.expenses.total === 0 && r.drafts.count === 0;
  const effBasis = basis || r?.basis;

  return (
    <>
      <FinanceHeader month={month} onMonth={setMonth} />
      <Page className="pb-28">
        <div className="flex items-center justify-between gap-3">
          <div className="flex rounded-full border border-line p-0.5 text-sm" role="group" aria-label="Basis pendapatan">
            {(['BILLED', 'COLLECTED'] as const).map((b) => (
              <button key={b} onClick={() => setBasis(b)} aria-pressed={effBasis === b}
                className={cx('rounded-full px-4 min-h-9', effBasis === b ? 'bg-accent text-accent-ink' : 'text-muted')}>{b === 'BILLED' ? 'Ditagih' : 'Diterima'}</button>
            ))}
          </div>
          <span className="text-xs text-muted text-right">{effBasis === 'COLLECTED' ? 'Uang yang sudah diterima' : 'Nilai semua booking'}</span>
        </div>
        {recap.isLoading || !r ? <Spinner /> : (
          <>
            {r.closed ? <Banner tone="info" action={<button className="underline font-medium" onClick={() => setReopenOpen(true)}>Buka kembali</button>}>Bulan ini sudah ditutup — data terkunci.</Banner> : null}
            {r.drafts.count ? <Banner tone="warn" action={<Link to={`/finance/expenses?month=${month}`} className="underline font-medium">Tinjau</Link>}>{r.drafts.count} biaya draft ({formatRp(r.drafts.amount)}) belum termasuk</Banner> : null}
            {empty ? <Banner tone="info">Tidak ada transaksi bulan ini.</Banner> : null}

            {/* the statement: income, expenses, net — one table, every line tappable for its detail */}
            <Card className="space-y-1">
              <h2 className="font-semibold pb-1">Laporan laba rugi · {monthLabelId(month)}</h2>
              <Head label="Pendapatan" />
              {r.revenue.byType.map((t: any) => (
                <Row key={t.name} label={`${t.name} · ${t.count} booking`} value={t.amount} onClick={() => setDrill({ title: t.name, kind: 'type', key: t.name })} />
              ))}
              <Row label="Add-on" value={r.revenue.addons} onClick={() => setDrill({ title: 'Add-on', kind: 'addons' })} />
              {r.revenue.adjustments ? <Row label="Penyesuaian harga" value={r.revenue.adjustments} /> : null}
              {r.revenue.uncollected ? <Row label="Belum diterima" value={-r.revenue.uncollected} /> : null}
              <Total label="Total pendapatan" value={r.revenue.total} />

              <Head label="Pengeluaran" />
              {r.expenses.byCategory.length === 0 ? <p className="text-sm text-muted py-1">Belum ada pengeluaran terkonfirmasi.</p> : null}
              {r.expenses.byCategory.map((c: any) => (
                <Row key={c.id} label={`${c.name} · ${c.count}×`} value={-c.amount} onClick={() => setDrill({ title: c.name, kind: 'cat', key: c.id })} />
              ))}
              <Total label="Total pengeluaran" value={-r.expenses.total} />

              <div className="flex justify-between items-baseline gap-3 border-t-2 border-ink/80 pt-3 mt-2">
                <span className="font-semibold">{r.netProfit < 0 ? 'Rugi bersih' : 'Laba bersih'}{r.marginPct != null ? <span className="text-muted font-normal text-sm"> · margin {r.marginPct}%</span> : null}</span>
                <Money value={r.netProfit} className={cx('font-display text-2xl font-semibold', r.netProfit < 0 && 'text-bad')} />
              </div>
              {r.revenue.upcoming ? <p className="text-xs text-muted pt-1">Termasuk {formatRp(r.revenue.upcoming)} dari sesi yang belum berlangsung.</p> : null}
            </Card>

            <section id="piutang" className="scroll-mt-40"><Card className="space-y-2">
              <div className="flex justify-between font-semibold"><span>Piutang · belum lunas</span><Money value={r.receivables.total} /></div>
              {r.receivables.items.length === 0 ? <p className="text-sm text-muted">Semua sudah lunas.</p> : r.receivables.items.map((x: any) => (
                <Link key={x.id} to={`/bookings/${x.id}`} className="flex justify-between gap-2 text-sm min-h-11 items-center border-t border-line first:border-0">
                  <span className="truncate">{shortDateId(x.startAt)} · {x.clientName} <span className="text-muted">{x.bookingNo}</span></span>
                  <span className="tabular text-accent-text">{formatRp(x.balance)}</span>
                </Link>
              ))}
            </Card></section>

            <div className="grid grid-cols-2 gap-3">
              <Button variant="secondary" onClick={() => download('csv')}>Ekspor CSV</Button>
              <Button variant="secondary" onClick={() => download('pdf')}>Ekspor PDF</Button>
            </div>
            {!r.closed && month < wibMonth(new Date()) ? <Button variant="ghost" className="w-full" onClick={() => setCloseOpen(true)}>Tutup bulan {monthLabelId(month)}</Button> : null}
          </>
        )}
      </Page>

      {drill && r ? <Drill recap={r} month={month} drill={drill} onClose={() => setDrill(null)} /> : null}

      <Sheet open={closeOpen} onClose={() => setCloseOpen(false)} title={`Tutup ${monthLabelId(month)}?`}
        footer={<Button className="w-full" busy={busy} onClick={() => act(() => api.post(`/reports/months/${month}/close`), 'Bulan ditutup')}>Tutup bulan</Button>}>
        <p>Booking dan pengeluaran bulan ini menjadi hanya-baca. Anda bisa membukanya kembali dengan alasan.</p>
        {err ? <Banner tone="bad">{err}</Banner> : null}
      </Sheet>
      <Sheet open={reopenOpen} onClose={() => setReopenOpen(false)} title={`Buka kembali ${monthLabelId(month)}`}
        footer={<Button className="w-full" busy={busy} disabled={reason.trim().length < 3} onClick={() => act(() => api.post(`/reports/months/${month}/reopen`, { reason }), 'Bulan dibuka kembali')}>Buka kembali</Button>}>
        <Field label="Alasan" htmlFor="rr" error={err}><Input id="rr" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="mis. koreksi tagihan listrik" /></Field>
      </Sheet>
    </>
  );
}

function Head({ label }: { label: string }) {
  return <div className="hud text-muted pt-3 first-of-type:pt-0">{label}</div>;
}

function Row({ label, value, onClick }: { label: string; value: number; onClick?: () => void }) {
  return (
    <button disabled={!onClick} onClick={onClick} className="w-full flex justify-between gap-3 text-sm min-h-10 items-center text-left pl-3">
      <span className="text-muted truncate">{label}{onClick ? ' ›' : ''}</span><Money value={value} className="shrink-0" />
    </button>
  );
}

function Total({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between gap-3 border-t border-line pt-2 font-semibold">
      <span>{label}</span><Money value={value} />
    </div>
  );
}

/** US-26.2: tap a line → its bookings or expenses. */
function Drill({ recap, month, drill, onClose }: { recap: any; month: string; drill: { title: string; kind: string; key?: string }; onClose: () => void }) {
  const exp = useQuery({ queryKey: ['expenses', month, drill.key], queryFn: () => api.get(`/expenses?month=${month}&categoryId=${drill.key}&status=CONFIRMED`), enabled: drill.kind === 'cat' });
  const bookings = drill.kind === 'type' ? recap.revenueBookings.filter((b: any) => b.type === drill.key) : drill.kind === 'addons' ? recap.revenueBookings : [];
  return (
    <Sheet open onClose={onClose} title={drill.title}>
      {drill.kind === 'cat' ? (exp.isLoading ? <Spinner /> : exp.data?.map((e: any) => <ExpenseRow key={e.id} e={e} />)) : bookings.map((b: any) => (
        <Link key={b.id} to={`/bookings/${b.id}`} className="flex justify-between gap-2 text-sm min-h-11 items-center border-b border-line">
          <span className="truncate">{shortDateId(b.startAt)} · {b.clientName} <span className="text-muted">{b.bookingNo}</span></span>
          <span className="tabular">{formatRp(b.total)}</span>
        </Link>
      ))}
    </Sheet>
  );
}
