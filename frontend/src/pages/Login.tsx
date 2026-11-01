import { FormEvent, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { ApiError, api, setAccessToken } from '../api';
import { useAuth } from '../App';
import { Banner, Button, Field, Input } from '../ui';

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
    <main className="min-h-dvh grid place-items-center px-4">
      <form onSubmit={submit} className="w-full max-w-[400px] space-y-5">
        <div className="text-center space-y-2">
          <img src="/icon.svg" alt="" className="size-16 mx-auto rounded-2xl" />
          <h1 className="text-2xl font-semibold">JES Space Studio</h1>
          <p className="text-muted">Masuk untuk mengelola booking</p>
        </div>
        {error ? <Banner tone="bad">{error}</Banner> : null}
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Kata sandi" htmlFor="pw">
          <div className="relative">
            <Input id="pw" type={show ? 'text' : 'password'} autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className="pr-20" />
            <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-sm text-accent px-2 min-h-11" onClick={() => setShow(!show)}>{show ? 'Sembunyikan' : 'Tampilkan'}</button>
          </div>
        </Field>
        <Button type="submit" className="w-full" busy={busy}>Masuk</Button>
      </form>
    </main>
  );
}
