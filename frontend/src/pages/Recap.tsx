import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatRp, monthLabelId, shortDateId, wibMonth } from '@jes/shared';
import { ApiError, api } from '../api';
import { Banner, Button, Card, Chip, Field, Input, Money, Page, PageHeader, Sheet, Spinner, cx, useToast } from '../ui';
import { ExpenseRow, FinanceTabs, MonthSwitcher, useMonthParam } from './Finance';

/** S18 Monthly recap (L2-4.3, PRD §6.5). */
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

  const maxCat = Math.max(1, ...(r?.expenses.byCategory.map((c: any) => c.amount) ?? [1]));
  const prevDelta = r ? r.netProfit - r.previous.netProfit : 0;
  const empty = r && r.revenue.bookingCount === 0 && r.expenses.total === 0 && r.drafts.count === 0;

  return (
    <>
      <PageHeader title="Keuangan" />
      <FinanceTabs />
      <Page>
        <MonthSwitcher month={month} onChange={setMonth} />
        <div className="flex gap-2">
          <Chip active={(basis || r?.basis) === 'BILLED'} onClick={() => setBasis('BILLED')}>Ditagih</Chip>
          <Chip active={(basis || r?.basis) === 'COLLECTED'} onClick={() => setBasis('COLLECTED')}>Diterima</Chip>
        </div>
        {recap.isLoading || !r ? <Spinner /> : (
          <>
            {r.closed ? <Banner tone="info" action={<button className="underline font-medium" onClick={() => setReopenOpen(true)}>Buka kembali</button>}>Bulan ini sudah ditutup — data terkunci.</Banner> : null}
            {r.drafts.count ? <Banner tone="warn" action={<Link to="/finance/expenses" className="underline font-medium">Tinjau</Link>}>{r.drafts.count} biaya draft ({formatRp(r.drafts.amount)}) belum termasuk</Banner> : null}
            {empty ? <Banner tone="info">Tidak ada transaksi bulan ini.</Banner> : null}

            {/* Net profit first (PRD §8.6) */}
            <Card className="text-center py-6">
              <div className="text-sm text-muted">Laba bersih{r.marginPct != null ? ` · margin ${r.marginPct}%` : ''}</div>
              <Money value={r.netProfit} className={cx('text-4xl font-bold block my-1', r.netProfit < 0 ? 'text-bad' : 'text-ok')} />
              {r.netProfit < 0 ? <div className="text-sm text-bad">Rugi {formatRp(-r.netProfit)}</div> : null}
              <div className="text-sm text-muted">vs {monthLabelId(r.previous.month)}: <span className={prevDelta < 0 ? 'text-bad' : 'text-ok'}>{prevDelta >= 0 ? '+' : ''}{formatRp(prevDelta)}</span></div>
            </Card>

            <Card className="space-y-2">
              <div className="flex justify-between font-semibold"><span>Pendapatan ({r.basis === 'BILLED' ? 'ditagih' : 'diterima'})</span><Money value={r.revenue.total} /></div>
              {r.revenue.byType.map((t: any) => (
                <Row key={t.name} label={`${t.name} (${t.count} booking)`} value={t.amount} onClick={() => setDrill({ title: t.name, kind: 'type', key: t.name })} />
              ))}
              <Row label="Add-on" value={r.revenue.addons} onClick={() => setDrill({ title: 'Add-on', kind: 'addons' })} />
              {r.revenue.adjustments ? <Row label="Penyesuaian harga" value={r.revenue.adjustments} /> : null}
              {r.revenue.uncollected ? <Row label="Belum diterima" value={-r.revenue.uncollected} /> : null}
              {r.revenue.upcoming ? <p className="text-xs text-muted">Termasuk {formatRp(r.revenue.upcoming)} dari sesi yang belum berlangsung.</p> : null}
            </Card>

            <Card className="space-y-3">
              <div className="flex justify-between font-semibold"><span>Pengeluaran</span><span className="tabular">−{formatRp(r.expenses.total)}</span></div>
              {r.expenses.byCategory.length === 0 ? <p className="text-sm text-muted">Belum ada pengeluaran terkonfirmasi.</p> : null}
              {r.expenses.byCategory.map((c: any) => (
                <button key={c.id} className="w-full text-left space-y-1" onClick={() => setDrill({ title: c.name, kind: 'cat', key: c.id })}>
                  <div className="flex justify-between text-sm"><span>{c.name} <span className="text-muted">({c.count})</span></span><span className="tabular">−{formatRp(c.amount)}</span></div>
                  <div className="h-2 rounded-full bg-sunken overflow-hidden"><div className="h-full bg-accent rounded-full" style={{ width: `${(c.amount / maxCat) * 100}%` }} /></div>
                </button>
              ))}
            </Card>

            <Card className="space-y-2">
              <div className="flex justify-between font-semibold"><span>Piutang</span><Money value={r.receivables.total} /></div>
              {r.receivables.items.length === 0 ? <p className="text-sm text-muted">Semua sudah lunas.</p> : r.receivables.items.map((x: any) => (
                <Link key={x.id} to={`/bookings/${x.id}`} className="flex justify-between gap-2 text-sm min-h-11 items-center border-t border-line first:border-0">
                  <span className="truncate">{shortDateId(x.startAt)} · {x.clientName} <span className="text-muted">{x.bookingNo}</span></span>
                  <span className="tabular text-accent">{formatRp(x.balance)}</span>
                </Link>
              ))}
            </Card>

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

function Row({ label, value, onClick }: { label: string; value: number; onClick?: () => void }) {
  return (
    <button disabled={!onClick} onClick={onClick} className="w-full flex justify-between gap-3 text-sm min-h-9 items-center text-left">
      <span className="text-muted">{label}{onClick ? ' ›' : ''}</span><Money value={value} />
    </button>
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
