import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { fromWib, monthLabelId, shiftMonth, wibDate, wibMonth } from '@jes/shared';
import { api } from '../api';
import { BookingCard, BookingRow } from '../BookingCard';
import { useTypes } from '../hooks';
import { Chip, Empty, Input, Page, PageHeader, Spinner } from '../ui';

const STATUSES: [string, string][] = [['', 'Aktif'], ['CONFIRMED', 'Terkonfirmasi'], ['COMPLETED', 'Selesai'], ['CANCELLED', 'Dibatalkan']];

/** S4 Booking list / search (L2-1.2.3): name, phone or number; filter by type, status, month. */
export default function Bookings() {
  const [sp, setSp] = useSearchParams();
  const [q, setQ] = useState(sp.get('q') ?? '');
  const [debounced, setDebounced] = useState(q);
  const status = sp.get('status') ?? '';
  const typeId = sp.get('typeId') ?? '';
  const month = sp.get('month') ?? '';
  const toClose = sp.get('toClose') === 'true';
  const types = useTypes();

  useEffect(() => {
    const h = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(h);
  }, [q]);

  const params = new URLSearchParams();
  if (debounced) params.set('q', debounced);
  if (status) params.set('status', status);
  if (typeId) params.set('typeId', typeId);
  if (toClose) params.set('toClose', 'true');
  if (month) {
    params.set('from', `${month}-01`);
    params.set('to', wibDate(new Date(fromWib(`${shiftMonth(month, 1)}-01`).getTime() - 86400_000)));
  }
  const list = useQuery({ queryKey: ['bookings', 'list', params.toString()], queryFn: () => api.get<BookingRow[]>(`/bookings?${params}`) });
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n, { replace: true }); };
  const thisMonth = wibMonth(new Date());

  return (
    <>
      <PageHeader title={toClose ? 'Perlu ditutup' : 'Booking'} back={toClose ? '/' : undefined} />
      <Page>
        <Input type="search" placeholder="Cari nama, nomor HP, atau no. booking" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Cari booking" />
        <div className="flex gap-2 overflow-x-auto -mx-4 px-4 pb-1">
          {STATUSES.map(([v, l]) => <Chip key={v} active={status === v} onClick={() => set('status', v)}>{l}</Chip>)}
        </div>
        <div className="flex gap-2 overflow-x-auto -mx-4 px-4 pb-1">
          <Chip active={!typeId} onClick={() => set('typeId', '')}>Semua jenis</Chip>
          {types.data?.map((t) => <Chip key={t.id} active={typeId === t.id} onClick={() => set('typeId', t.id)}>{t.name}</Chip>)}
        </div>
        <div className="flex gap-2 overflow-x-auto -mx-4 px-4 pb-1">
          <Chip active={!month} onClick={() => set('month', '')}>Semua bulan</Chip>
          {[1, 0, -1, -2].map((d) => { const m = shiftMonth(thisMonth, d); return <Chip key={m} active={month === m} onClick={() => set('month', m)}>{monthLabelId(m)}</Chip>; })}
        </div>
        {list.isLoading ? <Spinner /> : list.data?.length ? (
          <div className="space-y-2">
            <p className="text-sm text-muted">{list.data.length} booking</p>
            {list.data.map((b) => <BookingCard key={b.id} b={b} showDate />)}
          </div>
        ) : <Empty>Tidak ada booking yang cocok.</Empty>}
      </Page>
    </>
  );
}
