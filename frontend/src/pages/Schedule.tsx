import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { dayNameId, fromMinutes, fromWib, longDateId, toMinutes, wibDate, wibParts, wibTime } from '@jes/shared';
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

  const sched = useQuery({
    queryKey: ['schedule', weekStart],
    queryFn: () => api.get<{ openHours: { open: string; close: string; closed: boolean }[]; slotStepMin: number; bookings: (BookingRow & { typeId: string; blockEndAt: string })[] }>(`/schedule?from=${weekStart}&to=${addDays(weekStart, 6)}`),
  });
  const cancelled = useQuery({
    queryKey: ['bookings', 'cancelled', day],
    queryFn: () => api.get<BookingRow[]>(`/bookings?status=CANCELLED&from=${day}&to=${day}`),
    enabled: showCancelled,
  });
  const setDay = (d: string) => setSp({ date: d }, { replace: true });

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
    gridEnd = Math.max(gridEnd, toMinutes(wibTime(b.startAt)) + b.hours * 60);
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
      <PageHeader title="Jadwal" action={<button className="text-accent-text text-sm font-semibold min-h-11 px-4 rounded-full glass border border-line-strong" onClick={() => setDay(today)}>Hari ini</button>} />
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
                    className={cx('absolute left-14 right-2 rounded-2xl border px-3 py-1.5 text-sm overflow-hidden backdrop-blur-sm', TYPE_TINT[typeIdx.get(b.typeId) ?? 0], b.status === 'COMPLETED' && 'opacity-70')}
                    style={{ top: ((s - gridStart) / 60) * HOUR_PX + 2, height: b.hours * HOUR_PX - 4 }}>
                    <div className="font-semibold truncate">{b.status === 'COMPLETED' ? '✓ ' : ''}{b.clientNameSnap}</div>
                    <div className="font-mono text-[11px] truncate text-muted">{wibTime(b.startAt)}–{wibTime(b.endAt)} · {b.typeNameSnap}{b.photographerNameSnap ? ` · ${b.photographerNameSnap}` : ''}</div>
                  </Link>
                );
              })}
            </div>
          </>
        )}
        <Toggle label="Tampilkan yang dibatalkan" checked={showCancelled} onChange={setShowCancelled} />
        {showCancelled ? (cancelled.data?.length ? cancelled.data.map((b) => <BookingCard key={b.id} b={b} />) : <Empty>Tidak ada booking dibatalkan.</Empty>) : null}
      </Page>
    </>
  );
}
