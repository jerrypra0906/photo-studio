import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { dayNameId, renderTemplate, unknownPlaceholders } from '@jes/shared';
import { ApiError, api } from '../api';
import { Settings, useSettings } from '../hooks';
import { Banner, BottomBar, Button, Card, Chip, Field, Input, Page, PageHeader, Spinner, Stepper, Toggle, cx, inputCls, useToast } from '../ui';

/** S13 Studio settings (L2-3.4). */
export function AdminSettings() {
  const q = useSettings();
  const qc = useQueryClient();
  const toast = useToast();
  const [s, setS] = useState<Settings | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (q.data && !s) setS(q.data); }, [q.data, s]);
  if (!s) return (<><PageHeader title="Pengaturan studio" back="/admin" /><Spinner /></>);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS({ ...s, [k]: v });
  const setDay = (i: number, patch: Partial<Settings['openHours'][number]>) => set('openHours', s.openHours.map((d, j) => (j === i ? { ...d, ...patch } : d)));

  const save = async () => {
    setBusy(true);
    setErrors({});
    try {
      const r = await api.put('/settings', s);
      qc.setQueryData(['settings'], r);
      toast('Pengaturan disimpan');
    } catch (e) {
      if (e instanceof ApiError) { setErrors(e.fields); toast(e.message, 'bad'); }
    } finally { setBusy(false); }
  };
  const order = [1, 2, 3, 4, 5, 6, 0]; // Monday first

  return (
    <>
      <PageHeader title="Pengaturan studio" back="/admin" />
      <Page className="pb-28">
        <Card className="space-y-3">
          <h2 className="font-semibold">Profil</h2>
          <Field label="Nama studio" error={errors.studioName}><Input value={s.studioName} onChange={(e) => set('studioName', e.target.value)} /></Field>
          <Field label="WhatsApp studio"><Input type="tel" value={s.studioPhone} onChange={(e) => set('studioPhone', e.target.value)} /></Field>
          <Field label="Alamat"><textarea rows={2} className={inputCls} value={s.address} onChange={(e) => set('address', e.target.value)} /></Field>
          <Field label="Link Google Maps"><Input type="url" value={s.mapsUrl} onChange={(e) => set('mapsUrl', e.target.value)} /></Field>
        </Card>
        <Card className="space-y-3">
          <h2 className="font-semibold">Rekening bank</h2>
          {!s.bankName || !s.accountNo || !s.accountHolder ? <Banner tone="warn">Wajib diisi agar invoice PDF bisa dibuat.</Banner> : null}
          <Field label="Bank"><Input value={s.bankName} onChange={(e) => set('bankName', e.target.value)} /></Field>
          <Field label="Nomor rekening"><Input inputMode="numeric" value={s.accountNo} onChange={(e) => set('accountNo', e.target.value)} /></Field>
          <Field label="Atas nama"><Input value={s.accountHolder} onChange={(e) => set('accountHolder', e.target.value)} /></Field>
        </Card>
        <Card className="space-y-3">
          <h2 className="font-semibold">Jam operasional</h2>
          {order.map((i) => {
            const d = s.openHours[i];
            const err = errors[`openHours.${i}.close`];
            return (
              <div key={i} className="space-y-1">
                <div className="grid grid-cols-[5.5rem_1fr_1fr_auto] items-center gap-2">
                  <span className="text-sm">{dayNameId(i)}</span>
                  <input type="time" aria-label={`Buka ${dayNameId(i)}`} className={inputCls} disabled={d.closed} value={d.open} onChange={(e) => setDay(i, { open: e.target.value })} />
                  <input type="time" aria-label={`Tutup ${dayNameId(i)}`} className={inputCls} disabled={d.closed} value={d.close} aria-invalid={!!err || undefined} onChange={(e) => setDay(i, { close: e.target.value })} />
                  <label className="text-xs flex items-center gap-1"><input type="checkbox" checked={d.closed} onChange={(e) => setDay(i, { closed: e.target.checked })} /> Tutup</label>
                </div>
                {err ? <p className="text-sm text-bad">{err}</p> : null}
              </div>
            );
          })}
          <Field label="Interval slot">
            <div className="flex gap-2">{([30, 60] as const).map((m) => <Chip key={m} active={s.slotStepMin === m} onClick={() => set('slotStepMin', m)}>{m} menit</Chip>)}</div>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Maks jam / booking"><Stepper value={s.maxHours} min={1} max={24} onChange={(v) => set('maxHours', v)} /></Field>
            <Field label="Jeda antar booking"><Stepper value={s.bufferMin} min={0} max={120} suffix="mnt" onChange={(v) => set('bufferMin', Math.round(v / 5) * 5 || v)} /></Field>
          </div>
        </Card>
        <Card className="space-y-3">
          <h2 className="font-semibold">Ketentuan invoice</h2>
          <Field label="Aturan DP"><textarea rows={2} className={inputCls} value={s.dpRuleText} onChange={(e) => set('dpRuleText', e.target.value)} /></Field>
          <Field label="Syarat & pembatalan"><textarea rows={3} className={inputCls} value={s.termsText} onChange={(e) => set('termsText', e.target.value)} /></Field>
        </Card>
        <Card className="space-y-3">
          <h2 className="font-semibold">Rekap & kalender</h2>
          <Field label="Basis pendapatan default">
            <div className="flex gap-2">
              <Chip active={s.revenueBasis === 'BILLED'} onClick={() => set('revenueBasis', 'BILLED')}>Ditagih</Chip>
              <Chip active={s.revenueBasis === 'COLLECTED'} onClick={() => set('revenueBasis', 'COLLECTED')}>Diterima</Chip>
            </div>
          </Field>
          <Field label="Saat booking dibatalkan, acara kalender">
            <div className="flex gap-2">
              <Chip active={s.gcalCancelMode === 'DELETE'} onClick={() => set('gcalCancelMode', 'DELETE')}>Dihapus</Chip>
              <Chip active={s.gcalCancelMode === 'MARK'} onClick={() => set('gcalCancelMode', 'MARK')}>Ditandai CANCELLED</Chip>
            </div>
          </Field>
          <Toggle label="Tambah ✓ dan status bayar saat selesai" checked={s.gcalMarkCompleted} onChange={(v) => set('gcalMarkCompleted', v)} />
        </Card>
      </Page>
      <BottomBar><Button className="w-full" busy={busy} onClick={save}>Simpan pengaturan</Button></BottomBar>
    </>
  );
}

const KINDS: [string, string][] = [['NEW', 'Booking baru'], ['BALANCE', 'Pelunasan'], ['RESCHEDULE', 'Jadwal ulang'], ['CANCEL', 'Pembatalan']];
const SAMPLE: Record<string, string> = {
  client_name: 'Aurel', booking_no: 'JES-261030-001', invoice_no: 'INV-JES-261030-001', type: 'Photo Package', day_date: 'Jumat, 30 Oktober 2026',
  start: '14:00', end: '15:00', hours: '1', photographer: 'Hamja', line_items: '• Photo Package (1 jam): Rp599.000\n• MUA + Hairdo (1 booking): Rp600.000',
  total: 'Rp1.199.000', dp: 'Rp300.000', balance: 'Rp899.000', bank_name: 'BCA', account_no: '1234567890', account_holder: 'JES Space Studio',
  studio_name: 'JES Space Studio', studio_phone: '0812-0000-0000', studio_address: 'Jl. Contoh No. 1', maps_url: 'https://maps.app.goo.gl/…',
  dp_rule: 'Bisa DP 300K, pelunasan sebelum photoshoot dimulai.', old_schedule: 'Jumat, 14 Agustus 2026, 12:00 WIB', cancel_reason: 'Dibatalkan oleh klien',
};

/** S14 Templates: placeholder chips + live preview (US-21.2, 21.3). */
export function AdminTemplates() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['templates'], queryFn: () => api.get('/templates') });
  const [kind, setKind] = useState('NEW');
  const [body, setBody] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.data) setBody(q.data.templates.find((t: any) => t.kind === kind)?.body ?? q.data.defaults[kind]);
    setError('');
  }, [q.data, kind]);
  const unknown = useMemo(() => unknownPlaceholders(body), [body]);
  if (!q.data) return (<><PageHeader title="Template WhatsApp" back="/admin" /><Spinner /></>);
  const insert = (p: string) => setBody((b) => `${b}{${p}}`);
  const save = async () => {
    setBusy(true);
    try {
      await api.put(`/templates/${kind}`, { body });
      qc.invalidateQueries({ queryKey: ['templates'] });
      qc.invalidateQueries({ queryKey: ['message'] });
      toast('Template disimpan');
    } catch (e) { setError((e as ApiError).fields.body ?? (e as ApiError).message); }
    finally { setBusy(false); }
  };
  return (
    <>
      <PageHeader title="Template WhatsApp" back="/admin" />
      <Page className="pb-28">
        <div className="flex gap-2 overflow-x-auto -mx-4 px-4 pb-1">{KINDS.map(([k, l]) => <Chip key={k} active={kind === k} onClick={() => setKind(k)}>{l}</Chip>)}</div>
        <Field label="Isi template" error={error || (unknown.length ? `Placeholder tidak dikenal: ${unknown.map((u) => `{${u}}`).join(', ')}` : '')}>
          <textarea rows={12} className={cx(inputCls, 'text-sm font-mono')} value={body} onChange={(e) => setBody(e.target.value)} aria-invalid={unknown.length > 0 || undefined} />
        </Field>
        <div className="flex flex-wrap gap-1.5">
          {q.data.placeholders.map((p: string) => <button key={p} type="button" onClick={() => insert(p)} className="rounded-full bg-accent-soft text-accent-text text-xs px-2.5 py-1.5">{`{${p}}`}</button>)}
        </div>
        <button className="text-sm text-accent-text underline" onClick={() => setBody(q.data.defaults[kind])}>Kembalikan ke default</button>
        <Card>
          <h3 className="text-sm font-medium text-muted mb-2">Pratinjau</h3>
          <pre className="whitespace-pre-wrap text-sm font-sans">{renderTemplate(body, SAMPLE)}</pre>
        </Card>
      </Page>
      <BottomBar><Button className="w-full" busy={busy} disabled={unknown.length > 0} onClick={save}>Simpan template</Button></BottomBar>
    </>
  );
}

/** L2-5.1 Google Calendar connection (Owner only). */
export function AdminIntegrations() {
  const qc = useQueryClient();
  const toast = useToast();
  const [sp, setSp] = useSearchParams();
  const st = useQuery({ queryKey: ['gcal'], queryFn: () => api.get('/integrations/google'), refetchInterval: (q) => (q.state.data?.queue?.pending ? 5000 : false) });
  const connected = st.data?.gcalStatus === 'CONNECTED';
  const cals = useQuery({ queryKey: ['gcal', 'calendars'], queryFn: () => api.get('/integrations/google/calendars'), enabled: connected });
  const [pick, setPick] = useState('');
  const [push, setPush] = useState(true);
  const [warn, setWarn] = useState('');
  const [busy, setBusy] = useState(false);
  const result = sp.get('connected') ? 'ok' : sp.get('error');

  useEffect(() => { if (st.data?.gcalCalendarId) setPick(st.data.gcalCalendarId); }, [st.data?.gcalCalendarId]);

  const run = async (fn: () => Promise<any>, msg?: string) => {
    setBusy(true);
    try {
      const r = await fn();
      qc.invalidateQueries({ queryKey: ['gcal'] });
      qc.invalidateQueries({ queryKey: ['settings'] });
      if (msg) toast(msg);
      return r;
    } catch (e) { toast((e as ApiError).message, 'bad'); } finally { setBusy(false); }
  };
  const connect = () => run(async () => { const r = await api.get('/integrations/google/auth-url'); window.location.href = r.url; });

  if (st.isLoading) return (<><PageHeader title="Google Calendar" back="/admin" /><Spinner /></>);
  const d = st.data;
  return (
    <>
      <PageHeader title="Google Calendar" back="/admin" />
      <Page>
        {result === 'ok' ? <Banner tone="ok" action={<button onClick={() => setSp({})}>✕</button>}>Akun Google terhubung. Pilih kalender tujuan.</Banner> : null}
        {result && result !== 'ok' ? <Banner tone="bad" action={<button onClick={() => setSp({})}>✕</button>}>{result === 'denied' ? 'Akses ditolak di Google — tidak terhubung. Booking tetap bisa disimpan.' : `Gagal menghubungkan (${result}).`}</Banner> : null}
        {!d.configured ? (
          <Banner tone="warn">Server belum dikonfigurasi: isi GOOGLE_CLIENT_ID dan GOOGLE_CLIENT_SECRET di file .env lalu restart. Sampai itu, booking tetap tersimpan tanpa sinkron.</Banner>
        ) : null}
        <Card className="space-y-2">
          <div className="text-sm text-muted">Status</div>
          <div className="font-semibold">
            {d.gcalStatus === 'CONNECTED' ? `Terhubung sebagai ${d.gcalAccountEmail ?? '—'}${d.gcalCalendarName ? ` · ${d.gcalCalendarName}` : ''}`
              : d.gcalStatus === 'RECONNECT_NEEDED' ? 'Perlu dihubungkan ulang' : 'Tidak terhubung'}
          </div>
          {d.queue.pending || d.queue.failed ? <p className="text-sm text-muted">Antrean: {d.queue.pending} menunggu · {d.queue.failed} gagal (7 hari)</p> : null}
          {d.gcalStatus !== 'CONNECTED' ? <Button className="w-full" disabled={!d.configured} busy={busy} onClick={connect}>{d.gcalStatus === 'RECONNECT_NEEDED' ? 'Hubungkan ulang' : 'Hubungkan Google Calendar'}</Button> : null}
        </Card>
        {connected ? (
          <Card className="space-y-3">
            <h2 className="font-semibold">Kalender tujuan</h2>
            {cals.isLoading ? <Spinner /> : (
              <div className="space-y-2">
                {cals.data?.map((c: any) => (
                  <label key={c.id} className={cx('flex items-center gap-3 rounded-xl border px-3 min-h-11', pick === c.id ? 'border-accent-text bg-accent-soft' : 'border-line')}>
                    <input type="radio" name="cal" checked={pick === c.id} onChange={() => setPick(c.id)} />
                    <span className="flex-1">{c.name}{c.primary ? ' (utama)' : ''}</span>
                    <span className="text-xs text-muted">{c.timeZone}</span>
                  </label>
                ))}
              </div>
            )}
            <Toggle label="Kirim booking mendatang sekarang" checked={push} onChange={setPush} />
            <Button className="w-full" disabled={!pick} busy={busy}
              onClick={async () => { const r = await run(() => api.put('/integrations/google/calendar', { calendarId: pick, pushExisting: push }), 'Kalender disimpan'); if (r) setWarn(r.timeZoneWarning ?? ''); }}>Simpan kalender</Button>
            {warn ? <Banner tone="warn">{warn}</Banner> : null}
          </Card>
        ) : null}
        {connected && d.gcalCalendarId ? (
          <div className="grid grid-cols-2 gap-3">
            <Button variant="secondary" busy={busy} onClick={() => run(() => api.post('/integrations/google/test'), 'Koneksi OK')}>Tes sinkron</Button>
            <Button variant="secondary" busy={busy} onClick={() => run(() => api.post('/integrations/google/resync'), 'Sinkron ulang diantrikan')}>Sinkron ulang semua</Button>
          </div>
        ) : null}
        {d.gcalStatus !== 'NOT_CONNECTED' ? <Button variant="ghost" className="w-full text-bad" busy={busy} onClick={() => run(() => api.post('/integrations/google/disconnect'), 'Terputus')}>Putuskan</Button> : null}
        <p className="text-sm text-muted">Sinkron satu arah: aplikasi → Google Calendar. Perubahan langsung di Google Calendar tidak dibaca kembali dan akan ditimpa pada perubahan berikutnya.</p>
      </Page>
    </>
  );
}
