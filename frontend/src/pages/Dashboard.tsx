import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { formatRp, formatRpCompact, monthLabelId, shortMonthId } from '@jes/shared';
import { api } from '../api';
import { BarList, ColumnChart, Legend, Sparkline } from '../charts';
import { Banner, Card, Empty, Page, PageHeader, Spinner, cx } from '../ui';
import { FinanceTabs } from './Finance';

interface Month {
  month: string; bookings: number; upcoming: number; revenue: number; billed: number; collected: number; expenses: number; net: number;
  marginPct: number | null; receivable: number; drafts: number; partial: boolean; closed: boolean;
}
interface Trend {
  basis: 'BILLED' | 'COLLECTED'; start: string; end: string; months: Month[];
  window: {
    revenue: number; expenses: number; net: number; marginPct: number | null; bookings: number; avgNet: number; activeMonths: number;
    best: { month: string; net: number } | null; worst: { month: string; net: number } | null; lossMonths: number;
    revenueMix: { name: string; amount: number }[]; expenseCategories: { name: string; amount: number }[];
  };
  ytd: { year: string; revenue: number; expenses: number; net: number; marginPct: number | null; bookings: number; previousYear: { revenue: number; net: number } };
}

const INCOME = 'var(--color-chart-income)';
const EXPENSE = 'var(--color-chart-expense)';
const LOSS = 'var(--color-chart-loss)';

function readRange() {
  try { return Number(localStorage.getItem('jes-dash-range')) === 6 ? 6 : 12; } catch { return 12; }
}

/** Signed change vs the previous month; colour = direction × whether up is good, always with an arrow and words. */
function Delta({ value, upIsGood = true, format = formatRpCompact, vs }: { value: number | null; upIsGood?: boolean; format?: (n: number) => string; vs: string }) {
  if (value === null || !Number.isFinite(value)) return <span className="text-xs text-muted">— vs {vs}</span>;
  if (value === 0) return <span className="text-xs text-muted">= {vs}</span>;
  const good = value > 0 === upIsGood;
  return (
    <span className={cx('text-xs font-medium', good ? 'text-ok' : 'text-bad')}>
      {value > 0 ? '▲' : '▼'} {format(Math.abs(value)).replace('−', '')} <span className="font-normal text-muted">vs {vs}</span>
    </span>
  );
}

function StatTile({ label, value, delta, spark, color }: { label: string; value: string; delta: React.ReactNode; spark?: number[]; color?: string }) {
  return (
    <Card className="space-y-1 p-3">
      <div className="hud text-[10px] text-muted">{label}</div>
      <div className="font-display text-xl font-semibold tabular">{value}</div>
      <div>{delta}</div>
      {spark && color ? <Sparkline values={spark} color={color} /> : null}
    </Card>
  );
}

/** Owner dashboard: this month at a glance, income vs expenses and the net-profit trend (FR-23, FR-28). */
/** Two-option switch: one pill track, the chosen option lit. */
function Segmented<T extends string | number>({ label, value, onChange, options }: { label: string; value: T; onChange: (v: T) => void; options: [T, string][] }) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-full glass border border-line p-1">
      {options.map(([v, text]) => (
        <button key={String(v)} type="button" aria-pressed={value === v} onClick={() => onChange(v)}
          className={cx('min-h-10 rounded-full px-3.5 text-sm font-medium transition-colors', value === v ? 'bg-accent text-accent-ink shadow-[0_4px_14px_-4px_var(--color-glow)]' : 'text-muted')}>
          {text}
        </button>
      ))}
    </div>
  );
}

export default function Dashboard() {
  const [range, setRange] = useState(readRange);
  const [basis, setBasis] = useState<'' | 'BILLED' | 'COLLECTED'>('');
  const [table, setTable] = useState(false);
  const q = useQuery({
    queryKey: ['trend', range, basis],
    queryFn: () => api.get<Trend>(`/reports/trend?months=${range}${basis ? `&basis=${basis}` : ''}`),
  });
  const pickRange = (n: number) => { setRange(n); try { localStorage.setItem('jes-dash-range', String(n)); } catch { /* private mode */ } };

  const t = q.data;
  // headline = the last finished month; the running month is shown separately so a half month
  // (future sessions in, bills not yet paid) is never compared with a full one
  const running = t?.months.at(-1)?.partial ? t.months.at(-1) : undefined;
  const done = t?.months.filter((m) => !m.partial) ?? [];
  const cur = done.at(-1);
  const prev = done.at(-2);
  const hasData = !!t && t.months.some((m) => m.bookings || m.expenses);
  const effBasis = basis || t?.basis;
  const mLabel = (m: string) => shortMonthId(m, m.endsWith('-01') || m === t?.start);

  return (
    <>
      <PageHeader title="Keuangan" />
      <FinanceTabs />
      <Page className="pb-8">
        <div className="flex items-center justify-between gap-2">
          <Segmented label="Periode" value={range} onChange={pickRange} options={[[6, '6 bln'], [12, '12 bln']]} />
          <Segmented<'BILLED' | 'COLLECTED'> label="Dasar" value={effBasis === 'COLLECTED' ? 'COLLECTED' : 'BILLED'} onChange={setBasis} options={[['BILLED', 'Ditagih'], ['COLLECTED', 'Diterima']]} />
        </div>

        {q.isLoading || !t || !cur ? <Spinner /> : !hasData ? (
          <Empty>Belum ada transaksi dalam {range} bulan terakhir. Grafik muncul setelah booking dan pengeluaran tercatat.</Empty>
        ) : (
          <>
            {/* Hero: the one number this view leads with */}
            <Link to={`/finance/recap?month=${cur.month}`} className="block">
              <Card className="py-6 text-center space-y-1.5 border-line-strong shadow-[inset_0_1px_0_var(--color-hi),0_24px_60px_-28px_var(--color-glow)]">
                <div className="hud text-muted">Laba bersih · {monthLabelId(cur.month)}</div>
                <div className={cx('font-display text-5xl font-semibold tracking-tight tabular', cur.net < 0 ? 'text-bad' : 'text-ink')}>{formatRpCompact(cur.net)}</div>
                {cur.net < 0 ? <div className="text-sm text-bad font-medium">Rugi {formatRp(-cur.net)}</div> : <div className="text-sm text-muted">{formatRp(cur.net)}</div>}
                {prev ? <Delta value={cur.net - prev.net} vs={shortMonthId(prev.month)} /> : null}
              </Card>
            </Link>

            {running ? (
              <Link to={`/finance/recap?month=${running.month}`} className="block">
                <Card className="p-3 space-y-1">
                  <div className="flex justify-between text-sm">
                    <span className="font-medium flex items-center gap-2"><span className="size-2 rounded-full bg-accent-text pulse-dot" aria-hidden />{monthLabelId(running.month)} · berjalan</span>
                    <span className={cx('tabular font-semibold', running.net < 0 && 'text-bad')}>{formatRpCompact(running.net)}</span>
                  </div>
                  <div className="flex justify-between text-xs text-muted tabular">
                    <span>Pendapatan {formatRpCompact(running.revenue)} · Pengeluaran {formatRpCompact(running.expenses)}</span>
                    <span>{running.bookings} booking</span>
                  </div>
                  <p className="text-xs text-muted">Termasuk {running.upcoming} sesi mendatang; biaya bulan ini masih bisa bertambah.</p>
                </Card>
              </Link>
            ) : null}

            <div className="grid grid-cols-2 gap-3">
              <StatTile label="Pendapatan" value={formatRpCompact(cur.revenue)} color={INCOME} spark={done.map((m) => m.revenue)}
                delta={prev ? <Delta value={cur.revenue - prev.revenue} vs={shortMonthId(prev.month)} /> : null} />
              <StatTile label="Pengeluaran" value={formatRpCompact(cur.expenses)} color={EXPENSE} spark={done.map((m) => m.expenses)}
                delta={prev ? <Delta value={cur.expenses - prev.expenses} upIsGood={false} vs={shortMonthId(prev.month)} /> : null} />
              <StatTile label="Margin" value={cur.marginPct === null ? '—' : `${cur.marginPct.toString().replace('.', ',')}%`}
                delta={prev ? <Delta value={cur.marginPct !== null && prev.marginPct !== null ? Math.round((cur.marginPct - prev.marginPct) * 10) / 10 : null}
                  format={(n) => `${n.toString().replace('.', ',')} poin`} vs={shortMonthId(prev.month)} /> : null} />
              <StatTile label="Booking" value={String(cur.bookings)}
                delta={prev ? <Delta value={cur.bookings - prev.bookings} format={(n) => String(n)} vs={shortMonthId(prev.month)} /> : null} />
            </div>
            {t.months.some((m) => m.drafts) ? (
              <Banner tone="warn" action={<Link to="/finance/expenses" className="underline font-medium">Tinjau</Link>}>
                {t.months.reduce((a, m) => a + m.drafts, 0)} biaya draft belum dihitung dalam angka ini.
              </Banner>
            ) : null}

            {/* Income vs expenses per month */}
            <Card className="space-y-3">
              <div className="flex items-start gap-2">
                <div className="flex-1">
                  <h2 className="font-semibold">Pendapatan vs pengeluaran</h2>
                  <p className="text-xs text-muted">{monthLabelId(t.start)} – {monthLabelId(t.end)} · {effBasis === 'BILLED' ? 'ditagih' : 'diterima'}</p>
                </div>
                <button className="text-xs text-accent-text underline min-h-11 px-1" onClick={() => setTable(!table)}>{table ? 'Lihat grafik' : 'Lihat tabel'}</button>
              </div>
              <Legend items={[{ name: 'Pendapatan', color: INCOME }, { name: 'Pengeluaran', color: EXPENSE }]} />
              {table ? <MonthTable months={t.months} /> : (
                <ColumnChart height={210} ariaLabel={`Pendapatan dan pengeluaran per bulan, ${monthLabelId(t.start)} sampai ${monthLabelId(t.end)}`}
                  series={[{ name: 'Pendapatan', color: INCOME }, { name: 'Pengeluaran', color: EXPENSE }]}
                  rows={t.months.map((m) => ({
                    key: m.month, label: mLabel(m.month), values: [m.revenue, m.expenses], muted: m.partial,
                    tooltip: <MonthTip m={m} />,
                  }))} />
              )}
              {running ? <p className="text-xs text-muted">Kolom pudar = bulan berjalan.</p> : null}
            </Card>

            {/* Net profit trend */}
            <Card className="space-y-3">
              <div>
                <h2 className="font-semibold">Tren laba bersih</h2>
                <p className="text-xs text-muted">Garis = rata-rata {formatRpCompact(t.window.avgNet)} per bulan (bulan yang sudah selesai)</p>
              </div>
              <Legend items={[{ name: 'Laba', color: INCOME }, { name: 'Rugi', color: LOSS }]} />
              <ColumnChart height={190} ariaLabel="Laba bersih per bulan"
                series={[{ name: 'Laba bersih', color: INCOME, negativeColor: LOSS }]}
                reference={t.window.activeMonths ? { value: t.window.avgNet, label: '' } : undefined}
                labels={Object.fromEntries([t.window.best, t.window.worst].filter(Boolean).map((x) => [x!.month, formatRpCompact(x!.net).replace('Rp', '')]))}
                rows={t.months.map((m) => ({ key: m.month, label: mLabel(m.month), values: [m.net], muted: m.partial, tooltip: <MonthTip m={m} /> }))} />
            </Card>

            {/* Window summary */}
            <Card className="space-y-2">
              <h2 className="font-semibold">Ringkasan {range} bulan</h2>
              <Row label="Total pendapatan" value={formatRp(t.window.revenue)} />
              <Row label="Total pengeluaran" value={`−${formatRp(t.window.expenses)}`} />
              <Row label={`Laba bersih${t.window.marginPct !== null ? ` · margin ${t.window.marginPct.toString().replace('.', ',')}%` : ''}`} value={formatRp(t.window.net)} strong bad={t.window.net < 0} />
              <div className="border-t border-line pt-2 space-y-2">
                <Row label={`Rata-rata laba / bulan (${t.window.activeMonths} bulan selesai)`} value={formatRp(t.window.avgNet)} />
                {t.window.best ? <Row label="Bulan terbaik" value={`${monthLabelId(t.window.best.month)} · ${formatRpCompact(t.window.best.net)}`} /> : null}
                {t.window.worst ? <Row label="Bulan terlemah" value={`${monthLabelId(t.window.worst.month)} · ${formatRpCompact(t.window.worst.net)}`} bad={t.window.worst.net < 0} /> : null}
                <Row label="Bulan rugi" value={String(t.window.lossMonths)} bad={t.window.lossMonths > 0} />
                <Row label="Booking" value={String(t.window.bookings)} />
              </div>
            </Card>

            <Card className="space-y-2">
              <h2 className="font-semibold">Tahun {t.ytd.year} s.d. {monthLabelId(t.end).split(' ')[0]}</h2>
              <Row label="Pendapatan" value={formatRp(t.ytd.revenue)} />
              <Row label="Pengeluaran" value={`−${formatRp(t.ytd.expenses)}`} />
              <Row label={`Laba bersih${t.ytd.marginPct !== null ? ` · margin ${t.ytd.marginPct.toString().replace('.', ',')}%` : ''}`} value={formatRp(t.ytd.net)} strong bad={t.ytd.net < 0} />
              {t.ytd.previousYear.revenue > 0 ? (
                <div className="text-sm flex justify-between gap-3 pt-1">
                  <span className="text-muted">vs periode sama {Number(t.ytd.year) - 1}</span>
                  <Delta value={t.ytd.net - t.ytd.previousYear.net} vs={`laba ${formatRpCompact(t.ytd.previousYear.net)}`} />
                </div>
              ) : null}
            </Card>

            <Card className="space-y-3">
              <h2 className="font-semibold">Sumber pendapatan · {range} bulan</h2>
              <BarList color={INCOME} total={t.window.revenueMix.filter((x) => x.amount > 0).reduce((a, x) => a + x.amount, 0)}
                items={t.window.revenueMix.filter((x) => x.amount > 0).map((x) => ({ label: x.name, value: x.amount }))} />
              {t.window.revenueMix.some((x) => x.amount < 0) ? (
                <p className="text-xs text-muted">Diskon & penyesuaian: {formatRp(t.window.revenueMix.filter((x) => x.amount < 0).reduce((a, x) => a + x.amount, 0))}</p>
              ) : null}
              {effBasis === 'COLLECTED' ? <p className="text-xs text-muted">Komposisi berdasarkan nilai booking (ditagih).</p> : null}
            </Card>

            {t.window.expenseCategories.length ? (
              <Card className="space-y-3">
                <h2 className="font-semibold">Pengeluaran terbesar · {range} bulan</h2>
                <BarList color={EXPENSE} total={t.window.expenses} items={foldOther(t.window.expenseCategories)} />
              </Card>
            ) : null}
          </>
        )}
      </Page>
    </>
  );
}

/** Top 5 categories; the rest fold into "Lainnya" (never more hues/bars than the reader can use). */
function foldOther(cats: { name: string; amount: number }[]) {
  const top = cats.slice(0, 5).map((c) => ({ label: c.name, value: c.amount }));
  const rest = cats.slice(5).reduce((a, c) => a + c.amount, 0);
  return rest > 0 ? [...top, { label: 'Lainnya', value: rest }] : top;
}

function Row({ label, value, strong, bad }: { label: string; value: string; strong?: boolean; bad?: boolean }) {
  return (
    <div className={cx('flex justify-between gap-3 text-sm', strong && 'font-semibold text-base')}>
      <span className={cx(!strong && 'text-muted')}>{label}</span>
      <span className={cx('tabular text-right', bad && 'text-bad')}>{value}</span>
    </div>
  );
}

function MonthTip({ m }: { m: Month }) {
  return (
    <div className="space-y-1">
      <div className="font-semibold text-ink">{monthLabelId(m.month)}{m.partial ? ' · berjalan' : ''}</div>
      <TipRow color={INCOME} label="Pendapatan" value={formatRp(m.revenue)} />
      <TipRow color={EXPENSE} label="Pengeluaran" value={formatRp(m.expenses)} />
      <div className="flex justify-between gap-4 border-t border-line pt-1 font-medium">
        <span>{m.net < 0 ? 'Rugi' : 'Laba'}</span>
        <span className={cx('tabular', m.net < 0 && 'text-bad')}>{formatRp(m.net)}</span>
      </div>
      <div className="text-muted">{m.bookings} booking{m.marginPct !== null ? ` · margin ${m.marginPct.toString().replace('.', ',')}%` : ''}</div>
    </div>
  );
}

function TipRow({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="flex items-center gap-1.5 text-muted"><span className="size-2 rounded-sm" style={{ background: color }} />{label}</span>
      <span className="tabular text-ink">{value}</span>
    </div>
  );
}

/** Table view of the same numbers (accessibility; every month links to its recap). */
function MonthTable({ months }: { months: Month[] }) {
  return (
    <div className="-mx-4 overflow-x-auto">
      <table className="w-full text-xs tabular">
        <thead className="text-muted">
          <tr className="border-b border-line">
            <th className="text-left font-medium py-2 pl-4">Bulan</th>
            <th className="text-right font-medium">Pendapatan</th>
            <th className="text-right font-medium">Pengeluaran</th>
            <th className="text-right font-medium pr-4">Laba</th>
          </tr>
        </thead>
        <tbody>
          {[...months].reverse().map((m) => (
            <tr key={m.month} className="border-b border-line last:border-0">
              <td className="py-2 pl-4"><Link to={`/finance/recap?month=${m.month}`} className="text-accent-text">{shortMonthId(m.month, true)}</Link>{m.partial ? '*' : ''}</td>
              <td className="text-right">{formatRpCompact(m.revenue)}</td>
              <td className="text-right">{formatRpCompact(m.expenses)}</td>
              <td className={cx('text-right pr-4 font-medium', m.net < 0 && 'text-bad')}>{formatRpCompact(m.net)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
