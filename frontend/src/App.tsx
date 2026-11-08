import { ReactNode, createContext, useContext, useEffect, useRef, useState } from 'react';
import { BrowserRouter, NavLink, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Role } from '@jes/shared';
import { ApiError, api, refreshSession, setAccessToken, setOnAuthLost } from './api';
import { Button, Empty, Page, PageHeader, Sheet, Spinner, ToastProvider, cx } from './ui';
import Login from './pages/Login';
import Home from './pages/Home';
import Schedule from './pages/Schedule';
import Bookings from './pages/Bookings';
import BookingForm from './pages/BookingForm';
import BookingDetail from './pages/BookingDetail';
import Finance from './pages/Finance';
import Dashboard from './pages/Dashboard';
import Account from './pages/Account';
import ExpenseForm from './pages/ExpenseForm';
import Recap from './pages/Recap';
import { AdminHome, AdminTypes, AdminPhotographers, AdminAddons, AdminCategories, AdminUsers } from './pages/AdminMasters';
import { AdminSettings, AdminTemplates, AdminIntegrations } from './pages/AdminSettings';

export interface User { id: string; name: string; email: string; role: Role }
interface AuthCtx { user: User | null; setUser: (u: User | null) => void; logout: () => Promise<void> }
const Auth = createContext<AuthCtx>(null!);
export const useAuth = () => useContext(Auth);
export const useIsOwner = () => useContext(Auth).user?.role === 'OWNER';

const qc = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 15_000, retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2, refetchOnWindowFocus: true },
  },
});

function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setOnAuthLost(() => { setAccessToken(null); setUser(null); qc.clear(); });
    // US-01.2: the 30-day refresh cookie signs the owner back in silently
    refreshSession().then((u) => setUser(u)).finally(() => setReady(true));
  }, []);
  const logout = async () => {
    await api.post('/auth/logout').catch(() => undefined);
    setAccessToken(null);
    setUser(null);
    qc.clear();
  };
  if (!ready) return <Spinner />;
  return <Auth.Provider value={{ user, setUser, logout }}>{children}</Auth.Provider>;
}

const Icon = {
  home: <path d="M3 11l9-7 9 7v9a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1z" />,
  cal: <><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M3 10h18M8 3v4M16 3v4" /></>,
  list: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
  money: <path d="M4 19V9M10 19V5M16 19v-7M22 19H2" />,
  gear: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" /></>,
};

function Tab({ to, label, icon }: { to: string; label: string; icon: ReactNode }) {
  return (
    <NavLink to={to} end={to === '/'} className={({ isActive }) => cx('w-16 h-[52px] rounded-[26px] flex flex-col items-center justify-center gap-0.5 text-[11px] transition-colors', isActive ? 'bg-accent-soft text-accent-text font-semibold' : 'text-muted font-medium active:bg-accent-soft')}>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{icon}</svg>
      {label}
    </NavLink>
  );
}

/** PRD §8.2: Home · Schedule · + New · Finance · Admin (Owner); Staff gets Bookings instead of Finance/Admin. */
function Shell() {
  const { user } = useAuth();
  const nav = useNavigate();
  const owner = user?.role === 'OWNER';
  const [choose, setChoose] = useState(false);
  const press = useRef<number | undefined>(undefined);
  const long = useRef(false);
  return (
    <div className="min-h-dvh pb-32">
      <Outlet />
      <nav className="fixed inset-x-4 bottom-[calc(1.25rem+env(safe-area-inset-bottom))] z-40" aria-label="Navigasi utama">
        <div className="mx-auto max-w-[448px] h-[68px] px-1.5 flex items-center justify-around rounded-[34px] border border-line-strong bg-nav backdrop-blur-xl shadow-[inset_0_1px_0_var(--color-hi),0_16px_40px_var(--color-shadow)]">
          <Tab to="/" label="Beranda" icon={Icon.home} />
          <Tab to="/schedule" label="Jadwal" icon={Icon.cal} />
          <div className="grid place-items-center">
            <button aria-label="Baru" className="size-14 grid place-items-center rounded-full bg-accent text-accent-ink shadow-[0_0_0_6px_var(--color-accent-soft),0_0_28px_var(--color-glow)] active:scale-95 transition-transform select-none"
              onPointerDown={() => { long.current = false; press.current = window.setTimeout(() => { long.current = true; if (owner) setChoose(true); }, 500); }}
              onPointerUp={() => clearTimeout(press.current)}
              onPointerLeave={() => clearTimeout(press.current)}
              onContextMenu={(e) => e.preventDefault()}
              onClick={() => { if (!long.current) nav('/bookings/new'); }}>
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
            </button>
          </div>
          {owner ? <Tab to="/finance" label="Keuangan" icon={Icon.money} /> : <Tab to="/bookings" label="Booking" icon={Icon.list} />}
          {owner ? <Tab to="/admin" label="Admin" icon={Icon.gear} /> : <Tab to="/me" label="Akun" icon={Icon.gear} />}
        </div>
      </nav>
      <Sheet open={choose} onClose={() => setChoose(false)} title="Buat baru">
        <div className="grid gap-3">
          <Button onClick={() => { setChoose(false); nav('/bookings/new'); }}>Booking baru</Button>
          <Button variant="secondary" onClick={() => { setChoose(false); nav('/finance/expenses/new'); }}>Pengeluaran baru</Button>
        </div>
      </Sheet>
    </div>
  );
}

function RequireAuth() {
  const { user } = useAuth();
  const loc = useLocation();
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  return <Shell />;
}

/** US-02.2: direct Admin/Finance URL as Staff → "no access", nothing loaded. */
function OwnerOnly() {
  const owner = useIsOwner();
  if (!owner) return (<><PageHeader title="Akses ditolak" /><Page><Empty>Anda tidak memiliki akses ke halaman ini.</Empty></Page></>);
  return <Outlet />;
}

export default function App() {
  return (
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <AuthProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route element={<RequireAuth />}>
                <Route index element={<Home />} />
                <Route path="schedule" element={<Schedule />} />
                <Route path="bookings" element={<Bookings />} />
                <Route path="bookings/new" element={<BookingForm />} />
                <Route path="bookings/:id" element={<BookingDetail />} />
                <Route path="bookings/:id/edit" element={<BookingForm />} />
                <Route path="me" element={<Account />} />
                <Route element={<OwnerOnly />}>
                  <Route path="finance" element={<Dashboard />} />
                  <Route path="finance/expenses" element={<Finance />} />
                  <Route path="finance/recap" element={<Recap />} />
                  <Route path="finance/expenses/new" element={<ExpenseForm />} />
                  <Route path="finance/expenses/:id" element={<ExpenseForm />} />
                  <Route path="admin" element={<AdminHome />} />
                  <Route path="admin/types" element={<AdminTypes />} />
                  <Route path="admin/photographers" element={<AdminPhotographers />} />
                  <Route path="admin/addons" element={<AdminAddons />} />
                  <Route path="admin/categories" element={<AdminCategories />} />
                  <Route path="admin/users" element={<AdminUsers />} />
                  <Route path="admin/settings" element={<AdminSettings />} />
                  <Route path="admin/templates" element={<AdminTemplates />} />
                  <Route path="admin/integrations" element={<AdminIntegrations />} />
                </Route>
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
