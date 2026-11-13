import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { durationLabel, longDateId, wibDate, wibTime, fromWib } from '@jes/shared';
import { api } from '../api';
import { useAuth, useIsOwner } from '../App';
import { BookingCard, BookingRow, useNeedsPhotographer } from '../BookingCard';
import { useSettings } from '../hooks';
import { useCalendarInbox } from './CalendarInbox';
import { Banner, Button, Empty, Logo, Page, PayBadge, Spinner, cx } from '../ui';

const addDays = (ymd: string, n: number) => wibDate(new Date(fromWib(ymd).getTime() + n * 86400_000));

/** "25 menit lagi" / "2 jam 10 menit lagi" / "sedang berlangsung" */
function untilLabel(mins: number) {
  if (mins <= 0) return 'Sedang berlangsung';
  if (mins < 60) return `${mins} menit lagi`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${h} jam${m ? ` ${m} menit` : ''} lagi`;
}

/** Re-render every minute so the countdown stays current. */
function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const h = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(h); }, []);
  return now;
}

function Stat({ label, value, to, tone }: { label: string; value: number | string; to?: string; tone?: 'bad' }) {
  const body = (
    <>
      <span className="hud text-[10px]">{label}</span>
      <span className="font-display text-[26px] font-semibold tabular leading-tight">{typeof value === 'number' ? String(value).padStart(2, '0') : value}</span>
    </>
  );
  const cls = cx('rounded-[20px] border px-3.5 py-3 flex flex-col gap-1', tone === 'bad' ? 'bg-bad-soft border-bad/30 text-bad' : 'glass border-line text-muted [&>span:last-child]:text-ink');
  return to ? <Link to={to} className={cls}>{body}</Link> : <div className={cls}>{body}</div>;
}

/** The next (or running) session, shown big so it is the first thing seen. */
function NextUp({ b, now }: { b: BookingRow; now: number }) {
  const mins = Math.round((new Date(b.startAt).getTime() - now) / 60000);
  // 12 segments over the last two hours before the session
  const filled = mins <= 0 ? 12 : Math.max(0, 12 - Math.ceil(mins / 10));
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2.5">
        <span className="size-2 rounded-full bg-accent-text pulse-dot" aria-hidden />
        <h2 className="hud font-mono font-semibold text-accent-text">Berikutnya · {untilLabel(mins)}</h2>
      </div>
      <div className="rounded-[28px] glass border border-line-strong p-5 space-y-[18px] shadow-[inset_0_1px_0_var(--color-hi),0_24px_60px_-24px_var(--color-glow)]">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1.5">
            <div className="font-display text-5xl font-semibold tracking-tight leading-none tabular">{wibTime(b.startAt)}</div>
            <div className="font-mono text-xs text-muted">→ {wibTime(b.endAt)} · {durationLabel(b.durationMin ?? b.hours * 60).toUpperCase()}</div>
          </div>
          <PayBadge total={b.total} paid={b.paidAmount} />
        </div>
        {mins < 120 ? (
          <div className="grid grid-cols-12 gap-1" aria-hidden>
            {Array.from({ length: 12 }, (_, i) => (
              <span key={i} className={cx('h-1 rounded-full', i < filled ? 'bg-accent-text' : 'bg-line')} style={i < filled ? { opacity: 0.4 + (i / 12) * 0.6 } : undefined} />
            ))}
          </div>
        ) : null}
        <div>
          <div className="text-lg font-semibold">{b.clientNameSnap}</div>
          <div className="text-sm text-muted">{b.typeNameSnap}{b.photographerNameSnap ? ` · Fotografer: ${b.photographerNameSnap}` : ''}</div>
        </div>
        <Link to={`/bookings/${b.id}`} className="flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-accent font-semibold text-accent-ink shadow-[0_8px_24px_-8px_var(--color-glow)] active:scale-[0.98] transition-transform">
          Buka detail
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12h14M13 6l6 6-6 6" /></svg>
        </Link>
      </div>
    </section>
  );
}

/** S2 Home: next session, today, "To close", next 7 days (L2-1.2.1). */
export default function Home() {
  const { user } = useAuth();
  const owner = useIsOwner();
  const now = useNow();
  const today = wibDate(new Date(now));
  const settings = useSettings();
  const upcoming = useQuery({
    queryKey: ['bookings', 'home', today],
    queryFn: () => api.get<BookingRow[]>(`/bookings?from=${today}&to=${addDays(today, 7)}`),
    refetchInterval: 60_000,
  });
  // closing a session records payment, which is Owner-only
  // in-app alert: upcoming sessions without a photographer yet
  const needPh = useNeedsPhotographer();
  const toClose = useQuery({ queryKey: ['bookings', 'to-close'], queryFn: () => api.get<BookingRow[]>('/bookings?toClose=true'), enabled: owner });
  const [tipHidden, setTipHidden] = useState(() => localStorage.getItem('jes-gcal-tip') === '1');

  const active = (upcoming.data ?? []).filter((b) => b.status !== 'CANCELLED');
  const byDay = new Map<string, BookingRow[]>();
  for (const b of upcoming.data ?? []) {
    const d = wibDate(b.startAt);
    byDay.set(d, [...(byDay.get(d) ?? []), b]);
  }
  const todays = byDay.get(today) ?? [];
  byDay.delete(today);
  const next = active.find((b) => new Date(b.endAt).getTime() > now && b.status === 'CONFIRMED');
  const todayCount = active.filter((b) => wibDate(b.startAt) === today).length;
  const gcal = settings.data?.gcalStatus;
  const inbox = useCalendarInbox('PENDING', gcal === 'CONNECTED');
  const inboxCount = inbox.data?.items.length ?? 0;

  return (
    <>
      <header className="mx-auto max-w-[480px] px-4 pt-8 pb-2 space-y-6">
        <div className="flex items-center justify-between">
          <Logo className="h-8" />
          {owner && gcal ? (
            <span className="flex items-center gap-1.5 rounded-full glass border border-line px-2.5 py-1.5 font-mono text-[11px] text-muted">
              <span className={cx('size-1.5 rounded-full', gcal === 'CONNECTED' ? 'bg-ok' : gcal === 'RECONNECT_NEEDED' ? 'bg-bad' : 'bg-line-strong')} aria-hidden />
              GCAL
            </span>
          ) : null}
        </div>
        <div className="space-y-2">
          <p className="hud text-muted">{longDateId(new Date(now))}</p>
          <h1 className="text-[38px] leading-[1.05] font-semibold tracking-tight">Halo, {user?.name}</h1>
        </div>
      </header>
      <Page className="!space-y-6">
        {owner && gcal === 'RECONNECT_NEEDED' ? (
          <Banner tone="bad" action={<Link to="/admin/integrations" className="font-semibold underline">Hubungkan</Link>}>
            Google Calendar perlu dihubungkan ulang. Booking tetap tersimpan dan akan disinkron setelahnya.
          </Banner>
        ) : null}
        {owner && gcal === 'NOT_CONNECTED' && !tipHidden ? (
          <Banner tone="info" action={<button className="text-sm min-h-11 px-1" onClick={() => { localStorage.setItem('jes-gcal-tip', '1'); setTipHidden(true); }}>Tutup</button>}>
            Tip: <Link to="/admin/integrations" className="underline font-medium">hubungkan Google Calendar</Link> agar setiap booking muncul otomatis di kalender studio.
          </Banner>
        ) : null}

        {needPh.data?.length ? (
          <Banner tone="warn" action={<Link to="/bookings?needsPhotographer=true" className="font-semibold underline min-h-11 flex items-center">Lihat</Link>}>
            📷 {needPh.data.length} booking belum ada fotografer — terdekat {needPh.data[0].clientNameSnap}, {longDateId(needPh.data[0].startAt)} {wibTime(needPh.data[0].startAt)}.
          </Banner>
        ) : null}
        {inboxCount ? (
          <Banner tone="info" action={<Link to="/calendar-inbox" className="font-semibold underline min-h-11 flex items-center">Tinjau</Link>}>
            {inboxCount} event baru di Google Calendar belum ada di aplikasi.
          </Banner>
        ) : null}

        <div className="grid grid-cols-3 gap-2">
          <Stat label="Hari ini" value={upcoming.isLoading ? '–' : todayCount} />
          <Stat label="7 hari" value={upcoming.isLoading ? '–' : active.length} />
          {owner ? <Stat label="Tutup" value={toClose.data?.length ?? '–'} to={toClose.data?.length ? '/bookings?toClose=true' : undefined} tone={toClose.data?.length ? 'bad' : undefined} />
            : <Stat label="Belum lunas" value={active.filter((b) => b.balance > 0).length} />}
        </div>

        {next ? <NextUp b={next} now={now} /> : null}

        <section className="space-y-2.5">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold">Hari ini</h2>
            <Link to="/schedule" className="min-h-11 flex items-center text-sm font-semibold text-accent-text">Lihat jadwal →</Link>
          </div>
          {upcoming.isLoading ? <Spinner /> : todays.length ? todays.map((b) => <BookingCard key={b.id} b={b} />) : (
            <Empty action={<Link to={`/bookings/new?date=${today}`}><Button variant="secondary">+ Booking hari ini</Button></Link>}>Tidak ada booking — ketuk untuk menambah</Empty>
          )}
        </section>

        {toClose.data?.length ? (
          <section className="space-y-2.5">
            <h2 className="text-xl font-semibold">Perlu ditutup <span className="font-mono text-sm text-muted font-normal">({toClose.data.length})</span></h2>
            <p className="text-sm text-muted -mt-1">Sesi sudah lewat — tandai selesai dan status pembayaran.</p>
            {toClose.data.slice(0, 5).map((b) => <BookingCard key={b.id} b={b} showDate />)}
            {toClose.data.length > 5 ? <Link to="/bookings?toClose=true" className="block text-center text-accent-text text-sm py-2 min-h-11">Lihat semua</Link> : null}
          </section>
        ) : null}

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">7 hari ke depan</h2>
          {upcoming.isLoading ? null : byDay.size === 0 ? <Empty>Belum ada booking minggu ini.</Empty> : [...byDay.entries()].map(([d, list]) => (
            <div key={d} className="space-y-2">
              <h3 className="hud text-muted">{longDateId(fromWib(d, '12:00'))}</h3>
              {list.map((b) => <BookingCard key={b.id} b={b} />)}
            </div>
          ))}
        </section>
        <Link to="/bookings" className="block text-center text-accent-text text-sm py-2">Cari semua booking</Link>
      </Page>
    </>
  );
}
