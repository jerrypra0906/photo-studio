import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { longDateId, wibTime } from '@jes/shared';
import { ApiError, api } from '../api';
import { Banner, Button, Card, Chip, Empty, Page, PageHeader, Spinner, useToast } from '../ui';

export interface InboxItem { id: string; eventId: string; summary: string; description: string | null; location: string | null; startAt: string; endAt: string; status: string }
interface InboxList { gcalStatus: string; gcalCalendarName: string | null; gcalPulledAt: string | null; gcalPullError: string | null; items: InboxItem[] }

export const useCalendarInbox = (status: 'PENDING' | 'IGNORED' = 'PENDING', enabled = true) => useQuery({
  queryKey: ['calendar-inbox', status],
  queryFn: () => api.get<InboxList>(`/calendar-inbox?status=${status}`),
  refetchInterval: 120_000,
  enabled,
});

const strip = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const durationLabel = (a: string, b: string) => {
  const m = Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000);
  return m % 60 ? `${Math.floor(m / 60) ? `${Math.floor(m / 60)} jam ` : ''}${m % 60} menit` : `${m / 60} jam`;
};

/** Events made directly in Google Calendar: turn each into a booking or ignore it (personal events share the calendar). */
export default function CalendarInbox() {
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState<'PENDING' | 'IGNORED'>('PENDING');
  const list = useCalendarInbox(tab);
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (id: string, what: 'ignore' | 'restore') => {
    setBusy(id);
    try {
      await api.post(`/calendar-inbox/${id}/${what}`);
      toast(what === 'ignore' ? 'Event diabaikan' : 'Event dikembalikan ke daftar');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Gagal — coba lagi');
    } finally {
      setBusy(null);
      qc.invalidateQueries({ queryKey: ['calendar-inbox'] });
    }
  };

  const pull = async () => {
    setBusy('pull');
    try {
      const r = await api.post<{ added: number }>('/calendar-inbox/pull');
      toast(r.added ? `${r.added} event baru dari Google Calendar` : 'Tidak ada event baru');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Gagal memeriksa kalender');
    } finally {
      setBusy(null);
      qc.invalidateQueries({ queryKey: ['calendar-inbox'] });
    }
  };

  const d = list.data;
  return (
    <>
      <PageHeader title="Dari Google Calendar" back />
      <Page>
        <p className="text-sm text-muted">
          Event yang dibuat langsung di Google Calendar{d?.gcalCalendarName ? ` (${d.gcalCalendarName})` : ''}. Jadikan booking, atau abaikan jika bukan sesi studio.
          Event seharian (ulang tahun, pengingat) tidak ditampilkan.
        </p>
        {d && d.gcalStatus !== 'CONNECTED' ? <Banner tone="bad">Google Calendar belum terhubung — event baru tidak bisa diambil.</Banner> : null}
        {d?.gcalPullError ? <Banner tone="warn">Pemeriksaan terakhir gagal. Coba “Periksa sekarang”.</Banner> : null}

        <div className="flex items-center gap-2">
          <Chip active={tab === 'PENDING'} onClick={() => setTab('PENDING')}>Menunggu</Chip>
          <Chip active={tab === 'IGNORED'} onClick={() => setTab('IGNORED')}>Diabaikan</Chip>
          <div className="flex-1" />
          <Button variant="secondary" className="!min-h-10 !px-3 text-sm" busy={busy === 'pull'} onClick={pull}>Periksa sekarang</Button>
        </div>
        {d?.gcalPulledAt ? <p className="font-mono text-[11px] text-muted -mt-2">Diperiksa {longDateId(d.gcalPulledAt)} {wibTime(d.gcalPulledAt)} · otomatis tiap 3 menit</p> : null}

        {list.isLoading ? <Spinner /> : !d?.items.length ? (
          <Empty>{tab === 'PENDING' ? 'Tidak ada event baru. Semua event di kalender sudah ada di aplikasi.' : 'Tidak ada event yang diabaikan.'}</Empty>
        ) : d.items.map((e) => (
          <Card key={e.id} className="space-y-3">
            <div>
              <div className="hud text-muted">{longDateId(e.startAt)}</div>
              <div className="text-lg font-semibold">{e.summary || 'Tanpa judul'}</div>
              <div className="font-mono text-sm text-muted">{wibTime(e.startAt)} – {wibTime(e.endAt)} WIB · {durationLabel(e.startAt, e.endAt)}</div>
              {e.description ? <p className="text-sm text-muted mt-1 line-clamp-3 whitespace-pre-line">{strip(e.description)}</p> : null}
            </div>
            {tab === 'PENDING' ? (
              <div className="grid grid-cols-2 gap-2">
                <Button variant="secondary" busy={busy === e.id} onClick={() => act(e.id, 'ignore')}>Abaikan</Button>
                <Link to={`/bookings/new?inbox=${e.id}`}><Button className="w-full">Jadikan booking</Button></Link>
              </div>
            ) : (
              <Button variant="secondary" busy={busy === e.id} onClick={() => act(e.id, 'restore')}>Kembalikan</Button>
            )}
          </Card>
        ))}
      </Page>
    </>
  );
}
