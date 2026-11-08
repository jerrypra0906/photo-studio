import { FormEvent, useState } from 'react';
import { Link } from 'react-router';
import { ApiError, api, setAccessToken } from '../api';
import { useAuth } from '../App';
import { Banner, Button, Card, Field, Input, Page, PageHeader, useToast } from '../ui';

/** Password rules shown live while typing (the server enforces the same rule). */
export function PasswordHints({ value, email }: { value: string; email?: string }) {
  const rules: [boolean, string][] = [
    [value.length >= 10, 'Minimal 10 karakter'],
    [/[A-Za-z]/.test(value), 'Mengandung huruf'],
    [/\d/.test(value), 'Mengandung angka'],
    ...(email ? [[value.toLowerCase() !== email.toLowerCase(), 'Tidak sama dengan email'] as [boolean, string]] : []),
  ];
  return (
    <ul className="text-xs space-y-0.5" aria-label="Syarat kata sandi">
      {rules.map(([ok, label]) => (
        <li key={label} className={ok ? 'text-ok' : 'text-muted'}>{ok ? '✓' : '○'} {label}</li>
      ))}
    </ul>
  );
}
export const passwordOk = (v: string, email?: string) => v.length >= 10 && /[A-Za-z]/.test(v) && /\d/.test(v) && (!email || v.toLowerCase() !== email.toLowerCase());

/** Akun: every user can change their display name and password; role and email stay Owner-managed. */
export default function Account() {
  const { user, setUser, logout } = useAuth();
  const toast = useToast();
  const [name, setName] = useState(user?.name ?? '');
  const [nameErr, setNameErr] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pwErr, setPwErr] = useState<Record<string, string>>({});
  const [pwBanner, setPwBanner] = useState('');
  const [savingPw, setSavingPw] = useState(false);

  const saveName = async (e: FormEvent) => {
    e.preventDefault();
    setSavingName(true); setNameErr('');
    try {
      const r = await api.patch('/auth/me', { name });
      setAccessToken(r.accessToken); setUser(r.user);
      toast('Nama disimpan');
    } catch (err) {
      setNameErr(err instanceof ApiError ? err.fields.name ?? err.message : 'Gagal menyimpan');
    } finally { setSavingName(false); }
  };

  const savePassword = async (e: FormEvent) => {
    e.preventDefault();
    setPwErr({}); setPwBanner('');
    if (next !== confirm) { setPwErr({ confirm: 'Konfirmasi tidak sama' }); return; }
    setSavingPw(true);
    try {
      const r = await api.post('/auth/password', { currentPassword: cur, newPassword: next });
      setAccessToken(r.accessToken); setUser(r.user);
      setCur(''); setNext(''); setConfirm('');
      toast('Kata sandi diganti — perangkat lain telah dikeluarkan');
    } catch (err) {
      if (err instanceof ApiError) { setPwErr(err.fields); if (!Object.keys(err.fields).length) setPwBanner(err.message); }
    } finally { setSavingPw(false); }
  };

  return (
    <>
      <PageHeader title="Akun saya" back={user?.role === 'OWNER' ? '/admin' : undefined} />
      <Page className="pb-24">
        <Card className="space-y-1">
          <div className="text-sm text-muted">Masuk sebagai</div>
          <div className="font-semibold">{user?.email}</div>
          <div className="text-sm text-muted">{user?.role === 'OWNER' ? 'Owner' : 'Staf'}{user?.role === 'OWNER' ? <> · <Link to="/admin/users" className="text-accent-text underline">kelola pengguna</Link></> : null}</div>
        </Card>

        <form onSubmit={saveName}>
          <Card className="space-y-3">
            <h2 className="font-semibold">Profil</h2>
            <Field label="Nama" htmlFor="acc-name" error={nameErr}>
              <Input id="acc-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} invalid={!!nameErr} />
            </Field>
            <Button type="submit" variant="secondary" className="w-full" busy={savingName} disabled={name.trim().length < 2 || name.trim() === user?.name}>Simpan nama</Button>
          </Card>
        </form>

        <form onSubmit={savePassword}>
          <Card className="space-y-3">
            <h2 className="font-semibold">Ganti kata sandi</h2>
            {pwBanner ? <Banner tone="bad">{pwBanner}</Banner> : null}
            <Field label="Kata sandi saat ini" htmlFor="acc-cur" error={pwErr.currentPassword}>
              <Input id="acc-cur" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} invalid={!!pwErr.currentPassword} />
            </Field>
            <Field label="Kata sandi baru" htmlFor="acc-new" error={pwErr.newPassword}>
              <Input id="acc-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} invalid={!!pwErr.newPassword} />
            </Field>
            <PasswordHints value={next} email={user?.email} />
            <Field label="Ulangi kata sandi baru" htmlFor="acc-confirm" error={pwErr.confirm}>
              <Input id="acc-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} invalid={!!pwErr.confirm} />
            </Field>
            <Button type="submit" className="w-full" busy={savingPw} disabled={!cur || !passwordOk(next, user?.email) || !confirm}>Ganti kata sandi</Button>
            <p className="text-xs text-muted">Setelah diganti, semua perangkat lain otomatis keluar.</p>
          </Card>
        </form>

        <Button variant="secondary" className="w-full" onClick={logout}>Keluar</Button>
      </Page>
    </>
  );
}
