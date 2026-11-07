import { ReactNode, useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatRp, longDateId, wibTime } from '@jes/shared';
import { ApiError, api } from '../api';
import { useAuth } from '../App';
import { Addon, BookingType, Category, Photographer, UNIT_LABEL, useAddons, useCategories, usePhotographers, useTypes } from '../hooks';
import { Banner, Button, Chip, Confirm, Empty, Field, Input, MoneyInput, Page, PageHeader, Sheet, Spinner, Stepper, Toggle, cx } from '../ui';

/** S9 Admin home. */
export function AdminHome() {
  const { logout, user } = useAuth();
  const items: [string, string, string][] = [
    ['/admin/types', 'Jenis booking & tarif', 'Studio Only, Photo Package …'],
    ['/admin/photographers', 'Fotografer', 'Nama dan fee default'],
    ['/admin/addons', 'Add-on', 'MUA, dekorasi, extra person …'],
    ['/admin/categories', 'Kategori pengeluaran', 'Tetap / variabel, berulang'],
    ['/admin/settings', 'Pengaturan studio', 'Profil, rekening, jam buka'],
    ['/admin/templates', 'Template WhatsApp', 'Pesan booking, pelunasan, dll.'],
    ['/admin/integrations', 'Google Calendar', 'Sinkron otomatis ke kalender'],
    ['/admin/users', 'Pengguna', 'Owner dan staf'],
  ];
  return (
    <>
      <PageHeader title="Admin" />
      <Page>
        <div className="rounded-3xl border border-line glass divide-y divide-line overflow-hidden">
          {items.map(([to, t, d]) => (
            <Link key={to} to={to} className="flex items-center gap-3 px-4 min-h-16 active:bg-accent-soft">
              <div className="flex-1"><div className="font-medium">{t}</div><div className="text-sm text-muted">{d}</div></div>
              <span className="text-muted">›</span>
            </Link>
          ))}
        </div>
        <p className="text-sm text-muted text-center">Masuk sebagai {user?.email}</p>
        <Button variant="secondary" className="w-full" onClick={logout}>Keluar</Button>
      </Page>
    </>
  );
}

// ---------- generic list + edit sheet ----------
function MasterPage<T extends { id: string; active: boolean; inUse?: boolean }>({
  title, items, loading, render, empty, onNew, editor,
}: { title: string; items?: T[]; loading: boolean; render: (t: T) => ReactNode; empty: string; onNew: () => void; editor: ReactNode }) {
  return (
    <>
      <PageHeader title={title} back="/admin" action={<button className="text-accent-text font-medium px-2 min-h-11" onClick={onNew}>+ Tambah</button>} />
      <Page>
        {loading ? <Spinner /> : !items?.length ? <Empty>{empty}</Empty> : (
          <div className="rounded-3xl border border-line glass divide-y divide-line overflow-hidden">{items.map((t) => <div key={t.id} className={cx(!t.active && 'opacity-60')}>{render(t)}</div>)}</div>
        )}
      </Page>
      {editor}
    </>
  );
}

function RowButton({ onClick, title, sub, right }: { onClick: () => void; title: ReactNode; sub?: ReactNode; right?: ReactNode }) {
  return (
    <button onClick={onClick} className="w-full flex items-center gap-3 px-4 min-h-16 py-2 text-left active:bg-accent-soft">
      <div className="flex-1 min-w-0"><div className="font-medium truncate">{title}</div>{sub ? <div className="text-sm text-muted truncate">{sub}</div> : null}</div>
      {right}
    </button>
  );
}

const Inactive = () => <span className="text-xs rounded-full bg-sunken px-2 py-0.5 text-muted">Nonaktif</span>;

function useSave(keys: string[]) {
  const qc = useQueryClient();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErrors({}); setError(null);
    try {
      await fn();
      keys.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      return true;
    } catch (e) {
      if (e instanceof ApiError) { setErrors(e.code === 'DUPLICATE' ? { name: 'Nama sudah ada' } : e.fields); setError(e); }
      return false;
    } finally { setBusy(false); }
  };
  return { run, errors, error, busy, reset: () => { setErrors({}); setError(null); } };
}

function EditorSheet({ open, title, onClose, onSave, onDelete, canDelete, busy, error, children }: {
  open: boolean; title: string; onClose: () => void; onSave: () => void; onDelete?: () => void; canDelete?: boolean; busy: boolean; error?: ApiError | null; children: ReactNode;
}) {
  return (
    <Sheet open={open} onClose={onClose} title={title}
      footer={<div className="flex gap-3">{onDelete && canDelete ? <Button variant="secondary" className="text-bad" onClick={onDelete}>Hapus</Button> : null}<Button className="flex-1" busy={busy} onClick={onSave}>Simpan</Button></div>}>
      {error && !Object.keys(error.fields).length && error.code !== 'DUPLICATE' && error.code !== 'FUTURE_BOOKINGS' ? <Banner tone="bad">{error.message}</Banner> : null}
      {children}
    </Sheet>
  );
}

// ---------- booking types (S10, US-18) ----------
export function AdminTypes() {
  const types = useTypes();
  const [edit, setEdit] = useState<Partial<BookingType> | null>(null);
  const s = useSave(['booking-types']);
  const open = (t?: BookingType) => { s.reset(); setEdit(t ?? { name: '', hourlyRate: 0, requiresPhotographer: false, minHours: 1, maxHours: 8, calendarKeyword: '', active: true, sortOrder: (types.data?.length ?? 0) + 1 }); };
  const save = async () => {
    const body = { ...edit, colorId: edit!.colorId ?? null };
    if (await s.run(() => (edit!.id ? api.patch(`/booking-types/${edit!.id}`, body) : api.post('/booking-types', body)))) setEdit(null);
  };
  return (
    <MasterPage title="Jenis booking" items={types.data} loading={types.isLoading} empty="Belum ada jenis booking." onNew={() => open()}
      render={(t) => <RowButton onClick={() => open(t)} title={<>{t.name} {!t.active ? <Inactive /> : null}</>} sub={`${formatRp(t.hourlyRate)}/jam${t.requiresPhotographer ? ' · dengan fotografer' : ''}`} />}
      editor={edit ? (
        <EditorSheet open title={edit.id ? 'Ubah jenis' : 'Jenis baru'} onClose={() => setEdit(null)} onSave={save} busy={s.busy} error={s.error}
          canDelete={!!edit.id && !edit.inUse} onDelete={async () => { if (await s.run(() => api.del(`/booking-types/${edit.id}`))) setEdit(null); }}>
          <Field label="Nama" error={s.errors.name}><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
          <Field label="Tarif per jam" error={s.errors.hourlyRate}><MoneyInput value={edit.hourlyRate ?? null} onChange={(v) => setEdit({ ...edit, hourlyRate: v ?? 0 })} /></Field>
          <Toggle label="Butuh fotografer" checked={!!edit.requiresPhotographer} onChange={(v) => setEdit({ ...edit, requiresPhotographer: v })} />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Min jam"><Stepper value={edit.minHours ?? 1} min={1} max={edit.maxHours ?? 8} onChange={(v) => setEdit({ ...edit, minHours: v })} /></Field>
            <Field label="Maks jam" error={s.errors.maxHours}><Stepper value={edit.maxHours ?? 8} min={edit.minHours ?? 1} max={24} onChange={(v) => setEdit({ ...edit, maxHours: v })} /></Field>
          </div>
          <Field label="Kata kunci judul kalender" hint="Judul acara: “<Klien> <kata kunci>”, mis. “Lilin group”"><Input value={edit.calendarKeyword} onChange={(e) => setEdit({ ...edit, calendarKeyword: e.target.value })} /></Field>
          <Toggle label="Aktif" checked={!!edit.active} onChange={(v) => setEdit({ ...edit, active: v })} />
          {edit.inUse ? <p className="text-sm text-muted">Sudah dipakai booking — tidak bisa dihapus, nonaktifkan saja. Tarif baru hanya berlaku untuk booking baru.</p> : null}
        </EditorSheet>
      ) : null} />
  );
}

// ---------- photographers (S11, US-19) ----------
export function AdminPhotographers() {
  const list = usePhotographers();
  const [edit, setEdit] = useState<Partial<Photographer> | null>(null);
  const [future, setFuture] = useState<any[] | null>(null);
  const s = useSave(['photographers']);
  const open = (p?: Photographer) => { s.reset(); setFuture(null); setEdit(p ?? { name: '', phone: '', email: '', defaultFee: null, feeUnit: 'SESSION', active: true }); };
  const save = async (confirm = false) => {
    const body = { ...edit, phone: edit!.phone || null, email: edit!.email || null };
    const ok = await s.run(() => (edit!.id ? api.patch(`/photographers/${edit!.id}${confirm ? '?confirm=true' : ''}`, body) : api.post('/photographers', body)));
    if (ok) { setEdit(null); setFuture(null); }
  };
  if (s.error?.code === 'FUTURE_BOOKINGS' && !future) setFuture(s.error.data.bookings);
  return (
    <MasterPage title="Fotografer" items={list.data} loading={list.isLoading} empty="Belum ada fotografer." onNew={() => open()}
      render={(p) => <RowButton onClick={() => open(p)} title={<>{p.name} {!p.active ? <Inactive /> : null}</>} sub={p.defaultFee != null ? `Fee ${formatRp(p.defaultFee)} / ${p.feeUnit === 'HOUR' ? 'jam' : 'sesi'}` : 'Fee belum diatur'} />}
      editor={edit ? (
        <>
          <EditorSheet open={!future} title={edit.id ? 'Ubah fotografer' : 'Fotografer baru'} onClose={() => setEdit(null)} onSave={() => save()} busy={s.busy} error={s.error}
            canDelete={!!edit.id && !edit.inUse} onDelete={async () => { if (await s.run(() => api.del(`/photographers/${edit.id}`))) setEdit(null); }}>
            <Field label="Nama" error={s.errors.name}><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Telepon (opsional)"><Input type="tel" value={edit.phone ?? ''} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></Field>
            <Field label="Email (opsional)" hint="Untuk undangan kalender di masa depan" error={s.errors.email}><Input type="email" value={edit.email ?? ''} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></Field>
            <Field label="Fee default"><MoneyInput value={edit.defaultFee ?? null} onChange={(v) => setEdit({ ...edit, defaultFee: v })} /></Field>
            <div className="flex gap-2">
              <Chip active={edit.feeUnit === 'SESSION'} onClick={() => setEdit({ ...edit, feeUnit: 'SESSION' })}>Per sesi</Chip>
              <Chip active={edit.feeUnit === 'HOUR'} onClick={() => setEdit({ ...edit, feeUnit: 'HOUR' })}>Per jam</Chip>
            </div>
            <Toggle label="Aktif" checked={!!edit.active} onChange={(v) => setEdit({ ...edit, active: v })} />
          </EditorSheet>
          <Confirm open={!!future} title="Masih ada booking mendatang" confirmLabel="Tetap nonaktifkan" tone="danger" busy={s.busy}
            onClose={() => { setFuture(null); s.reset(); }} onConfirm={() => save(true)}>
            <p>{edit.name} masih dijadwalkan di booking berikut. Ganti fotografernya di booking tersebut, atau tetap nonaktifkan.</p>
            <ul className="text-sm space-y-1">
              {future?.map((b) => <li key={b.id}><Link className="text-accent-text" to={`/bookings/${b.id}`}>{b.bookingNo}</Link> · {b.clientNameSnap} · {longDateId(b.startAt)} {wibTime(b.startAt)}</li>)}
            </ul>
          </Confirm>
        </>
      ) : null} />
  );
}

// ---------- add-ons (S12, US-20) ----------
export function AdminAddons() {
  const list = useAddons();
  const types = useTypes();
  const [edit, setEdit] = useState<Partial<Addon> | null>(null);
  const s = useSave(['addons']);
  const open = (a?: Addon) => { s.reset(); setEdit(a ?? { name: '', price: 0, unit: 'BOOKING', typeIds: [], vendorFee: null, vendorName: '', active: true, sortOrder: (list.data?.length ?? 0) + 1 }); };
  const save = async () => {
    const body = { ...edit, vendorName: edit!.vendorName || null };
    if (await s.run(() => (edit!.id ? api.patch(`/addons/${edit!.id}`, body) : api.post('/addons', body)))) setEdit(null);
  };
  const typeName = (id: string) => types.data?.find((t) => t.id === id)?.name ?? '';
  return (
    <MasterPage title="Add-on" items={list.data} loading={list.isLoading} empty="Belum ada add-on." onNew={() => open()}
      render={(a) => <RowButton onClick={() => open(a)} title={<>{a.name} {!a.active ? <Inactive /> : null}</>} sub={`${formatRp(a.price)} ${UNIT_LABEL[a.unit]} · ${a.typeIds.map(typeName).join(', ')}`} />}
      editor={edit ? (
        <EditorSheet open title={edit.id ? 'Ubah add-on' : 'Add-on baru'} onClose={() => setEdit(null)} onSave={save} busy={s.busy} error={s.error}
          canDelete={!!edit.id && !edit.inUse} onDelete={async () => { if (await s.run(() => api.del(`/addons/${edit.id}`))) setEdit(null); }}>
          <Field label="Nama" error={s.errors.name}><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
          <Field label="Harga" error={s.errors.price}><MoneyInput value={edit.price ?? null} onChange={(v) => setEdit({ ...edit, price: v ?? 0 })} /></Field>
          <Field label="Satuan harga">
            <div className="flex flex-wrap gap-2">
              {(['HOUR', 'BOOKING', 'PERSON'] as const).map((u) => <Chip key={u} active={edit.unit === u} onClick={() => setEdit({ ...edit, unit: u })}>{UNIT_LABEL[u].replace('/ ', 'Per ')}</Chip>)}
            </div>
          </Field>
          <Field label="Berlaku untuk" error={s.errors.typeIds}>
            <div className="flex flex-wrap gap-2">
              {types.data?.map((t) => (
                <Chip key={t.id} active={edit.typeIds?.includes(t.id)}
                  onClick={() => setEdit({ ...edit, typeIds: edit.typeIds?.includes(t.id) ? edit.typeIds.filter((x) => x !== t.id) : [...(edit.typeIds ?? []), t.id] })}>{t.name}</Chip>
              ))}
            </div>
          </Field>
          <Field label="Fee vendor (opsional)" hint="Mis. fee MUA — membuat draft biaya saat booking selesai"><MoneyInput value={edit.vendorFee ?? null} onChange={(v) => setEdit({ ...edit, vendorFee: v })} /></Field>
          {edit.vendorFee ? <Field label="Nama vendor"><Input value={edit.vendorName ?? ''} onChange={(e) => setEdit({ ...edit, vendorName: e.target.value })} /></Field> : null}
          <Toggle label="Aktif" checked={!!edit.active} onChange={(v) => setEdit({ ...edit, active: v })} />
        </EditorSheet>
      ) : null} />
  );
}

// ---------- expense categories (S19, US-25) ----------
export function AdminCategories() {
  const list = useCategories();
  const [edit, setEdit] = useState<Partial<Category> | null>(null);
  const s = useSave(['expense-categories']);
  const open = (c?: Category) => { s.reset(); setEdit(c ?? { name: '', kind: 'VARIABLE', recurring: false, defaultAmount: null, active: true, sortOrder: (list.data?.length ?? 0) + 1 }); };
  const save = async () => {
    if (await s.run(() => (edit!.id ? api.patch(`/expense-categories/${edit!.id}`, edit) : api.post('/expense-categories', edit)))) setEdit(null);
  };
  return (
    <MasterPage title="Kategori pengeluaran" items={list.data} loading={list.isLoading} empty="Belum ada kategori." onNew={() => open()}
      render={(c) => <RowButton onClick={() => open(c)} title={<>{c.name} {!c.active ? <Inactive /> : null}</>}
        sub={`${c.kind === 'FIXED' ? 'Tetap' : 'Variabel'}${c.recurring ? ` · berulang ${c.defaultAmount != null ? formatRp(c.defaultAmount) : ''}` : ''}`} />}
      editor={edit ? (
        <EditorSheet open title={edit.id ? 'Ubah kategori' : 'Kategori baru'} onClose={() => setEdit(null)} onSave={save} busy={s.busy} error={s.error}
          canDelete={!!edit.id && !edit.inUse && !edit.code} onDelete={async () => { if (await s.run(() => api.del(`/expense-categories/${edit.id}`))) setEdit(null); }}>
          <Field label="Nama" error={s.errors.name}><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
          <div className="flex gap-2">
            <Chip active={edit.kind === 'VARIABLE'} onClick={() => setEdit({ ...edit, kind: 'VARIABLE' })}>Variabel (per sesi)</Chip>
            <Chip active={edit.kind === 'FIXED'} onClick={() => setEdit({ ...edit, kind: 'FIXED' })}>Tetap (bulanan)</Chip>
          </div>
          <Toggle label="Berulang tiap bulan (draft tgl 1)" checked={!!edit.recurring} onChange={(v) => setEdit({ ...edit, recurring: v })} />
          {edit.recurring ? <Field label="Jumlah default"><MoneyInput value={edit.defaultAmount ?? null} onChange={(v) => setEdit({ ...edit, defaultAmount: v })} /></Field> : null}
          <Toggle label="Aktif" checked={!!edit.active} onChange={(v) => setEdit({ ...edit, active: v })} />
          {edit.code ? <p className="text-sm text-muted">Kategori sistem — dipakai untuk draft fee otomatis.</p> : null}
        </EditorSheet>
      ) : null} />
  );
}

// ---------- users (FR-16 Staff role) ----------
export function AdminUsers() {
  const { user: me } = useAuth();
  const list = useQuery({ queryKey: ['users'], queryFn: () => api.get<any[]>('/users') });
  const [edit, setEdit] = useState<any | null>(null);
  const s = useSave(['users']);
  const open = (u?: any) => { s.reset(); setEdit(u ? { ...u, password: '' } : { name: '', email: '', password: '', role: 'STAFF', active: true }); };
  const save = async () => {
    const body = { ...edit, password: edit.password || undefined };
    if (await s.run(() => (edit.id ? api.patch(`/users/${edit.id}`, body) : api.post('/users', body)))) setEdit(null);
  };
  return (
    <MasterPage title="Pengguna" items={list.data} loading={list.isLoading} empty="Belum ada pengguna." onNew={() => open()}
      render={(u) => <RowButton onClick={() => open(u)} title={<>{u.name} {!u.active ? <Inactive /> : null}</>} sub={`${u.email} · ${u.role === 'OWNER' ? 'Owner' : 'Staf'}`} />}
      editor={edit ? (
        <EditorSheet open title={edit.id ? 'Ubah pengguna' : 'Pengguna baru'} onClose={() => setEdit(null)} onSave={save} busy={s.busy} error={s.error}>
          <Field label="Nama" error={s.errors.name}><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
          <Field label="Email" error={s.errors.email}><Input type="email" value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></Field>
          <Field label={edit.id ? 'Kata sandi baru (kosongkan bila tetap)' : 'Kata sandi'} error={s.errors.password}>
            <Input type="password" autoComplete="new-password" value={edit.password} onChange={(e) => setEdit({ ...edit, password: e.target.value })} />
          </Field>
          <div className="flex gap-2">
            <Chip active={edit.role === 'STAFF'} disabled={edit.id === me?.id} onClick={() => setEdit({ ...edit, role: 'STAFF' })}>Staf</Chip>
            <Chip active={edit.role === 'OWNER'} onClick={() => setEdit({ ...edit, role: 'OWNER' })}>Owner</Chip>
          </div>
          {edit.id !== me?.id ? <Toggle label="Aktif" checked={edit.active} onChange={(v) => setEdit({ ...edit, active: v })} /> : null}
          <p className="text-sm text-muted">Staf hanya bisa membuat dan mengirim booking — tanpa Admin, Keuangan, atau penyesuaian harga.</p>
        </EditorSheet>
      ) : null} />
  );
}
