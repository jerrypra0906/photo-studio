import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { formatRp, formatRpCompact, monthLabelId, shiftMonth, shortMonthId, wibMonth } from '@jes/shared';
import { api } from '../api';
import { ColumnChart } from '../charts';
import { Banner, Card, Empty, Spinner, cx } from '../ui';
import { FinanceHeader, useMonthParam } from './Finance';

interface TrendMonth { month: string; bookings: number; upcoming: number; revenue: number; expenses: number; net: number; marginPct: number | null; partial: boolean }
interface Trend { months: TrendMonth[] }
interface Pkg { name: string; count: number; revenue: number; avg: number; share: number; prevRevenue: number; prevCount: number }
interface Recap {
  month: string; basis: 'BILLED' | 'COLLECTED';
  revenue: { total: number; bookingCount: number; addons: number };
  expenses: { total: number; byCategory: { id: string; name: string; amount: number; count: number }[] };
  netProfit: number; marginPct: number | null;
  packages: Pkg[]; topAddons: { name: string; bookings: number; revenue: number }[];
  expenseChange: { id: string; prevAmount: number }[];
  drafts: { count: number; amount: number };
  receivables: { items: unknown[]; total: number };
  previous: { month: string; revenue: number; expenses: number; netProfit: number; bookings: number; marginPct: number | null };
}

const INCOME = 'var(--color-chart-income)';
const EXPENSE = 'var(--color-chart-expense)';
const LOSS = 'var(--color-chart-loss)';
const pct = (v: number | null) => (v === null ? '—' : `${v.toString().replace('.', ',')}%`);

function readRange() {
  try { return Number(localStorage.getItem('jes-dash-range')) === 12 ? 12 : 6; } catch { return 6; }
}

/** Signed change; colour = direction × whether up is good, always with an arrow (never colour alone). */
function Delta({ now, before, upIsGood = true, format = formatRpCompact, label }: { now: number; before: number; upIsGood?: boolean; format?: (n: number) => string; label: string }) {
  const d = now - before;
  if (!before && !now) return <span className="text-xs text-muted">—</span>;
  if (d === 0) return <span className="text-xs text-muted">= {label}</span>;
  const good = d > 0 === upIsGood;
  return (
    <span className={cx('text-xs font-medium whitespace-nowrap', good ? 'text-ok' : 'text-bad')}>
      {d > 0 ? '▲' : '▼'} {format(Math.abs(d)).replace('−', '')} <span className="font-normal text-muted">{label}</span>
    </span>
  );
}

function Section({ title, sub, children, action }: { title: string; sub?: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <Card className="space-y-3">
      <div className="flex items-start gap-2">
        <div className="flex-1">
          <h2 className="font-semibold">{title}</h2>
          {sub ? <p className="text-xs text-muted">{sub}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </Card>
  );
}

/**
 * Ringkasan: one month, four questions — how did it go, how does it compare, which package performed best,
 * where did the money go. Everything follows the month switcher.
 */
export default function Dashboard() {
  const [month, setMonth] = useMonthParam();
  const [range, setRange] = useState(readRange);
  const current = wibMonth(new Date());
  // chart window ends this month, or later in the past so an old selected month stays inside it
  const windowStart = shiftMonth(current, -(range - 1));
  const end = month < windowStart ? shiftMonth(month, Math.min(range - 1, monthsBetween(month, current))) : current;

  const recap = useQuery({ queryKey: ['recap', month, ''], queryFn: () => api.get<Recap>(`/reports/recap?month=${month}`) });
  const trend = useQuery({ queryKey: ['trend', range, end], queryFn: () => api.get<Trend>(`/reports/trend?months=${range}&end=${end}`) });
  const pickRange = (n: number) => { setRange(n); try { localStorage.setItem('jes-dash-range', String(n)); } catch { /* private mode */ } };

  const r = recap.data;
  const t = trend.data;
  const sel = t?.months.find((m) => m.month === month);
  const prevLabel = shortMonthId(shiftMonth(month, -1));
  const finished = (t?.months ?? []).filter((m) => !m.partial && (m.bookings || m.expenses));
  const rank = sel && !sel.partial ? [...finished].sort((a, b) => b.net - a.net).findIndex((m) => m.month === month) + 1 : 0;
  const avg = finished.length ? Math.round(finished.reduce((a, m) => a + m.net, 0) / finished.length) : 0;
  const best = finished.length ? finished.reduce((a, m) => (m.net > a.net ? m : a)) : null;
  const empty = r && !r.revenue.bookingCount && !r.expenses.total;

  return (
    <>
      <FinanceHeader month={month} onMonth={setMonth} />
      <main className="mx-auto max-w-[480px] px-4 py-4 space-y-4 pb-28">
        {recap.isLoading || !r ? <Spinner /> : recap.isError ? <Banner tone="bad">{(recap.error as Error).message}</Banner> : (
          <>
            {/* 1 — How did this month go? */}
            <Link to={`/finance/recap?month=${month}`} className="block" aria-label={`Laporan ${monthLabelId(month)}`}>
              <Card className="space-y-4">
                <div className="text-center space-y-1">
                  <div className="hud text-muted">Laba bersih · {monthLabelId(month)}</div>
                  <div className={cx('font-display text-5xl font-semibold tracking-tight', r.netProfit < 0 ? 'text-bad' : 'text-ink')}>{formatRpCompact(r.netProfit)}</div>
                  <div className="text-sm text-muted">{r.netProfit < 0 ? `Rugi ${formatRp(-r.netProfit)}` : `margin ${pct(r.marginPct)}`}</div>
                  <Delta now={r.netProfit} before={r.previous.netProfit} label={`vs ${prevLabel}`} />
                </div>
                <div className="grid grid-cols-3 gap-2 border-t border-line pt-3 text-center">
                  <Figure label="Pendapatan" value={formatRpCompact(r.revenue.total)} delta={<Delta now={r.revenue.total} before={r.previous.revenue} label="" />} dot={INCOME} />
                  <Figure label="Pengeluaran" value={formatRpCompact(r.expenses.total)} delta={<Delta now={r.expenses.total} before={r.previous.expenses} upIsGood={false} label="" />} dot={EXPENSE} />
                  <Figure label="Booking" value={String(r.revenue.bookingCount)} delta={<Delta now={r.revenue.bookingCount} before={r.previous.bookings} format={String} label="" />} />
                </div>
                {sel?.partial ? (
                  <p className="text-xs text-muted text-center">Bulan berjalan: termasuk {sel.upcoming} sesi mendatang, dan biaya bulan ini masih bisa bertambah — bandingkan dengan hati-hati.</p>
                ) : null}
              </Card>
            </Link>

            {empty ? <Empty>Belum ada transaksi di {monthLabelId(month)}.</Empty> : null}

            {/* 2 — How does it compare with other months? */}
            <Section title="Dibanding bulan lain" sub="Laba bersih per bulan · ketuk bulan untuk melihatnya"
              action={
                <div className="flex rounded-full border border-line p-0.5 text-xs" role="group" aria-label="Rentang">
                  {[6, 12].map((n) => (
                    <button key={n} onClick={() => pickRange(n)} aria-pressed={range === n}
                      className={cx('rounded-full px-3 min-h-8', range === n ? 'bg-accent text-accent-ink' : 'text-muted')}>{n} bln</button>
                  ))}
                </div>
              }>
              {trend.isLoading || !t ? <Spinner /> : (
                <>
                  <ColumnChart height={180} ariaLabel="Laba bersih per bulan" onSelect={setMonth}
                    series={[{ name: 'Laba bersih', color: INCOME, negativeColor: LOSS }]}
                    reference={finished.length ? { value: avg, label: '' } : undefined}
                    labels={{ [month]: formatRpCompact(sel?.net ?? r.netProfit).replace('Rp', '') }}
                    rows={t.months.map((m) => ({
                      key: m.month, label: shortMonthId(m.month, m.month.endsWith('-01')), values: [m.net], muted: m.month !== month,
                      tooltip: <MonthTip m={m} />,
                    }))} />
                  <div className="grid grid-cols-3 gap-2 text-center text-sm">
                    <Stat label="Peringkat" value={sel?.partial ? 'berjalan' : rank ? `#${rank} / ${finished.length}` : '—'} />
                    <Stat label="Rata-rata" value={formatRpCompact(avg)} />
                    <Stat label="Terbaik" value={best ? `${shortMonthId(best.month)} · ${formatRpCompact(best.net).replace('Rp', '')}` : '—'} />
                  </div>
                  <p className="text-xs text-muted">Garis = rata-rata bulan yang sudah selesai. Kolom terang = bulan yang dipilih.</p>
                </>
              )}
            </Section>

            {/* 3 — Which package performed best? */}
            {r.packages.length ? (
              <Section title="Paket terbaik" sub={`Pendapatan per paket di ${monthLabelId(month)}, termasuk add-on`}>
                <ol className="space-y-3">
                  {r.packages.map((p, i) => (
                    <li key={p.name} className="space-y-1.5">
                      <div className="flex items-baseline gap-2">
                        <span className={cx('size-6 shrink-0 rounded-full grid place-items-center text-xs font-semibold', i === 0 ? 'bg-accent text-accent-ink' : 'bg-sunken text-muted')}>{i + 1}</span>
                        <span className="font-medium flex-1 truncate">{p.name}</span>
                        <span className="font-semibold tabular">{formatRpCompact(p.revenue)}</span>
                      </div>
                      <div className="ml-8 h-2" aria-hidden><div className="h-full rounded-r-[4px]" style={{ width: `${Math.max(2, p.share)}%`, background: INCOME }} /></div>
                      <div className="ml-8 flex flex-wrap justify-between gap-x-3 text-xs text-muted">
                        <span>{p.count} booking · rata-rata {formatRpCompact(p.avg)} · {pct(p.share)}</span>
                        <Delta now={p.revenue} before={p.prevRevenue} label={`vs ${prevLabel}`} />
                      </div>
                    </li>
                  ))}
                </ol>
                {r.topAddons.length ? (
                  <div className="border-t border-line pt-3 space-y-1.5">
                    <div className="hud text-muted">Add-on terlaris</div>
                    {r.topAddons.slice(0, 3).map((a) => (
                      <div key={a.name} className="flex justify-between gap-3 text-sm">
                        <span className="truncate">{a.name} <span className="text-muted">· {a.bookings} booking</span></span>
                        <span className="tabular">{formatRpCompact(a.revenue)}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </Section>
            ) : null}

            {/* 4 — Where did the money go? */}
            {r.expenses.byCategory.length ? (
              <Section title="Pengeluaran terbesar" sub={`Total ${formatRp(r.expenses.total)} · ketuk untuk melihat rinciannya`}>
                <ul className="space-y-1">
                  {foldOther(r.expenses.byCategory).map((c, i) => {
                    const prev = r.expenseChange.find((x) => x.id === c.id)?.prevAmount ?? 0;
                    const share = r.expenses.total ? Math.round((c.amount / r.expenses.total) * 100) : 0;
                    const row = (
                      <div className="space-y-1.5 py-1.5">
                        <div className="flex items-baseline gap-2">
                          <span className={cx('flex-1 truncate', i === 0 && 'font-semibold')}>{c.name}</span>
                          <span className={cx('tabular', i === 0 ? 'font-semibold' : 'font-medium')}>{formatRpCompact(c.amount)}</span>
                        </div>
                        <div className="h-2 rounded-r-[4px]" style={{ width: `${Math.max(2, share)}%`, background: EXPENSE }} aria-hidden />
                        <div className="flex justify-between text-xs text-muted">
                          <span>{share}% · {c.count} transaksi</span>
                          {c.id ? <Delta now={c.amount} before={prev} upIsGood={false} label={`vs ${prevLabel}`} /> : null}
                        </div>
                      </div>
                    );
                    return <li key={c.id || 'other'}>{c.id ? <Link to={`/finance/expenses?month=${month}&categoryId=${c.id}`} className="block active:opacity-70">{row}</Link> : row}</li>;
                  })}
                </ul>
              </Section>
            ) : null}

            {/* needs action — only when there is something to do */}
            {r.drafts.count || r.receivables.total ? (
              <Card className="space-y-2">
                <h2 className="font-semibold">Perlu tindakan</h2>
                {r.drafts.count ? (
                  <Link to={`/finance/expenses?month=${month}`} className="flex justify-between gap-3 text-sm min-h-11 items-center">
                    <span>{r.drafts.count} biaya draft belum dikonfirmasi <span className="text-muted">(belum masuk angka)</span></span>
                    <span className="tabular text-warn">{formatRpCompact(r.drafts.amount)} ›</span>
                  </Link>
                ) : null}
                {r.receivables.total ? (
                  <Link to={`/finance/recap?month=${month}#piutang`} className="flex justify-between gap-3 text-sm min-h-11 items-center">
                    <span>{r.receivables.items.length} booking belum lunas</span>
                    <span className="tabular text-accent-text">{formatRpCompact(r.receivables.total)} ›</span>
                  </Link>
                ) : null}
              </Card>
            ) : null}
          </>
        )}
      </main>
    </>
  );
}

function monthsBetween(a: string, b: string) {
  const [ya, ma] = a.split('-').map(Number), [yb, mb] = b.split('-').map(Number);
  return (yb - ya) * 12 + (mb - ma);
}

/** Top 5 categories; the rest fold into "Lainnya". */
function foldOther(cats: { id: string; name: string; amount: number; count: number }[]) {
  const rest = cats.slice(5);
  return rest.length
    ? [...cats.slice(0, 5), { id: '', name: 'Lainnya', amount: rest.reduce((a, c) => a + c.amount, 0), count: rest.reduce((a, c) => a + c.count, 0) }]
    : cats;
}

function Figure({ label, value, delta, dot }: { label: string; value: string; delta: React.ReactNode; dot?: string }) {
  return (
    <div className="space-y-0.5 min-w-0">
      <div className="text-xs text-muted flex items-center justify-center gap-1">{dot ? <span className="size-2 rounded-sm" style={{ background: dot }} aria-hidden /> : null}{label}</div>
      <div className="font-semibold tabular truncate">{value}</div>
      <div>{delta}</div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-sunken px-2 py-2">
      <div className="text-xs text-muted">{label}</div>
      <div className="font-semibold tabular truncate">{value}</div>
    </div>
  );
}

function MonthTip({ m }: { m: TrendMonth }) {
  return (
    <div className="space-y-1">
      <div className="font-semibold text-ink">{monthLabelId(m.month)}{m.partial ? ' · berjalan' : ''}</div>
      <div className="flex justify-between gap-4"><span className="text-muted">Pendapatan</span><span className="tabular text-ink">{formatRp(m.revenue)}</span></div>
      <div className="flex justify-between gap-4"><span className="text-muted">Pengeluaran</span><span className="tabular text-ink">{formatRp(m.expenses)}</span></div>
      <div className="flex justify-between gap-4 border-t border-line pt-1 font-medium">
        <span>{m.net < 0 ? 'Rugi' : 'Laba'}</span><span className={cx('tabular', m.net < 0 && 'text-bad')}>{formatRp(m.net)}</span>
      </div>
      <div className="text-muted">{m.bookings} booking</div>
    </div>
  );
}
