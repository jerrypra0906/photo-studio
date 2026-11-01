import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { longDateId, wibDate, fromWib } from '@jes/shared';
import { api } from '../api';
import { useAuth, useIsOwner } from '../App';
import { BookingCard, BookingRow } from '../BookingCard';
import { useSettings } from '../hooks';
import { Banner, Button, Empty, Logo, Page, Spinner } from '../ui';

const addDays = (ymd: string, n: number) => wibDate(new Date(fromWib(ymd).getTime() + n * 86400_000));

/** S2 Home: today, "To close", next 7 days (L2-1.2.1). */
export default function Home() {
  const { user } = useAuth();
  const owner = useIsOwner();
  const today = wibDate(new Date());
  const settings = useSettings();
  const upcoming = useQuery({
    queryKey: ['bookings', 'home', today],
    queryFn: () => api.get<BookingRow[]>(`/bookings?from=${today}&to=${addDays(today, 7)}`),
    refetchInterval: 60_000,
  });
  const toClose = useQuery({ queryKey: ['bookings', 'to-close'], queryFn: () => api.get<BookingRow[]>('/bookings?toClose=true') });
  const [tipHidden, setTipHidden] = useState(() => localStorage.getItem('jes-gcal-tip') === '1');

  const byDay = new Map<string, BookingRow[]>();
  for (const b of upcoming.data ?? []) {
    const d = wibDate(b.startAt);
    byDay.set(d, [...(byDay.get(d) ?? []), b]);
  }
  const todays = byDay.get(today) ?? [];
  byDay.delete(today);
  const gcal = settings.data?.gcalStatus;

  return (
    <>
      <header className="mx-auto max-w-[480px] px-4 pt-6 pb-2">
        <Logo className="h-9 mb-4" />
        <p className="text-muted text-sm">{longDateId(new Date())}</p>
        <h1 className="text-2xl font-semibold">Halo, {user?.name}</h1>
      </header>
      <Page>
        {owner && gcal === 'RECONNECT_NEEDED' ? (
          <Banner tone="bad" action={<Link to="/admin/integrations" className="font-semibold underline">Hubungkan</Link>}>
            Google Calendar perlu dihubungkan ulang. Booking tetap tersimpan dan akan disinkron setelahnya.
          </Banner>
        ) : null}
        {owner && gcal === 'NOT_CONNECTED' && !tipHidden ? (
          <Banner tone="info" action={<button className="text-sm" onClick={() => { localStorage.setItem('jes-gcal-tip', '1'); setTipHidden(true); }}>Tutup</button>}>
            Tip: <Link to="/admin/integrations" className="underline font-medium">hubungkan Google Calendar</Link> agar setiap booking muncul otomatis di kalender studio.
          </Banner>
        ) : null}

        {toClose.data?.length ? (
          <section className="space-y-2">
            <h2 className="font-semibold">Perlu ditutup <span className="text-muted font-normal">({toClose.data.length})</span></h2>
            <p className="text-sm text-muted -mt-1">Sesi sudah lewat — tandai selesai dan status pembayaran.</p>
            {toClose.data.slice(0, 5).map((b) => <BookingCard key={b.id} b={b} showDate />)}
            {toClose.data.length > 5 ? <Link to="/bookings?toClose=true" className="block text-center text-accent text-sm py-2">Lihat semua</Link> : null}
          </section>
        ) : null}

        <section className="space-y-2">
          <h2 className="font-semibold">Hari ini</h2>
          {upcoming.isLoading ? <Spinner /> : todays.length ? todays.map((b) => <BookingCard key={b.id} b={b} />) : (
            <Empty action={<Link to={`/bookings/new?date=${today}`}><Button variant="secondary">+ Booking hari ini</Button></Link>}>Tidak ada booking — ketuk untuk menambah</Empty>
          )}
        </section>

        <section className="space-y-3">
          <h2 className="font-semibold">7 hari ke depan</h2>
          {upcoming.isLoading ? null : byDay.size === 0 ? <Empty>Belum ada booking minggu ini.</Empty> : [...byDay.entries()].map(([d, list]) => (
            <div key={d} className="space-y-2">
              <h3 className="text-sm text-muted font-medium">{longDateId(fromWib(d, '12:00'))}</h3>
              {list.map((b) => <BookingCard key={b.id} b={b} />)}
            </div>
          ))}
        </section>
        <Link to="/bookings" className="block text-center text-accent text-sm py-2">Cari semua booking</Link>
      </Page>
    </>
  );
}
