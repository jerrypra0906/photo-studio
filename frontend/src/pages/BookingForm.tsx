import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  displayPhone, formatRp, fromMinutes, fromWib, normalizePhone, priceBooking, toMinutes, wibDate, wibParts, wibTime,
} from '@jes/shared';
import { ApiError, api, uuid } from '../api';
import { useIsOwner } from '../App';
import { UNIT_LABEL, useAddons, usePhotographers, useSettings, useTypes } from '../hooks';
import { Banner, BottomBar, Button, Card, Chip, Empty, Field, Input, MoneyInput, Page, PageHeader, Spinner, Stepper, Toggle, cx, inputCls, useToast } from '../ui';

/** Google event descriptions may carry simple HTML. */
const plainText = (html: string) => html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/\n{3,}/g, '\n\n').trim();
/** First Indonesian mobile number in the text, if any. */
const findPhone = (t: string) => t.match(/(?:\+?62|0)8[\d\s.-]{7,14}\d/)?.[0].replace(/[\s.-]/g, '') ?? '';

interface FormState {
  typeId: string; hours: number; date: string; startTime: string; clientName: string; clientPhone: string; photographerId: string | null;
  addons: Record<string, number>; adjustment: number; adjustmentReason: string; dpAmount: number; notes: string; afterHoursReason: string;
}

/** S5 New / Edit booking (L2-1.1, L2-1.3, PRD §8.4). */
export default function BookingForm() {
  const { id } = useParams();
  const editing = !!id;
  const [sp] = useSearchParams();
  const loc = useLocation();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const owner = useIsOwner();
  const types = useTypes();
  const addons = useAddons();
  const photographers = usePhotographers();
  const settings = useSettings();
  const existing = useQuery({ queryKey: ['booking', id], queryFn: () => api.get(`/bookings/${id}`), enabled: editing });
  const today = wibDate(new Date());
  const duplicateOf = (loc.state as any)?.duplicate;
  // made in Google Calendar first (calendar inbox): prefill from the event and link it on save
  const inboxId = !editing ? sp.get('inbox') : null;
  const inbox = useQuery({ queryKey: ['calendar-inbox', 'item', inboxId], queryFn: () => api.get(`/calendar-inbox/${inboxId}`), enabled: !!inboxId, retry: false });
  const fromCal = inbox.data?.status === 'PENDING' ? inbox.data : null;

  const [f, setF] = useState<FormState | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [showPayment, setShowPayment] = useState(false);
  const [applyCurrent, setApplyCurrent] = useState(false);
  const idemKey = useRef(uuid());

  // initialise once data is loaded
  useEffect(() => {
    if (f || !types.data || (editing && !existing.data) || (inboxId && inbox.isLoading)) return;
    const src = editing ? existing.data : duplicateOf;
    if (src) {
      setF({
        typeId: src.typeId, hours: src.hours, date: editing ? wibDate(src.startAt) : (sp.get('date') ?? today),
        startTime: editing ? wibTime(src.startAt) : (sp.get('time') ?? ''), clientName: src.clientNameSnap,
        clientPhone: src.clientPhoneSnap ? displayPhone(src.clientPhoneSnap) : '', photographerId: src.photographerId,
        addons: Object.fromEntries((src.addons ?? []).map((a: any) => [a.addonId, a.qty])),
        adjustment: src.adjustment ?? 0, adjustmentReason: src.adjustmentReason ?? '', dpAmount: editing ? src.dpAmount : 0,
        notes: src.notes ?? '', afterHoursReason: src.afterHoursReason ?? '',
      });
      if (src.adjustment || src.dpAmount || src.notes) setShowPayment(true);
      return;
    }
    const active = types.data.filter((t) => t.active);
    if (fromCal) {
      const start = new Date(fromCal.startAt);
      const hours = Math.min(24, Math.max(1, Math.ceil((new Date(fromCal.endAt).getTime() - start.getTime()) / 3600_000)));
      const desc = plainText(fromCal.description ?? '');
      setF({
        typeId: active.length === 1 ? active[0].id : '', hours, date: wibDate(start), startTime: wibTime(start),
        clientName: (fromCal.summary ?? '').trim().slice(0, 60), clientPhone: findPhone(desc), photographerId: null, addons: {},
        adjustment: 0, adjustmentReason: '', dpAmount: 0, notes: desc.slice(0, 1000), afterHoursReason: '',
      });
      if (desc) setShowPayment(true);
      return;
    }
    setF({
      typeId: active.length === 1 ? active[0].id : '', hours: 1, date: sp.get('date') ?? today, startTime: sp.get('time') ?? '',
      clientName: '', clientPhone: '', photographerId: null, addons: {}, adjustment: 0, adjustmentReason: '', dpAmount: 0, notes: '', afterHoursReason: '',
    });
  }, [types.data, existing.data, editing, f, sp, today, duplicateOf, inboxId, inbox.isLoading, fromCal]);

  const sched = useQuery({
    queryKey: ['schedule', 'day', f?.date, id],
    queryFn: () => api.get(`/schedule?from=${f!.date}&to=${f!.date}${id ? `&excludeId=${id}` : ''}`),
    enabled: !!f?.date,
  });

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => { setF((p) => (p ? { ...p, [k]: v } : p)); setErrors((e) => ({ ...e, [k]: '' })); };

  const type = types.data?.find((t) => t.id === f?.typeId);
  const s = settings.data;
  const maxHours = Math.min(type?.maxHours ?? 8, s?.maxHours ?? 8);
  const ex = existing.data;

  // add-ons for this type; on edit keep the ones already on the booking even if since deactivated
  const availableAddons = (addons.data ?? []).filter((a) => (a.active && type && a.typeIds.includes(type.id)) || (ex && ex.addons.some((x: any) => x.addonId === a.id) && ex.typeId === f?.typeId));
  const snapByAddon: Record<string, any> = Object.fromEntries((ex?.addons ?? []).map((a: any) => [a.addonId, a]));
  const keepSnap = editing && !applyCurrent;

  const pricing = useMemo(() => {
    if (!f || !type) return null;
    const lines = Object.entries(f.addons).map(([aid, qty]) => {
      const m = addons.data?.find((a) => a.id === aid);
      const snap = keepSnap ? snapByAddon[aid] : undefined;
      return { addonId: aid, name: snap?.nameSnap ?? m?.name ?? '', unit: (snap?.unitSnap ?? m?.unit ?? 'BOOKING') as any, price: snap?.priceSnap ?? m?.price ?? 0, qty };
    });
    const rate = keepSnap && ex?.typeId === type.id ? ex.rateSnap : type.hourlyRate;
    return priceBooking({ typeName: type.name, rate, hours: f.hours, addons: lines, adjustment: owner ? f.adjustment : (ex?.adjustment ?? 0), dp: f.dpAmount, paid: ex?.status === 'COMPLETED' ? ex.paidAmount : f.dpAmount });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f, type, addons.data, keepSnap, ex, owner]);

  // master prices changed since the booking was saved? (L2-1.3.4)
  const pricesChanged = !!ex && !!type && (
    (ex.typeId === type.id && ex.rateSnap !== type.hourlyRate) ||
    ex.addons.some((a: any) => { const m = addons.data?.find((x) => x.id === a.addonId); return m && (m.price !== a.priceSnap || m.unit !== a.unitSnap); })
  );

  // ---------- slot availability ----------
  const dow = f?.date ? wibParts(fromWib(f.date, '12:00')).dow : 0;
  const dayHours = s?.openHours[dow];
  const step = s?.slotStepMin ?? 30;
  const buffer = s?.bufferMin ?? 0;
  const bookings: any[] = sched.data?.bookings ?? [];
  const nowMin = toMinutes(wibTime(new Date()));
  const overlaps = (startMin: number, hours: number) => {
    const a = fromWib(f!.date, fromMinutes(startMin)).getTime();
    const bEnd = a + hours * 3600_000 + buffer * 60_000;
    return bookings.find((b) => a < new Date(b.blockEndAt).getTime() && new Date(b.startAt).getTime() < bEnd);
  };
  const slotOptions: { t: string; free: boolean }[] = [];
  if (f && dayHours && !dayHours.closed) {
    // start times inside opening hours; a session running past closing is flagged below (US-05.4)
    for (let m = toMinutes(dayHours.open); m < toMinutes(dayHours.close); m += step) {
      const isPast = f.date === today && m < nowMin;
      slotOptions.push({ t: fromMinutes(m), free: !overlaps(m, f.hours) && !isPast });
    }
  }
  const startMin = f?.startTime ? toMinutes(f.startTime) : null;
  const endMin = startMin != null && f ? startMin + f.hours * 60 : null;
  const clash = startMin != null && f ? overlaps(startMin, f.hours) : null;
  const afterHoursMsg = startMin != null && endMin != null && dayHours
    ? dayHours.closed ? 'Studio tutup di hari ini' : endMin > toMinutes(dayHours.close) ? `Selesai setelah jam tutup (${fromMinutes(endMin)})` : startMin < toMinutes(dayHours.open) ? `Mulai sebelum jam buka (${dayHours.open})` : ''
    : '';
  const photographerBusy = (pid: string) => startMin != null && bookings.some((b) => {
    if (b.photographerId !== pid) return false;
    const a = fromWib(f!.date, f!.startTime).getTime();
    return a < new Date(b.endAt).getTime() && new Date(b.startAt).getTime() < a + f!.hours * 3600_000;
  });

  // ---------- client suggestions (US-06.2) ----------
  const [suggestQ, setSuggestQ] = useState('');
  useEffect(() => {
    const h = setTimeout(() => setSuggestQ(f?.clientName ?? ''), 250);
    return () => clearTimeout(h);
  }, [f?.clientName]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const suggestions = useQuery({ queryKey: ['clients', suggestQ], queryFn: () => api.get(`/clients?q=${encodeURIComponent(suggestQ)}`), enabled: suggestOpen && suggestQ.length >= 2 });

  if (!f || types.isLoading || settings.isLoading || (editing && existing.isLoading)) return (<><PageHeader title={editing ? 'Ubah booking' : 'Booking baru'} back /><Spinner /></>);

  const activeTypes = (types.data ?? []).filter((t) => t.active || t.id === ex?.typeId);
  if (!activeTypes.length) {
    return (<><PageHeader title="Booking baru" back /><Page><Empty action={owner ? <Link to="/admin/types" className="text-accent-text underline">Atur jenis booking</Link> : null}>Belum ada jenis booking — minta Owner untuk mengatur.</Empty></Page></>);
  }
  const activePhotographers = (photographers.data ?? []).filter((p) => p.active || p.id === ex?.photographerId);
  const phoneInvalid = f.clientPhone.trim() !== '' && !normalizePhone(f.clientPhone);

  const canSave = !!type && !!f.startTime && f.clientName.trim().length >= 2 && (!type.requiresPhotographer || !!f.photographerId)
    && !clash && !phoneInvalid && !(afterHoursMsg && !f.afterHoursReason.trim()) && !!pricing && pricing.errors.length === 0
    && !(owner && f.adjustment !== 0 && !f.adjustmentReason.trim());

  const save = async () => {
    if (!type || !pricing) return;
    setBusy(true);
    setFormError('');
    const body = {
      typeId: f.typeId, hours: f.hours, date: f.date, startTime: f.startTime, clientName: f.clientName.trim(),
      clientPhone: f.clientPhone.trim() || null, photographerId: type.requiresPhotographer || f.photographerId ? f.photographerId : null,
      addons: Object.entries(f.addons).filter(([aid]) => availableAddons.some((a) => a.id === aid)).map(([addonId, qty]) => ({ addonId, qty })),
      adjustment: owner ? f.adjustment : 0, adjustmentReason: owner && f.adjustment ? f.adjustmentReason : null,
      dpAmount: f.dpAmount, notes: f.notes || null, afterHoursReason: afterHoursMsg ? f.afterHoursReason : null,
      applyCurrentPrices: editing ? applyCurrent : undefined,
      gcalInboxId: fromCal ? fromCal.id : undefined,
    };
    try {
      const r = editing
        ? await api.patch(`/bookings/${id}`, body, { 'if-match': String(ex.version) })
        : await api.post('/bookings', body, { 'idempotency-key': idemKey.current });
      qc.invalidateQueries({ queryKey: ['bookings'] });
      qc.invalidateQueries({ queryKey: ['schedule'] });
      if (fromCal) qc.invalidateQueries({ queryKey: ['calendar-inbox'] });
      qc.setQueryData(['booking', r.id], r);
      toast(editing ? 'Perubahan disimpan' : `Booking ${r.bookingNo} dibuat`);
      nav(`/bookings/${r.id}`, { replace: true, state: { justSaved: true, rescheduled: !!r.rescheduledFrom } });
    } catch (e) {
      if (e instanceof ApiError) {
        setErrors(e.fields);
        // US-11.2: slot just taken → inputs stay, refresh availability
        if (e.code === 'SLOT_TAKEN') { setFormError(e.message.startsWith('Slot') ? 'Slot ini baru saja terisi. Pilih jam lain.' : e.message); sched.refetch(); }
        else if (e.code === 'STALE') setFormError(e.message);
        else if (e.status === 0) setFormError('Gagal menyimpan — periksa koneksi lalu coba lagi.');
        else setFormError(e.message);
      }
    } finally {
      setBusy(false);
    }
  };

  const toggleAddon = (aid: string) => setF((p) => {
    if (!p) return p;
    const next = { ...p.addons };
    if (next[aid]) delete next[aid]; else next[aid] = 1;
    return { ...p, addons: next };
  });

  return (
    <>
      <PageHeader title={editing ? `Ubah ${ex.bookingNo}` : 'Booking baru'} back />
      <Page className="pb-44">
        {formError ? <Banner tone="bad">{formError}</Banner> : null}
        {fromCal ? (
          <Banner tone="info">
            Dari Google Calendar: <span className="font-semibold">“{fromCal.summary || 'Tanpa judul'}”</span>. Pilih jenis, lalu lengkapi harga dan no. HP.
            Setelah disimpan, event yang sama di kalender diperbarui dengan detail booking (tidak dibuat dobel).
          </Banner>
        ) : inboxId && !inbox.isLoading ? <Banner tone="warn">Event kalender ini sudah diproses atau dihapus. Booking ini akan dibuat sebagai booking baru biasa.</Banner> : null}

        {/* 1. Type */}
        <section className="space-y-2">
          <h2 className="font-semibold">Jenis</h2>
          <div className="grid grid-cols-2 gap-3">
            {activeTypes.map((t) => (
              <button key={t.id} type="button" aria-pressed={f.typeId === t.id}
                onClick={() => setF((p) => p && ({
                  ...p, typeId: t.id, hours: Math.min(Math.max(p.hours, t.minHours), Math.min(t.maxHours, s?.maxHours ?? 8)),
                  // US-03.2: photographer hidden & cleared when the type doesn't need one
                  photographerId: t.requiresPhotographer ? p.photographerId : null,
                  addons: Object.fromEntries(Object.entries(p.addons).filter(([aid]) => addons.data?.find((a) => a.id === aid)?.typeIds.includes(t.id))),
                }))}
                className={cx('rounded-2xl border-2 p-4 text-left min-h-20 transition-colors', f.typeId === t.id ? 'border-accent-text bg-accent-soft shadow-[0_0_0_4px_var(--color-accent-soft)]' : 'border-line glass')}>
                <div className="font-semibold">{t.name}</div>
                <div className="text-sm text-muted tabular">{formatRp(t.hourlyRate)}/jam</div>
              </button>
            ))}
          </div>
        </section>

        {/* 2. When */}
        <section className="space-y-3">
          <h2 className="font-semibold">Waktu</h2>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 items-start">
            <Field label="Tanggal" htmlFor="date" error={errors.date}>
              <input id="date" type="date" className={inputCls} value={f.date} min={owner ? undefined : today}
                onChange={(e) => { set('date', e.target.value); set('startTime', ''); }} />
            </Field>
            <Field label="Durasi" error={errors.hours}>
              <Stepper value={f.hours} min={type?.minHours ?? 1} max={maxHours} suffix="jam" onChange={(v) => set('hours', v)} maxHint={`Maks ${maxHours} jam`} />
            </Field>
          </div>
          {f.date < today ? <Banner tone="warn">Tanggal lampau — booking akan ditandai “back-dated”.</Banner> : null}
          <div className="flex gap-2 overflow-x-auto -mx-4 px-4 pb-1">
            {[1, 2, 3].filter((h) => h <= maxHours).map((h) => <Chip key={h} active={f.hours === h} onClick={() => set('hours', h)}>{h} jam</Chip>)}
          </div>
          <Field label="Jam mulai" error={errors.startTime}>
            {dayHours?.closed ? <p className="text-sm text-warn">Studio tutup di hari ini.</p> : null}
            {sched.isLoading ? <Spinner /> : (
              <div className="flex flex-wrap gap-2">
                {slotOptions.filter((o) => o.free || o.t === f.startTime).map((o) => <Chip key={o.t} active={f.startTime === o.t} onClick={() => set('startTime', o.t)}>{o.t}</Chip>)}
                {slotOptions.every((o) => !o.free) && !dayHours?.closed ? <p className="text-sm text-muted">Tidak ada slot kosong untuk {f.hours} jam di hari ini.</p> : null}
              </div>
            )}
            {owner ? (
              <details className="mt-2 text-sm">
                <summary className="text-accent-text cursor-pointer min-h-11 flex items-center">Jam lain (di luar jam buka)</summary>
                <input type="time" step={step * 60} className={cx(inputCls, 'mt-2')} value={f.startTime} onChange={(e) => set('startTime', e.target.value)} aria-label="Jam mulai manual" />
              </details>
            ) : null}
          </Field>
          {startMin != null && endMin != null ? (
            clash ? (
              <p className="text-sm font-medium text-bad" role="alert">Bentrok dengan {clash.bookingNo} ({clash.clientNameSnap}, {wibTime(clash.startAt)}–{wibTime(clash.endAt)})</p>
            ) : (
              <p className="text-sm font-medium text-ok">{f.startTime} – {fromMinutes(endMin)} · Tersedia</p>
            )
          ) : null}
          {afterHoursMsg && !clash ? (
            <Field label={`${afterHoursMsg} — alasan`} htmlFor="ahr" error={errors.afterHoursReason}>
              <Input id="ahr" value={f.afterHoursReason} onChange={(e) => set('afterHoursReason', e.target.value)} placeholder="mis. klien minta sesi malam" />
            </Field>
          ) : null}
        </section>

        {/* 3. Client */}
        <section className="space-y-3">
          <h2 className="font-semibold">Klien</h2>
          <Field label="Nama klien" htmlFor="cn" error={errors.clientName}>
            <div className="relative">
              <Input id="cn" autoComplete="off" value={f.clientName} invalid={!!errors.clientName} maxLength={60}
                onFocus={() => setSuggestOpen(true)} onBlur={() => setTimeout(() => setSuggestOpen(false), 150)}
                onChange={(e) => set('clientName', e.target.value)} />
              {suggestOpen && suggestions.data?.length ? (
                <ul className="absolute z-20 mt-1 w-full rounded-xl border border-line bg-surface shadow-lg overflow-hidden">
                  {suggestions.data.map((c: any) => (
                    <li key={c.id}>
                      <button type="button" className="w-full text-left px-3 py-2 min-h-11 active:bg-accent-soft"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => { setF((p) => p && ({ ...p, clientName: c.name, clientPhone: c.phoneE164 ? displayPhone(c.phoneE164) : '' })); setSuggestOpen(false); }}>
                        {c.name}{c.phoneE164 ? <span className="text-muted"> — {displayPhone(c.phoneE164)}</span> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </Field>
          <Field label="Nomor WhatsApp" htmlFor="cp" error={errors.clientPhone || (phoneInvalid ? 'Masukkan nomor telepon yang valid' : '')} hint="Opsional, dibutuhkan untuk tombol Buka WhatsApp">
            <Input id="cp" type="tel" inputMode="tel" autoComplete="off" placeholder="0812-3456-7890" value={f.clientPhone} invalid={phoneInvalid} onChange={(e) => set('clientPhone', e.target.value)} />
          </Field>
        </section>

        {/* 4. Photographer */}
        {type?.requiresPhotographer ? (
          <section className="space-y-2">
            <h2 className="font-semibold">Fotografer</h2>
            {activePhotographers.length === 0 ? (
              <Empty action={owner ? <Link to="/admin/photographers" className="text-accent-text underline">Tambah fotografer</Link> : null}>Belum ada fotografer.</Empty>
            ) : (
              <div className="flex flex-wrap gap-2">
                {activePhotographers.map((p) => {
                  const isBusy = photographerBusy(p.id);
                  return <Chip key={p.id} active={f.photographerId === p.id} disabled={isBusy} onClick={() => set('photographerId', p.id)}>{p.name}{isBusy ? ' · Sibuk' : ''}</Chip>;
                })}
              </div>
            )}
            {errors.photographerId ? <p className="text-sm text-bad">{errors.photographerId}</p> : null}
          </section>
        ) : null}

        {/* 5. Add-ons */}
        {type ? (
          <section className="space-y-2">
            <h2 className="font-semibold">Add-on</h2>
            {availableAddons.length === 0 ? <p className="text-sm text-muted">Tidak ada add-on untuk {type.name}.</p> : null}
            {availableAddons.map((a) => {
              const on = !!f.addons[a.id];
              const snap = keepSnap ? snapByAddon[a.id] : undefined;
              const price = snap?.priceSnap ?? a.price;
              const unit = snap?.unitSnap ?? a.unit;
              return (
                <div key={a.id} className={cx('rounded-2xl border p-3 flex items-center gap-3', on ? 'border-accent-text bg-accent-soft shadow-[0_0_0_4px_var(--color-accent-soft)]' : 'border-line glass')}>
                  <button type="button" className="flex-1 text-left min-h-11" onClick={() => toggleAddon(a.id)} aria-pressed={on}>
                    <div className="font-medium">{a.name}</div>
                    <div className="text-sm text-muted tabular">{formatRp(price)} {UNIT_LABEL[unit]}</div>
                  </button>
                  {on && unit === 'PERSON' ? (
                    <Stepper value={f.addons[a.id]} min={1} max={50} onChange={(v) => setF((p) => p && ({ ...p, addons: { ...p.addons, [a.id]: v } }))} />
                  ) : (
                    <button type="button" role="switch" aria-checked={on} aria-label={a.name} onClick={() => toggleAddon(a.id)}
                      className={cx('relative h-7 w-12 rounded-full shrink-0', on ? 'bg-accent' : 'bg-line')}>
                      <span className={cx('absolute top-0.5 size-6 rounded-full bg-white shadow transition-all', on ? 'left-[22px]' : 'left-0.5')} />
                    </button>
                  )}
                </div>
              );
            })}
          </section>
        ) : null}

        {editing && pricesChanged ? (
          <Card className="space-y-1">
            <Toggle label="Pakai harga master terbaru" checked={applyCurrent} onChange={setApplyCurrent} />
            <p className="text-sm text-muted">Harga master berubah sejak booking dibuat. Default: tetap pakai harga lama.</p>
          </Card>
        ) : null}

        {/* 6. Payment */}
        <section className="space-y-3">
          <button type="button" className="w-full flex items-center justify-between min-h-11 font-semibold" onClick={() => setShowPayment(!showPayment)} aria-expanded={showPayment}>
            Pembayaran & catatan <span className="text-muted">{showPayment ? '▲' : '▼'}</span>
          </button>
          {showPayment ? (
            <div className="space-y-3">
              {owner ? (
                <>
                  <Field label="Penyesuaian harga (diskon: −)" htmlFor="adj" error={errors.adjustment || pricing?.errors.find((e) => e.field === 'adjustment')?.message}>
                    <MoneyInput id="adj" value={f.adjustment || null} allowNegative onChange={(v) => set('adjustment', v ?? 0)} invalid={!!errors.adjustment} />
                  </Field>
                  {f.adjustment !== 0 ? (
                    <Field label="Alasan penyesuaian" htmlFor="adjr" error={errors.adjustmentReason || (!f.adjustmentReason.trim() ? 'Alasan wajib diisi' : '')}>
                      <Input id="adjr" value={f.adjustmentReason} onChange={(e) => set('adjustmentReason', e.target.value)} placeholder="mis. promo booking panjang" />
                    </Field>
                  ) : null}
                </>
              ) : null}
              <Field label={ex?.status === 'COMPLETED' ? 'DP' : 'DP diterima'} htmlFor="dp" error={errors.dpAmount || pricing?.errors.find((e) => e.field === 'dpAmount')?.message}>
                <MoneyInput id="dp" value={f.dpAmount || null} onChange={(v) => set('dpAmount', v ?? 0)} />
              </Field>
              <Field label="Catatan internal" htmlFor="notes">
                <textarea id="notes" rows={3} className={inputCls} value={f.notes} maxLength={1000} onChange={(e) => set('notes', e.target.value)} />
              </Field>
            </div>
          ) : null}
        </section>
      </Page>

      {/* Sticky total (PRD §8.4) */}
      <BottomBar>
        {showBreakdown && pricing ? (
          <div className="mb-3 space-y-1 text-sm max-h-48 overflow-y-auto">
            {pricing.lines.map((l, i) => (
              <div key={i} className="flex justify-between gap-2">
                <span className="text-muted truncate">{l.label}{l.kind !== 'ADJUSTMENT' ? ` × ${l.qty}` : ''}</span>
                <span className="tabular">{formatRp(l.amount)}</span>
              </div>
            ))}
            {pricing.dp ? <div className="flex justify-between"><span className="text-muted">DP</span><span className="tabular">−{formatRp(pricing.dp)}</span></div> : null}
            <div className="flex justify-between font-medium"><span>Sisa</span><span className="tabular">{formatRp(pricing.balance)}</span></div>
          </div>
        ) : null}
        <div className="flex items-center gap-3">
          <button type="button" className="flex-1 text-left" onClick={() => setShowBreakdown(!showBreakdown)} aria-expanded={showBreakdown}>
            <div className="text-xs text-muted">Total {showBreakdown ? '▼' : '▲'}</div>
            <div className="text-xl font-semibold tabular">{pricing ? formatRp(pricing.total) : '—'}</div>
          </button>
          <Button onClick={save} disabled={!canSave} busy={busy} className="px-6">{editing ? 'Simpan' : 'Simpan booking'}</Button>
        </div>
      </BottomBar>
    </>
  );
}
