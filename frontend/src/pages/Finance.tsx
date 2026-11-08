import { useState } from 'react';
import { Link, NavLink, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatRp, formatRpCompact, longDateId, monthLabelId, shiftMonth, shortDateId, wibMonth } from '@jes/shared';
import { ApiError, api } from '../api';
import { Banner, Button, Chip, Empty, MoneyInput, Page, PageHeader, Sheet, Spinner, StatusBadge, cx, useToast } from '../ui';

export function MonthSwitcher({ month, onChange }: { month: string; onChange: (m: string) => void }) {
  const current = wibMonth(new Date());
  return (
    <div className="flex items-center justify-between rounded-3xl glass border border-line">
      <button className="size-11 grid place-items-center text-xl" aria-label="Bulan sebelumnya" onClick={() => onChange(shiftMonth(month, -1))}>‹</button>
      <span className="font-semibold flex items-center gap-2">
        {monthLabelId(month)}
        {month === current ? <span className="hud text-[10px] rounded-full bg-accent-soft px-2 py-0.5 text-accent-text">berjalan</span> : null}
      </span>
      <button className="size-11 grid place-items-center text-xl disabled:opacity-30" aria-label="Bulan berikutnya" disabled={month >= current} onClick={() => onChange(shiftMonth(month, 1))}>›</button>
    </div>
  );
}

/** The selected month lives in the URL (?month=) so it carries across the three Keuangan tabs. */
export function useMonthParam() {
  const [sp, setSp] = useSearchParams();
  const month = sp.get('month') ?? wibMonth(new Date());
  const setMonth = (m: string) => {
    const n = new URLSearchParams(sp);
    n.set('month', m);
    setSp(n, { replace: true });
  };
  return [month, setMonth] as const;
}

/** Keuangan tabs: Ringkasan (how is the month going) · Pengeluaran (record costs) · Laporan (the statement). */
export function FinanceTabs() {
  const [sp] = useSearchParams();
  const month = sp.get('month');
  const tabs: [string, string][] = [['/finance', 'Ringkasan'], ['/finance/expenses', 'Pengeluaran'], ['/finance/recap', 'Laporan']];
  return (
    <nav className="mx-auto max-w-[480px] px-4 flex gap-1" aria-label="Keuangan">
      {tabs.map(([to, label]) => (
        <NavLink key={to} to={month ? `${to}?month=${month}` : to} end
          className={({ isActive }) => cx('flex-1 text-center text-sm font-medium min-h-11 grid place-items-center border-b-2', isActive ? 'border-accent text-ink' : 'border-transparent text-muted')}>
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

/** Shared header for all Keuangan tabs: title, tabs and the one month switcher, kept on screen while scrolling. */
export function FinanceHeader({ month, onMonth }: { month: string; onMonth: (m: string) => void }) {
  return (
    <>
      <PageHeader title="Keuangan" />
      <div className="sticky top-14 z-10 bg-bg/95 backdrop-blur border-b border-line pb-2">
        <FinanceTabs />
        <div className="mx-auto max-w-[480px] px-4 pt-2"><MonthSwitcher month={month} onChange={onMonth} /></div>
      </div>
    </>
  );
}

interface Expense { id: string; categoryId: string; categoryName: string; amount: number | null; paidOn: string; payee: string | null; note: string | null; receiptKey: string | null; status: string; bookingNo?: string; bookingId?: string }

/** Pengeluaran: the working view — confirm drafts, see and filter the month's costs, add a new one. No revenue figures here. */
export default function Finance() {
  const [month, setMonth] = useMonthParam();
  const [sp, setSp] = useSearchParams();
  const categoryId = sp.get('categoryId') ?? '';
  const expenses = useQuery({ queryKey: ['expenses', month], queryFn: () => api.get<Expense[]>(`/expenses?month=${month}&status=CONFIRMED`) });
  const prevMonth = useQuery({ queryKey: ['expenses', shiftMonth(month, -1)], queryFn: () => api.get<Expense[]>(`/expenses?month=${shiftMonth(month, -1)}&status=CONFIRMED`) });
  const drafts = useQuery({ queryKey: ['expenses', 'drafts'], queryFn: () => api.get<Expense[]>('/expenses?status=DRAFT') });
  const [confirming, setConfirming] = useState<Expense | null>(null);

  const all = expenses.data ?? [];
  const total = all.reduce((a, e) => a + (e.amount ?? 0), 0);
  const prevTotal = (prevMonth.data ?? []).reduce((a, e) => a + (e.amount ?? 0), 0);
  const cats = new Map<string, { id: string; name: string; amount: number; count: number }>();
  for (const e of all) {
    const c = cats.get(e.categoryId) ?? { id: e.categoryId, name: e.categoryName, amount: 0, count: 0 };
    c.amount += e.amount ?? 0; c.count++;
    cats.set(e.categoryId, c);
  }
  const catList = [...cats.values()].sort((a, b) => b.amount - a.amount);
  const shown = categoryId ? all.filter((e) => e.categoryId === categoryId) : all;
  const byDay = new Map<string, Expense[]>();
  for (const e of shown) byDay.set(e.paidOn, [...(byDay.get(e.paidOn) ?? []), e]);
  const monthDrafts = (drafts.data ?? []).filter((d) => d.paidOn.startsWith(month));
  const otherDrafts = (drafts.data ?? []).length - monthDrafts.length;
  const pickCategory = (id: string) => { const n = new URLSearchParams(sp); if (id) n.set('categoryId', id); else n.delete('categoryId'); setSp(n, { replace: true }); };

  return (
    <>
      <FinanceHeader month={month} onMonth={setMonth} />
      <Page className="pb-28">
        <div className="flex items-end justify-between gap-3">
          <div>
            <div className="hud text-muted">Total pengeluaran</div>
            <div className="font-display text-3xl font-semibold tabular">{expenses.isLoading ? '…' : formatRp(total)}</div>
          </div>
          <div className="text-right text-sm text-muted">
            <div>{all.length} transaksi</div>
            {prevMonth.data ? <div>{shortMonth(shiftMonth(month, -1))}: {formatRpCompact(prevTotal)}</div> : null}
          </div>
        </div>

        {!monthDrafts.length && otherDrafts ? (
          <p className="text-xs text-muted">{otherDrafts} biaya draft menunggu konfirmasi di bulan lain.</p>
        ) : null}
        {monthDrafts.length ? (
          <section className="space-y-2">
            <h2 className="font-semibold">Perlu dikonfirmasi <span className="text-muted font-normal">({monthDrafts.length})</span></h2>
            <p className="text-sm text-muted -mt-1">Draft belum dihitung dalam total sampai dikonfirmasi.</p>
            {monthDrafts.map((e) => (
              <button key={e.id} onClick={() => setConfirming(e)} className="w-full text-left rounded-2xl bg-warn-soft border border-line p-3 flex items-center gap-3 active:opacity-80">
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{e.note ?? e.categoryName}</div>
                  <div className="text-xs text-muted">{e.categoryName} · {shortDateId(e.paidOn + 'T05:00:00Z')}{e.bookingNo ? ` · ${e.bookingNo}` : ''}</div>
                </div>
                <span className="tabular font-semibold">{e.amount == null ? 'Isi jumlah' : formatRp(e.amount)}</span>
              </button>
            ))}
            {otherDrafts ? <p className="text-xs text-muted">{otherDrafts} draft lain menunggu di bulan lain.</p> : null}
          </section>
        ) : null}

        {catList.length ? (
          <div className="flex gap-2 overflow-x-auto -mx-4 px-4 pb-1" role="group" aria-label="Filter kategori">
            <Chip active={!categoryId} onClick={() => pickCategory('')}>Semua</Chip>
            {catList.map((c) => (
              <Chip key={c.id} active={categoryId === c.id} onClick={() => pickCategory(c.id)}>{c.name} · {formatRpCompact(c.amount).replace('Rp', '')}</Chip>
            ))}
          </div>
        ) : null}

        <section className="space-y-3">
          {expenses.isLoading ? <Spinner /> : expenses.isError ? (
            <Banner tone="bad" action={<button className="underline font-medium min-h-11" onClick={() => expenses.refetch()}>Coba lagi</button>}>{(expenses.error as Error).message}</Banner>
          ) : shown.length ? [...byDay.entries()].map(([day, list]) => (
            <div key={day} className="space-y-2">
              <h3 className="text-sm text-muted font-medium flex justify-between">
                <span>{longDateId(day + 'T05:00:00Z')}</span>
                <span className="tabular">−{formatRp(list.reduce((a, e) => a + (e.amount ?? 0), 0))}</span>
              </h3>
              {list.map((e) => <ExpenseRow key={e.id} e={e} hideDate />)}
            </div>
          )) : <Empty>Belum ada pengeluaran di {monthLabelId(month)}.</Empty>}
        </section>
      </Page>
      <div className="fixed bottom-24 inset-x-0 z-30 pointer-events-none">
        <div className="mx-auto max-w-[480px] px-4 flex justify-end">
          <Link to="/finance/expenses/new" className="pointer-events-auto rounded-full bg-accent text-accent-ink px-5 min-h-12 grid place-items-center font-medium shadow-lg">+ Pengeluaran</Link>
        </div>
      </div>
      {confirming ? <ConfirmDraft e={confirming} onClose={() => setConfirming(null)} /> : null}
    </>
  );
}

const shortMonth = (m: string) => monthLabelId(m).slice(0, 3);

export function ExpenseRow({ e, hideDate }: { e: any; hideDate?: boolean }) {
  return (
    <Link to={`/finance/expenses/${e.id}`} className="flex items-center gap-3 rounded-3xl glass border border-line p-3 active:bg-accent-soft">
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{e.categoryName}{e.payee ? <span className="text-muted font-normal"> · {e.payee}</span> : null}</div>
        <div className="text-xs text-muted truncate">{hideDate ? '' : `${shortDateId(e.paidOn + 'T05:00:00Z')} · `}{e.note ?? ''}{e.receiptKey ? ' · 📎' : ''}</div>
      </div>
      {e.status === 'DRAFT' ? <StatusBadge status="DRAFT" /> : null}
      <span className="tabular font-medium">{e.amount == null ? '—' : `−${formatRp(e.amount)}`}</span>
    </Link>
  );
}

/** PRD 4.2.2: confirm, change the amount, or Rp0 for "no fee". */
function ConfirmDraft({ e, onClose }: { e: Expense; onClose: () => void }) {
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
      qc.invalidateQueries({ queryKey: ['trend'] });
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
      {e.bookingNo ? <Link to={`/bookings/${e.bookingId}`} className="text-sm text-accent-text">Lihat booking {e.bookingNo}</Link> : null}
      <MoneyInput value={amount} onChange={setAmount} />
      <p className="text-sm text-muted">Isi Rp0 bila tidak ada biaya (mis. Owner memotret sendiri).</p>
      {error ? <Banner tone="bad">{error}</Banner> : null}
    </Sheet>
  );
}
