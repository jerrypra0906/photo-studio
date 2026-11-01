import { Link } from 'react-router';
import { shortDateId, wibTime } from '@jes/shared';
import { Money, PayBadge, StatusBadge, cx } from './ui';

export interface BookingRow {
  id: string; bookingNo: string; status: string; typeNameSnap: string; clientNameSnap: string; photographerNameSnap: string | null;
  startAt: string; endAt: string; hours: number; total: number; paidAmount: number; balance: number; gcalSyncStatus: string; backDated?: boolean;
}

export function SyncDot({ status }: { status: string }) {
  if (status === 'NONE') return null;
  const c = { SYNCED: 'bg-ok', PENDING: 'bg-warn animate-pulse', FAILED: 'bg-bad' }[status] ?? 'bg-line';
  const l = { SYNCED: 'Tersinkron ke Google Calendar', PENDING: 'Menunggu sinkron', FAILED: 'Kalender belum diperbarui' }[status] ?? '';
  return <span className={cx('inline-block size-2 rounded-full', c)} title={l} aria-label={l} />;
}

export function BookingCard({ b, showDate }: { b: BookingRow; showDate?: boolean }) {
  return (
    <Link to={`/bookings/${b.id}`} className="block rounded-2xl bg-surface border border-line p-4 active:bg-sunken">
      <div className="flex items-start gap-3">
        <div className="text-center min-w-14">
          {showDate ? <div className="text-xs text-muted">{shortDateId(b.startAt)}</div> : null}
          <div className="font-semibold tabular">{wibTime(b.startAt)}</div>
          <div className="text-xs text-muted tabular">{wibTime(b.endAt)}</div>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold truncate">{b.clientNameSnap}</span>
            <SyncDot status={b.gcalSyncStatus} />
          </div>
          <div className="text-sm text-muted truncate">
            {b.typeNameSnap} · {b.hours} jam{b.photographerNameSnap ? ` · ${b.photographerNameSnap}` : ''}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <StatusBadge status={b.status} />
            {b.status !== 'CANCELLED' ? <PayBadge total={b.total} paid={b.paidAmount} /> : null}
          </div>
        </div>
        <div className="text-right">
          <Money value={b.total} className="font-semibold" />
          {b.balance > 0 && b.status !== 'CANCELLED' ? <div className="text-xs text-muted">sisa <Money value={b.balance} /></div> : null}
        </div>
      </div>
    </Link>
  );
}
