import { FormEvent, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { ApiError, api, setAccessToken } from '../api';
import { useAuth } from '../App';
import { Banner, Button, Field, Input, Logo } from '../ui';

export default function Login() {
  const { user, setUser } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (user) return <Navigate to="/" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api.post('/auth/login', { email, password });
      setAccessToken(r.accessToken);
      setUser(r.user);
      nav((loc.state as any)?.from ?? '/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Gagal masuk');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-dvh grid place-items-center px-6 py-10">
      <form onSubmit={submit} className="w-full max-w-[400px] space-y-5">
        <div className="flex flex-col items-center gap-7 pb-4 text-center">
          <div className="relative size-40 grid place-items-center">
            <div aria-hidden className="absolute inset-0 rounded-full border border-dashed border-line-strong motion-safe:animate-[spin_40s_linear_infinite]" />
            <div aria-hidden className="absolute inset-4 rounded-full border border-line" />
            <div className="size-28 rounded-full glass border border-line-strong grid place-items-center shadow-[inset_0_1px_0_var(--color-hi),0_0_40px_var(--color-glow)]">
              <h1><Logo className="h-8" /></h1>
            </div>
          </div>
          <div className="space-y-2">
            <p className="hud text-muted tracking-[0.18em]">Studio booking</p>
            <p className="font-display text-[30px] font-semibold tracking-tight leading-tight">Selamat datang</p>
            <p className="text-muted">Masuk untuk mengelola booking studio</p>
          </div>
        </div>
        {error ? <Banner tone="bad">{error}</Banner> : null}
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Kata sandi" htmlFor="pw">
          <div className="relative">
            <Input id="pw" type={show ? 'text' : 'password'} autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className="pr-20" />
            <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-sm font-medium text-accent-text px-2 min-h-11" onClick={() => setShow(!show)}>{show ? 'Sembunyikan' : 'Tampilkan'}</button>
          </div>
        </Field>
        <Button type="submit" className="w-full min-h-14 text-base" busy={busy}>Masuk</Button>
      </form>
    </main>
  );
}
