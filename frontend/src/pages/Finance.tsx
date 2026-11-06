import { useState } from 'react';
import { Link, NavLink, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatRp, monthLabelId, shiftMonth, shortDateId, wibMonth } from '@jes/shared';
import { ApiError, api } from '../api';
import { Banner, Button, Card, Empty, Money, MoneyInput, Page, PageHeader, Sheet, Spinner, StatusBadge, cx, useToast } from '../ui';

export function MonthSwitcher({ month, onChange }: { month: string; onChange: (m: string) => void }) {
  return (
    <div className="flex items-center justify-between rounded-2xl bg-surface border border-line">
      <button className="size-11 grid place-items-center text-xl" aria-label="Bulan sebelumnya" onClick={() => onChange(shiftMonth(month, -1))}>‹</button>
      <span className="font-semibold">{monthLabelId(month)}</span>
      <button className="size-11 grid place-items-center text-xl disabled:opacity-30" aria-label="Bulan berikutnya" disabled={month >= wibMonth(new Date())} onClick={() => onChange(shiftMonth(month, 1))}>›</button>
    </div>
  );
}

export function useMonthParam() {
  const [sp, setSp] = useSearchParams();
  const month = sp.get('month') ?? wibMonth(new Date());
  return [month, (m: string) => setSp({ month: m }, { replace: true })] as const;
}

/** Finance section tabs: Dashboard · Pengeluaran · Rekap (Owner only). */
export function FinanceTabs() {
  const tabs: [string, string][] = [['/finance', 'Dashboard'], ['/finance/expenses', 'Pengeluaran'], ['/finance/recap', 'Rekap']];
  return (
    <nav className="sticky top-14 z-10 bg-bg/95 backdrop-blur border-b border-line" aria-label="Keuangan">
      <div className="mx-auto max-w-[480px] px-4 flex gap-1">
        {tabs.map(([to, label]) => (
          <NavLink key={to} to={to} end
            className={({ isActive }) => cx('flex-1 text-center text-sm font-medium min-h-11 grid place-items-center border-b-2', isActive ? 'border-accent text-ink' : 'border-transparent text-muted')}>
            {label}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}

/** S15 Expenses: month KPIs, draft to-do, expenses of the month (PRD §8.6). */
export default function Finance() {
  const [month, setMonth] = useMonthParam();
  const recap = useQuery({ queryKey: ['recap', month, ''], queryFn: () => api.get(`/reports/recap?month=${month}`) });
  const drafts = useQuery({ queryKey: ['expenses', 'drafts'], queryFn: () => api.get('/expenses?status=DRAFT') });
  const expenses = useQuery({ queryKey: ['expenses', month], queryFn: () => api.get(`/expenses?month=${month}&status=CONFIRMED`) });
  const [confirming, setConfirming] = useState<any>(null);
  const r = recap.data;

  return (
    <>
      <PageHeader title="Keuangan" />
      <FinanceTabs />
      <Page className="pb-28">
        <MonthSwitcher month={month} onChange={setMonth} />
        {recap.isLoading ? <Spinner /> : r ? (
          <div className="grid grid-cols-2 gap-3">
            <Kpi label="Pendapatan" value={r.revenue.total} />
            <Kpi label="Pengeluaran" value={-r.expenses.total} />
            <Link to={`/finance/recap?month=${month}`} className="col-span-2">
              <Kpi label={`Laba bersih${r.marginPct != null ? ` · margin ${r.marginPct}%` : ''}`} value={r.netProfit} big tone={r.netProfit < 0 ? 'bad' : 'ok'} />
            </Link>
          </div>
        ) : null}

        {drafts.data?.length ? (
          <section className="space-y-2">
            <h2 className="font-semibold">Perlu dikonfirmasi <span className="text-muted font-normal">({drafts.data.length})</span></h2>
            {drafts.data.map((e: any) => (
              <button key={e.id} onClick={() => setConfirming(e)} className="w-full text-left rounded-2xl bg-warn-soft border border-line p-3 flex items-center gap-3 active:opacity-80">
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{e.note ?? e.categoryName}</div>
                  <div className="text-xs text-muted">{e.categoryName} · {shortDateId(e.paidOn + 'T05:00:00Z')}{e.bookingNo ? ` · ${e.bookingNo}` : ''}</div>
                </div>
                <span className="tabular font-semibold">{e.amount == null ? 'Isi jumlah' : formatRp(e.amount)}</span>
              </button>
            ))}
          </section>
        ) : null}

        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Pengeluaran {monthLabelId(month)}</h2>
          </div>
          {expenses.isLoading ? <Spinner /> : expenses.data?.length ? expenses.data.map((e: any) => <ExpenseRow key={e.id} e={e} />) : <Empty>Belum ada pengeluaran bulan ini.</Empty>}
        </section>
      </Page>
      <div className="fixed bottom-20 inset-x-0 z-30 pointer-events-none">
        <div className="mx-auto max-w-[480px] px-4 flex justify-end">
          <Link to="/finance/expenses/new" className="pointer-events-auto rounded-full bg-accent text-accent-ink px-5 min-h-12 grid place-items-center font-medium shadow-lg">+ Pengeluaran</Link>
        </div>
      </div>
      {confirming ? <ConfirmDraft e={confirming} onClose={() => setConfirming(null)} /> : null}
    </>
  );
}

export function ExpenseRow({ e }: { e: any }) {
  return (
    <Link to={`/finance/expenses/${e.id}`} className="flex items-center gap-3 rounded-2xl bg-surface border border-line p-3 active:bg-sunken">
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{e.categoryName}{e.payee ? <span className="text-muted font-normal"> · {e.payee}</span> : null}</div>
        <div className="text-xs text-muted truncate">{shortDateId(e.paidOn + 'T05:00:00Z')}{e.note ? ` · ${e.note}` : ''}{e.receiptKey ? ' · 📎' : ''}</div>
      </div>
      {e.status === 'DRAFT' ? <StatusBadge status="DRAFT" /> : null}
      <span className="tabular font-medium">{e.amount == null ? '—' : `−${formatRp(e.amount)}`}</span>
    </Link>
  );
}

function Kpi({ label, value, big, tone }: { label: string; value: number; big?: boolean; tone?: 'ok' | 'bad' }) {
  return (
    <Card className={cx(big && 'py-5')}>
      <div className="text-sm text-muted">{label}</div>
      <Money value={value} className={cx('font-semibold block', big ? 'text-3xl' : 'text-lg', tone === 'bad' && 'text-bad', tone === 'ok' && 'text-ok')} />
    </Card>
  );
}

/** PRD 4.2.2: confirm, change the amount, or Rp0 for "no fee". */
function ConfirmDraft({ e, onClose }: { e: any; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [amount, setAmount] = useState<number | null>(e.amount);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    try {
      await fn();
      qc.invalidateQueries({ queryKey: ['expenses'] });
      qc.invalidateQueries({ queryKey: ['recap'] });
      qc.invalidateQueries({ queryKey: ['booking'] });
      toast(msg);
      onClose();
    } catch (err) { setError((err as ApiError).message); } finally { setBusy(false); }
  };
  return (
    <Sheet open onClose={onClose} title="Konfirmasi biaya"
      footer={
        <div className="grid grid-cols-2 gap-3">
          <Button variant="secondary" busy={busy} onClick={() => run(() => api.del(`/expenses/${e.id}`), 'Draft dihapus')}>Hapus draft</Button>
          <Button busy={busy} disabled={amount == null} onClick={() => run(() => api.post(`/expenses/${e.id}/confirm`, { amount }), amount === 0 ? 'Tanpa biaya' : 'Dikonfirmasi')}>Konfirmasi</Button>
        </div>
      }>
      <p className="font-medium">{e.note ?? e.categoryName}</p>
      {e.bookingNo ? <Link to={`/bookings/${e.bookingId}`} className="text-sm text-accent">Lihat booking {e.bookingNo}</Link> : null}
      <MoneyInput value={amount} onChange={setAmount} />
      <p className="text-sm text-muted">Isi Rp0 bila tidak ada biaya (mis. Owner memotret sendiri).</p>
      {error ? <Banner tone="bad">{error}</Banner> : null}
    </Sheet>
  );
}
