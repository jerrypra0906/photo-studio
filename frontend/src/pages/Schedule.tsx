import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { dayNameId, fromMinutes, fromWib, longDateId, monthLabelId, shiftMonth, toMinutes, wibDate, wibParts, wibTime } from '@jes/shared';
import { api } from '../api';
import { BookingCard, BookingRow } from '../BookingCard';
import { Empty, Page, PageHeader, Spinner, Toggle, cx } from '../ui';

const addDays = (ymd: string, n: number) => wibDate(new Date(fromWib(ymd, '12:00').getTime() + n * 86400_000));
const HOUR_PX = 64;
const TYPE_TINT = ['bg-accent-soft border-line-strong', 'bg-ok-soft border-ok/30', 'bg-info-soft border-info/30'];

/** S3 Schedule: week strip + day time grid; tap an empty slot to book it (US-05.2). */
export default function Schedule() {
  const [sp, setSp] = useSearchParams();
  const nav = useNavigate();
  const today = wibDate(new Date());
  const day = sp.get('date') ?? today;
  const dow = wibParts(fromWib(day, '12:00')).dow;
  const weekStart = addDays(day, -((dow + 6) % 7)); // Monday
  const week = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const [showCancelled, setShowCancelled] = useState(false);
  const view = sp.get('view') === 'month' ? 'month' : 'week';
  const month = day.slice(0, 7);
  const monthStart = `${month}-01`;
  const monthEnd = addDays(`${shiftMonth(month, 1)}-01`, -1);

  const sched = useQuery({
    queryKey: ['schedule', weekStart],
    queryFn: () => api.get<{ openHours: { open: string; close: string; closed: boolean }[]; slotStepMin: number; bookings: (BookingRow & { typeId: string; blockEndAt: string })[] }>(`/schedule?from=${weekStart}&to=${addDays(weekStart, 6)}`),
  });
  const cancelled = useQuery({
    queryKey: ['bookings', 'cancelled', day],
    queryFn: () => api.get<BookingRow[]>(`/bookings?status=CANCELLED&from=${day}&to=${day}`),
    enabled: showCancelled,
  });
  const setDay = (d: string, v: string = view) => setSp(v === 'month' ? { date: d, view: 'month' } : { date: d }, { replace: true });
  const monthSched = useQuery({
    queryKey: ['schedule', 'month', month],
    queryFn: () => api.get<{ bookings: (BookingRow & { typeId: string })[] }>(`/schedule?from=${monthStart}&to=${monthEnd}`),
    enabled: view === 'month',
  });

  const hours = sched.data?.openHours[dow];
  const dayBookings = (sched.data?.bookings ?? []).filter((b) => wibDate(b.startAt) === day);
  const counts = new Map<string, number>();
  for (const b of sched.data?.bookings ?? []) counts.set(wibDate(b.startAt), (counts.get(wibDate(b.startAt)) ?? 0) + 1);
  const typeIdx = new Map<string, number>();
  for (const b of sched.data?.bookings ?? []) if (!typeIdx.has(b.typeId)) typeIdx.set(b.typeId, typeIdx.size % TYPE_TINT.length);

  // grid spans opening hours, stretched to include any after-hours booking
  let gridStart = hours && !hours.closed ? toMinutes(hours.open) : 9 * 60;
  let gridEnd = hours && !hours.closed ? toMinutes(hours.close) : 21 * 60;
  for (const b of dayBookings) {
    gridStart = Math.min(gridStart, toMinutes(wibTime(b.startAt)));
    gridEnd = Math.max(gridEnd, toMinutes(wibTime(b.startAt)) + b.durationMin);
  }
  gridStart = Math.floor(gridStart / 60) * 60;
  gridEnd = Math.min(24 * 60, Math.ceil(gridEnd / 60) * 60);
  const step = sched.data?.slotStepMin ?? 30;
  const slots: number[] = [];
  for (let m = gridStart; m < gridEnd; m += step) slots.push(m);
  const busy = (m: number) => dayBookings.some((b) => {
    const s = toMinutes(wibTime(b.startAt));
    const e = s + (new Date(b.blockEndAt).getTime() - new Date(b.startAt).getTime()) / 60000;
    return m >= s && m < e;
  });
  const nowMin = toMinutes(wibTime(new Date()));
  const past = (m: number) => day < today || (day === today && m < toMinutes(wibTime(new Date())));

  return (
    <>
      <PageHeader title="Jadwal" action={
        <div className="flex items-center gap-2">
          <div className="flex rounded-full glass border border-line-strong p-0.5" role="group" aria-label="Tampilan">
            {(['week', 'month'] as const).map((v) => (
              <button key={v} aria-pressed={view === v} onClick={() => setDay(day, v)}
                className={cx('min-h-10 px-3 rounded-full text-sm font-semibold', view === v ? 'bg-accent text-accent-ink' : 'text-muted')}>{v === 'week' ? 'Minggu' : 'Bulan'}</button>
            ))}
          </div>
          <button className="text-accent-text text-sm font-semibold min-h-11 px-3 rounded-full glass border border-line-strong" onClick={() => setDay(today)}>Hari ini</button>
        </div>
      } />
      {view === 'month' ? <MonthView day={day} today={today} month={month} bookings={monthSched.data?.bookings} loading={monthSched.isLoading} setDay={setDay} /> : (<>
      <div className="sticky top-16 z-10 bg-bg/70 backdrop-blur-xl border-b border-line">
        <div className="mx-auto max-w-[480px] px-2 py-2 flex items-center gap-1">
          <button className="size-11 grid place-items-center rounded-full text-muted active:bg-accent-soft" aria-label="Minggu sebelumnya" onClick={() => setDay(addDays(day, -7))}>‹</button>
          <div className="flex-1 grid grid-cols-7 gap-1">
            {week.map((d) => {
              const p = wibParts(fromWib(d, '12:00'));
              const n = counts.get(d) ?? 0;
              return (
                <button key={d} onClick={() => setDay(d)} aria-pressed={d === day} aria-label={longDateId(fromWib(d, '12:00'))}
                  className={cx('rounded-[18px] py-1.5 flex flex-col items-center min-h-16 border transition-colors', d === day ? 'bg-accent text-accent-ink border-transparent shadow-[0_8px_22px_-8px_var(--color-glow)]' : d === today ? 'bg-accent-soft border-line-strong' : 'border-transparent active:bg-accent-soft')}>
                  <span className="font-mono text-[10px] tracking-wider uppercase opacity-85">{dayNameId(p.dow).slice(0, 3)}</span>
                  <span className="font-display text-lg font-semibold tabular">{p.d}</span>
                  <span className={cx('size-1.5 rounded-full', n ? (d === day ? 'bg-accent-ink' : 'bg-accent-text') : 'bg-transparent')} />
                </button>
              );
            })}
          </div>
          <button className="size-11 grid place-items-center rounded-full text-muted active:bg-accent-soft" aria-label="Minggu berikutnya" onClick={() => setDay(addDays(day, 7))}>›</button>
        </div>
      </div>
      <Page>
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">{longDateId(fromWib(day, '12:00'))}</h2>
          {hours ? <span className="font-mono text-[11px] text-muted rounded-full border border-line px-2.5 py-1">{hours.closed ? 'TUTUP' : `${hours.open}–${hours.close}`}</span> : null}
        </div>
        {sched.isLoading ? <Spinner /> : (
          <>
            {dayBookings.length === 0 ? <p className="text-sm text-muted">Belum ada booking — ketuk slot untuk menambah.</p> : null}
            <div className="relative rounded-3xl border border-line glass overflow-hidden" style={{ height: ((gridEnd - gridStart) / 60) * HOUR_PX }}>
              {slots.map((m) => (
                <button key={m} disabled={busy(m) || past(m)} aria-label={`Booking ${fromMinutes(m)}`}
                  onClick={() => nav(`/bookings/new?date=${day}&time=${fromMinutes(m)}`)}
                  className={cx('absolute inset-x-0 flex items-start pl-14 text-left', m % 60 === 0 ? 'border-t border-line' : 'border-t border-dashed border-line/60', !busy(m) && !past(m) && 'active:bg-accent-soft hover:bg-accent-soft/50', past(m) && 'bg-sunken/50')}
                  style={{ top: ((m - gridStart) / 60) * HOUR_PX, height: (step / 60) * HOUR_PX }}>
                  {m % 60 === 0 ? <span className="absolute left-3 top-0 font-mono text-[10px] text-muted pt-1">{fromMinutes(m)}</span> : null}
                </button>
              ))}
              {day === today && nowMin >= gridStart && nowMin < gridEnd ? (
                <div aria-hidden className="pointer-events-none absolute left-11 right-0 z-10" style={{ top: ((nowMin - gridStart) / 60) * HOUR_PX }}>
                  <div className="h-0.5 bg-accent-text shadow-[0_0_14px_var(--color-glow)]" />
                  <div className="absolute -left-1 -top-1 size-2.5 rounded-full bg-accent-text pulse-dot" />
                </div>
              ) : null}
              {dayBookings.map((b) => {
                const s = toMinutes(wibTime(b.startAt));
                return (
                  <Link key={b.id} to={`/bookings/${b.id}`}
                    className={cx('absolute left-14 right-2 rounded-2xl border px-3 py-1.5 text-sm overflow-hidden backdrop-blur-sm', b.needsPhotographer ? 'bg-warn-soft border-warn/60' : TYPE_TINT[typeIdx.get(b.typeId) ?? 0], b.status === 'COMPLETED' && 'opacity-70')}
                    style={{ top: ((s - gridStart) / 60) * HOUR_PX + 2, height: Math.max(28, (b.durationMin / 60) * HOUR_PX - 4) }}>
                    <div className="font-semibold truncate">{b.status === 'COMPLETED' ? '✓ ' : ''}{b.clientNameSnap}</div>
                    <div className="font-mono text-[11px] truncate text-muted">{wibTime(b.startAt)}–{wibTime(b.endAt)} · {b.typeNameSnap}{b.photographerNameSnap ? ` · ${b.photographerNameSnap}` : b.needsPhotographer ? ' · 📷 belum ada fotografer' : ''}</div>
                  </Link>
                );
              })}
            </div>
          </>
        )}
        <Toggle label="Tampilkan yang dibatalkan" checked={showCancelled} onChange={setShowCancelled} />
        {showCancelled ? (cancelled.data?.length ? cancelled.data.map((b) => <BookingCard key={b.id} b={b} />) : <Empty>Tidak ada booking dibatalkan.</Empty>) : null}
      </Page>
      </>)}
    </>
  );
}

const DOW_SHORT = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'];

/** Month calendar: a dot under each date that has bookings (warning colour if one still needs a photographer); tap a date for its list. */
function MonthView({ day, today, month, bookings, loading, setDay }: {
  day: string; today: string; month: string; bookings?: BookingRow[]; loading: boolean; setDay: (d: string, v?: string) => void;
}) {
  const first = `${month}-01`;
  const lead = (wibParts(fromWib(first, '12:00')).dow + 6) % 7; // Monday-first
  const daysInMonth = Number(addDays(`${shiftMonth(month, 1)}-01`, -1).slice(8));
  const cells: (string | null)[] = [...Array(lead).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)];
  while (cells.length % 7) cells.push(null);
  const byDay = new Map<string, BookingRow[]>();
  for (const b of bookings ?? []) { const d = wibDate(b.startAt); byDay.set(d, [...(byDay.get(d) ?? []), b]); }
  const selected = day.startsWith(month) ? byDay.get(day) ?? [] : [];
  const total = bookings?.length ?? 0;
  return (
    <Page>
      <div className="flex items-center gap-1">
        <button className="size-11 grid place-items-center rounded-full text-muted active:bg-accent-soft" aria-label="Bulan sebelumnya" onClick={() => setDay(`${shiftMonth(month, -1)}-01`)}>‹</button>
        <h2 className="flex-1 text-center font-semibold">{monthLabelId(month)} <span className="font-mono text-xs text-muted font-normal">· {loading ? '–' : total} booking</span></h2>
        <button className="size-11 grid place-items-center rounded-full text-muted active:bg-accent-soft" aria-label="Bulan berikutnya" onClick={() => setDay(`${shiftMonth(month, 1)}-01`)}>›</button>
      </div>
      <div className="rounded-3xl glass border border-line p-2">
        <div className="grid grid-cols-7 mb-1">
          {DOW_SHORT.map((d) => <div key={d} className="text-center font-mono text-[10px] uppercase tracking-wider text-muted py-1">{d}</div>)}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {cells.map((d, i) => {
            if (!d) return <div key={`x${i}`} />;
            const list = byDay.get(d) ?? [];
            const isSel = d === day;
            return (
              <button key={d} onClick={() => setDay(d)} aria-pressed={isSel}
                aria-label={`${longDateId(fromWib(d, '12:00'))}${list.length ? `, ${list.length} booking` : ''}`}
                className={cx('rounded-2xl min-h-12 flex flex-col items-center justify-center gap-1 border transition-colors',
                  isSel ? 'bg-accent text-accent-ink border-transparent shadow-[0_8px_22px_-8px_var(--color-glow)]' : d === today ? 'bg-accent-soft border-line-strong' : 'border-transparent active:bg-accent-soft',
                  d < today && !isSel && 'opacity-60')}>
                <span className="font-display text-[15px] font-semibold tabular leading-none">{Number(d.slice(8))}</span>
                <span className="flex gap-0.5 h-1.5" aria-hidden>
                  {list.slice(0, 3).map((b) => (
                    <span key={b.id} className={cx('size-1.5 rounded-full', isSel ? 'bg-accent-ink' : b.needsPhotographer ? 'bg-bad' : 'bg-accent-text')} />
                  ))}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <p className="flex items-center gap-3 text-xs text-muted">
        <span className="flex items-center gap-1"><span className="size-1.5 rounded-full bg-accent-text" />booking</span>
        <span className="flex items-center gap-1"><span className="size-1.5 rounded-full bg-bad" />belum ada fotografer</span>
      </p>
      {day.startsWith(month) ? (
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">{longDateId(fromWib(day, '12:00'))}</h3>
            <button className="text-sm font-semibold text-accent-text min-h-11" onClick={() => setDay(day, 'week')}>Lihat per jam →</button>
          </div>
          {loading ? <Spinner /> : selected.length ? selected.map((b) => <BookingCard key={b.id} b={b} />) : (
            <Empty action={day >= today ? <Link to={`/bookings/new?date=${day}`} className="text-accent-text font-semibold">+ Booking di tanggal ini</Link> : null}>Tidak ada booking.</Empty>
          )}
        </section>
      ) : null}
    </Page>
  );
}
