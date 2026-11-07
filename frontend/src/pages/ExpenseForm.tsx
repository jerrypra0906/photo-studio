import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { wibDate } from '@jes/shared';
import { ApiError, api } from '../api';
import { useCategories } from '../hooks';
import { Banner, BottomBar, Button, Chip, Confirm, Field, Input, MoneyInput, Page, PageHeader, Spinner, StatusBadge, inputCls, useToast } from '../ui';

/** S16 Add / edit expense — record a cost in ≤ 30 s (L2-4.1). */
export default function ExpenseForm() {
  const { id } = useParams();
  const editing = !!id;
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const cats = useCategories();
  const existing = useQuery({ queryKey: ['expense', id], queryFn: () => api.get(`/expenses/${id}`), enabled: editing });
  const today = wibDate(new Date());

  const [categoryId, setCategoryId] = useState('');
  const [amount, setAmount] = useState<number | null>(null);
  const [paidOn, setPaidOn] = useState(today);
  const [payee, setPayee] = useState('');
  const [note, setNote] = useState('');
  const [booking, setBooking] = useState<{ id: string; bookingNo: string; clientNameSnap: string } | null>(null);
  const [bookingQ, setBookingQ] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dup, setDup] = useState(false);
  const [del, setDel] = useState(false);
  const loaded = useRef(false);

  useEffect(() => {
    const e = existing.data;
    if (!e || loaded.current) return;
    loaded.current = true;
    setCategoryId(e.categoryId); setAmount(e.amount); setPaidOn(e.paidOn); setPayee(e.payee ?? ''); setNote(e.note ?? '');
    if (e.bookingId) setBooking({ id: e.bookingId, bookingNo: e.bookingNo, clientNameSnap: '' });
  }, [existing.data]);

  const bookingSearch = useQuery({
    queryKey: ['bookings', 'pick', bookingQ],
    queryFn: () => api.get(`/bookings?q=${encodeURIComponent(bookingQ)}`),
    enabled: bookingQ.trim().length >= 2,
  });

  // chips: most used first (L2-4.1.2)
  const chips = (cats.data ?? []).filter((c) => c.active || c.id === categoryId).sort((a, b) => b.recentUses - a.recentUses || a.sortOrder - b.sortOrder);

  const save = async (force = false) => {
    setBusy(true);
    setFormError('');
    setErrors({});
    const body = { categoryId, amount: amount ?? 0, paidOn, payee: payee || null, note: note || null, bookingId: booking?.id ?? null, force };
    try {
      const e = editing ? await api.patch(`/expenses/${id}`, body) : await api.post('/expenses', body);
      if (file) {
        const fd = new FormData();
        fd.append('file', file);
        await api.post(`/expenses/${e.id}/receipt`, fd).catch((err) => toast(`Bukti gagal diunggah: ${(err as ApiError).message}`, 'bad'));
      }
      qc.invalidateQueries({ queryKey: ['expenses'] });
      qc.invalidateQueries({ queryKey: ['recap'] });
      qc.invalidateQueries({ queryKey: ['booking'] });
      toast('Pengeluaran disimpan');
      nav(-1);
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === 'DUPLICATE_SUSPECT') setDup(true);
        else { setErrors(e.fields); setFormError(e.message); }
      }
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    try {
      await api.del(`/expenses/${id}`);
      qc.invalidateQueries({ queryKey: ['expenses'] });
      qc.invalidateQueries({ queryKey: ['recap'] });
      toast('Pengeluaran dihapus');
      nav(-1);
    } catch (e) { setFormError((e as ApiError).message); setDel(false); }
  };

  if (cats.isLoading || (editing && existing.isLoading)) return (<><PageHeader title="Pengeluaran" back /><Spinner /></>);
  const amountError = errors.amount || (amount != null && amount <= 0 ? 'Masukkan jumlah di atas Rp0' : '');
  const valid = !!categoryId && amount != null && amount > 0 && paidOn <= today;

  return (
    <>
      <PageHeader title={editing ? 'Ubah pengeluaran' : 'Pengeluaran baru'} back
        action={editing ? <button className="text-bad text-sm font-medium px-2 min-h-11" onClick={() => setDel(true)}>Hapus</button> : undefined} />
      <Page className="pb-28">
        {formError ? <Banner tone="bad">{formError}</Banner> : null}
        {existing.data?.status === 'DRAFT' ? <Banner tone="warn">Draft — menyimpan akan mengonfirmasi biaya ini. <StatusBadge status="DRAFT" /></Banner> : null}
        <Field label="Kategori" error={errors.categoryId}>
          <div className="flex flex-wrap gap-2">
            {chips.map((c) => <Chip key={c.id} active={categoryId === c.id} onClick={() => { setCategoryId(c.id); if (amount == null && c.defaultAmount) setAmount(c.defaultAmount); }}>{c.name}</Chip>)}
          </div>
        </Field>
        <Field label="Jumlah" htmlFor="amt" error={amountError}>
          <MoneyInput id="amt" value={amount} onChange={setAmount} invalid={!!amountError} />
        </Field>
        <Field label="Tanggal dibayar" htmlFor="paidOn" error={errors.paidOn || (paidOn > today ? 'Tanggal tidak boleh di masa depan' : '')}>
          <input id="paidOn" type="date" max={today} className={inputCls} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
        </Field>
        <Field label="Dibayar ke (opsional)" htmlFor="payee"><Input id="payee" placeholder="mis. PLN, Biznet, Hamja" value={payee} onChange={(e) => setPayee(e.target.value)} /></Field>
        <Field label="Catatan (opsional)" htmlFor="note"><Input id="note" value={note} onChange={(e) => setNote(e.target.value)} /></Field>

        <Field label="Kaitkan ke booking (opsional)">
          {booking ? (
            <div className="flex items-center gap-2 rounded-2xl border border-line glass px-4 min-h-11">
              <Link to={`/bookings/${booking.id}`} className="flex-1 text-accent-text">{booking.bookingNo} {booking.clientNameSnap}</Link>
              <button className="text-muted min-h-11 px-2" onClick={() => setBooking(null)} aria-label="Lepaskan booking">✕</button>
            </div>
          ) : (
            <>
              <Input placeholder="Cari nama klien atau no. booking" value={bookingQ} onChange={(e) => setBookingQ(e.target.value)} />
              {bookingSearch.data?.slice(0, 6).map((b: any) => (
                <button key={b.id} className="w-full text-left text-sm px-3 min-h-11 border-b border-line" onClick={() => { setBooking(b); setBookingQ(''); }}>
                  {b.bookingNo} · {b.clientNameSnap}
                </button>
              ))}
            </>
          )}
        </Field>

        <Field label="Foto bukti (opsional)" hint="JPG, PNG atau PDF, maks 5 MB">
          <input type="file" accept="image/jpeg,image/png,application/pdf" capture="environment" className="block w-full text-sm file:mr-3 file:min-h-11 file:rounded-xl file:border-0 file:bg-accent-soft file:px-4 file:text-accent-text"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              if (f && f.size > 5 * 1024 * 1024) { setFormError('Ukuran file maksimal 5 MB'); e.target.value = ''; return; }
              setFile(f);
            }} />
          {existing.data?.receiptKey && !file ? <a href="#" className="text-sm text-accent-text" onClick={async (ev) => { ev.preventDefault(); const b = await api.blob(`/expenses/${id}/receipt`); window.open(URL.createObjectURL(b)); }}>Lihat bukti tersimpan</a> : null}
        </Field>
      </Page>
      <BottomBar><Button className="w-full" disabled={!valid} busy={busy} onClick={() => save(false)}>Simpan</Button></BottomBar>

      <Confirm open={dup} title="Sepertinya duplikat" confirmLabel="Tetap simpan" onClose={() => setDup(false)} onConfirm={() => { setDup(false); save(true); }}>
        <p>Sudah ada pengeluaran dengan kategori, jumlah dan tanggal yang sama. Tetap simpan?</p>
      </Confirm>
      <Confirm open={del} title="Hapus pengeluaran?" confirmLabel="Hapus" tone="danger" onClose={() => setDel(false)} onConfirm={remove}>
        <p>Pengeluaran akan hilang dari total, tetapi tetap tercatat di log audit.</p>
      </Confirm>
    </>
  );
}
