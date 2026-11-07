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

/** Colour of the card's left rail: payment state, so the list reads at a glance. */
export function railClass(b: Pick<BookingRow, 'status' | 'total' | 'paidAmount'>) {
  if (b.status === 'CANCELLED') return 'bg-line';
  if (b.paidAmount >= b.total) return 'bg-ok shadow-[0_0_10px_var(--color-ok)]';
  if (b.paidAmount > 0) return 'bg-info shadow-[0_0_10px_var(--color-info)]';
  return 'bg-bad shadow-[0_0_10px_var(--color-bad)]';
}

export function BookingCard({ b, showDate }: { b: BookingRow; showDate?: boolean }) {
  return (
    <Link to={`/bookings/${b.id}`} className={cx('block rounded-3xl glass border border-line p-4 transition-colors active:bg-accent-soft', b.status === 'CANCELLED' && 'opacity-60')}>
      <div className="flex items-stretch gap-3">
        <div className="min-w-14 flex flex-col justify-center">
          {showDate ? <div className="hud text-[10px] text-muted">{shortDateId(b.startAt)}</div> : null}
          <div className="font-display text-[17px] font-semibold tabular">{wibTime(b.startAt)}</div>
          <div className="font-mono text-[11px] text-muted">{wibTime(b.endAt)}</div>
        </div>
        <div className={cx('w-[3px] rounded-full shrink-0', railClass(b))} aria-hidden />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="font-semibold truncate">{b.clientNameSnap}</span>
            <SyncDot status={b.gcalSyncStatus} />
            <Money value={b.total} className="ml-auto shrink-0 font-semibold" />
          </div>
          <div className="flex items-baseline gap-2 text-sm text-muted">
            <span className="truncate">{b.typeNameSnap} · {b.hours} jam{b.photographerNameSnap ? ` · ${b.photographerNameSnap}` : ''}</span>
            {b.balance > 0 && b.status !== 'CANCELLED' ? <span className="ml-auto shrink-0 text-xs">sisa <Money value={b.balance} /></span> : null}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <StatusBadge status={b.status} />
            {b.status !== 'CANCELLED' ? <PayBadge total={b.total} paid={b.paidAmount} /> : null}
          </div>
        </div>
      </div>
    </Link>
  );
}
