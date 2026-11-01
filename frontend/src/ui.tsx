import { ReactNode, createContext, useCallback, useContext, useEffect, useState, InputHTMLAttributes, ButtonHTMLAttributes, forwardRef } from 'react';
import { Link } from 'react-router';
import { formatRp, formatThousands, parseAmount } from '@jes/shared';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

/** JES Space logo; the cream variant is used in dark mode. */
export function Logo({ className }: { className?: string }) {
  return (
    <picture>
      <source srcSet="/logo-light.png" media="(prefers-color-scheme: dark)" />
      <img src="/logo.png" alt="JES Space Studio" className={cx('w-auto select-none', className)} draggable={false} />
    </picture>
  );
}

// ---------- buttons ----------
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
const VARIANT: Record<Variant, string> = {
  primary: 'bg-accent text-accent-ink active:opacity-90 disabled:opacity-40',
  secondary: 'bg-surface border border-line text-ink active:bg-sunken disabled:opacity-40',
  ghost: 'text-accent active:bg-accent-soft disabled:opacity-40',
  danger: 'bg-bad text-white active:opacity-90 disabled:opacity-40',
};
export function Button({ variant = 'primary', className, busy, children, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  return (
    <button {...p} disabled={p.disabled || busy}
      className={cx('min-h-11 rounded-xl px-4 font-medium inline-flex items-center justify-center gap-2 transition-colors', VARIANT[variant], className)}>
      {busy ? <span className="size-4 rounded-full border-2 border-current border-t-transparent animate-spin" aria-hidden /> : null}
      {children}
    </button>
  );
}

// ---------- form fields ----------
export function Field({ label, error, hint, children, htmlFor }: { label: string; error?: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-muted">{label}</label>
      {children}
      {error ? <p className="text-sm text-bad" role="alert">{error}</p> : hint ? <p className="text-sm text-muted">{hint}</p> : null}
    </div>
  );
}

export const inputCls = 'w-full min-h-11 rounded-xl border border-line bg-surface px-3 py-2 outline-none focus:border-accent aria-[invalid=true]:border-bad';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(function Input({ invalid, className, ...p }, ref) {
  return <input ref={ref} {...p} aria-invalid={invalid || undefined} className={cx(inputCls, className)} />;
});

/** Rupiah amount with thousands separators while typing (PRD §8.1.6). */
export function MoneyInput({ value, onChange, invalid, allowNegative, id, placeholder }: { value: number | null; onChange: (v: number | null) => void; invalid?: boolean; allowNegative?: boolean; id?: string; placeholder?: string }) {
  const [text, setText] = useState(value == null ? '' : (value < 0 ? '-' : '') + formatThousands(Math.abs(value)));
  useEffect(() => {
    const parsed = parseAmount(text);
    if ((Number.isNaN(parsed) ? null : parsed) !== value) setText(value == null ? '' : (value < 0 ? '-' : '') + formatThousands(Math.abs(value)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <div className="relative">
      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted">Rp</span>
      <input id={id} inputMode={allowNegative ? 'text' : 'numeric'} placeholder={placeholder ?? '0'} aria-invalid={invalid || undefined}
        className={cx(inputCls, 'pl-10 tabular text-right')} value={text}
        onChange={(e) => {
          let raw = e.target.value;
          if (!allowNegative) raw = raw.replace(/[-−]/g, '');
          const n = parseAmount(raw);
          const neg = allowNegative && /^\s*[-−]/.test(raw);
          setText(Number.isNaN(n) ? (neg ? '-' : '') : (n < 0 ? '-' : '') + formatThousands(Math.abs(n)));
          onChange(Number.isNaN(n) ? null : n);
        }} />
    </div>
  );
}

export function Stepper({ value, min, max, onChange, suffix, maxHint }: { value: number; min: number; max: number; onChange: (v: number) => void; suffix?: string; maxHint?: string }) {
  return (
    <div>
      <div className="inline-flex items-center rounded-xl border border-line bg-surface">
        <button type="button" aria-label="Kurangi" className="size-11 text-xl disabled:opacity-30" disabled={value <= min} onClick={() => onChange(value - 1)}>−</button>
        <span className="min-w-16 text-center font-semibold tabular">{value}{suffix ? ` ${suffix}` : ''}</span>
        <button type="button" aria-label="Tambah" className="size-11 text-xl disabled:opacity-30" disabled={value >= max} onClick={() => onChange(value + 1)}>+</button>
      </div>
      {value >= max && maxHint ? <p className="text-xs text-muted mt-1">{maxHint}</p> : null}
    </div>
  );
}

export function Chip({ active, disabled, onClick, children, className }: { active?: boolean; disabled?: boolean; onClick?: () => void; children: ReactNode; className?: string }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} aria-pressed={active}
      className={cx('min-h-11 rounded-full border px-4 text-sm font-medium whitespace-nowrap transition-colors',
        active ? 'border-accent bg-accent text-accent-ink' : 'border-line bg-surface', disabled && 'opacity-40 line-through', className)}>
      {children}
    </button>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex items-center justify-between gap-3 min-h-11 cursor-pointer">
      <span>{label}</span>
      <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
        className={cx('relative h-7 w-12 rounded-full transition-colors shrink-0', checked ? 'bg-accent' : 'bg-line')}>
        <span className={cx('absolute top-0.5 size-6 rounded-full bg-white shadow transition-all', checked ? 'left-[22px]' : 'left-0.5')} />
      </button>
    </label>
  );
}

// ---------- layout ----------
export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('rounded-2xl bg-surface border border-line p-4', className)}>{children}</div>;
}

export function PageHeader({ title, back, action }: { title: string; back?: string | boolean; action?: ReactNode }) {
  return (
    <header className="sticky top-0 z-20 bg-bg/95 backdrop-blur border-b border-line">
      <div className="mx-auto max-w-[480px] flex items-center gap-2 px-4 h-14">
        {back ? (
          <Link to={typeof back === 'string' ? back : '..'} className="-ml-2 size-11 grid place-items-center rounded-full active:bg-sunken" aria-label="Kembali"
            onClick={(e) => { if (back === true) { e.preventDefault(); history.back(); } }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6" /></svg>
          </Link>
        ) : null}
        <h1 className="text-lg font-semibold flex-1 truncate">{title}</h1>
        {action}
      </div>
    </header>
  );
}

export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <main className={cx('mx-auto max-w-[480px] px-4 py-4 space-y-4', className)}>{children}</main>;
}

/** Sticky bottom action bar sitting above the tab bar (PRD §8.1.1 thumb zone). */
export function BottomBar({ children, withNav = true }: { children: ReactNode; withNav?: boolean }) {
  return (
    <div className={cx('fixed inset-x-0 z-30 border-t border-line bg-surface/95 backdrop-blur', withNav ? 'bottom-16' : 'bottom-0 safe-bottom')}>
      <div className="mx-auto max-w-[480px] px-4 py-3">{children}</div>
    </div>
  );
}

export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-line p-6 text-center text-muted space-y-3">
      <p>{children}</p>
      {action}
    </div>
  );
}

export function Banner({ tone = 'warn', children, action }: { tone?: 'warn' | 'bad' | 'ok' | 'info'; children: ReactNode; action?: ReactNode }) {
  const t = { warn: 'bg-warn-soft text-warn', bad: 'bg-bad-soft text-bad', ok: 'bg-ok-soft text-ok', info: 'bg-accent-soft text-accent' }[tone];
  return (
    <div className={cx('rounded-xl px-4 py-3 text-sm flex items-center gap-3', t)} role="status">
      <div className="flex-1">{children}</div>
      {action}
    </div>
  );
}

export function Money({ value, className, sign }: { value: number; className?: string; sign?: boolean }) {
  return <span className={cx('tabular', className)}>{sign && value > 0 ? '+' : ''}{formatRp(value)}</span>;
}

export function Spinner() {
  return <div className="py-10 grid place-items-center"><span className="size-6 rounded-full border-2 border-accent border-t-transparent animate-spin" aria-label="Memuat" /></div>;
}

// ---------- status badges ----------
const STATUS: Record<string, [string, string]> = {
  CONFIRMED: ['Terkonfirmasi', 'bg-accent-soft text-accent'],
  COMPLETED: ['Selesai', 'bg-ok-soft text-ok'],
  CANCELLED: ['Dibatalkan', 'bg-sunken text-muted line-through'],
  DRAFT: ['Draft', 'bg-warn-soft text-warn'],
};
export function StatusBadge({ status }: { status: string }) {
  const [l, c] = STATUS[status] ?? [status, 'bg-sunken text-muted'];
  return <span className={cx('rounded-full px-2.5 py-0.5 text-xs font-medium', c)}>{l}</span>;
}

const PAY: Record<string, [string, string]> = {
  UNPAID: ['Belum bayar', 'bg-bad-soft text-bad'],
  DP_PAID: ['DP', 'bg-warn-soft text-warn'],
  PAID: ['Lunas', 'bg-ok-soft text-ok'],
};
export function PayBadge({ total, paid }: { total: number; paid: number }) {
  const k = paid <= 0 ? 'UNPAID' : paid >= total ? 'PAID' : 'DP_PAID';
  const [l, c] = PAY[k];
  return <span className={cx('rounded-full px-2.5 py-0.5 text-xs font-medium', c)}>{l}</span>;
}

// ---------- sheet (bottom drawer) ----------
export function Sheet({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', k);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', k); document.body.style.overflow = ''; };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" role="dialog" aria-modal aria-label={title}>
      <button className="absolute inset-0 bg-black/40" aria-label="Tutup" onClick={onClose} />
      <div className="relative w-full max-w-[480px] max-h-[92dvh] flex flex-col rounded-t-3xl bg-bg safe-bottom">
        <div className="flex items-center gap-2 px-4 pt-3 pb-2 border-b border-line">
          <h2 className="font-semibold flex-1">{title}</h2>
          <button onClick={onClose} className="size-11 grid place-items-center rounded-full active:bg-sunken" aria-label="Tutup">✕</button>
        </div>
        <div className="overflow-y-auto px-4 py-4 space-y-4 flex-1">{children}</div>
        {footer ? <div className="border-t border-line px-4 py-3">{footer}</div> : null}
      </div>
    </div>
  );
}

// ---------- toast ----------
const ToastCtx = createContext<(msg: string, tone?: 'ok' | 'bad') => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [t, setT] = useState<{ msg: string; tone: 'ok' | 'bad'; id: number } | null>(null);
  const show = useCallback((msg: string, tone: 'ok' | 'bad' = 'ok') => setT({ msg, tone, id: Date.now() }), []);
  useEffect(() => {
    if (!t) return;
    const h = setTimeout(() => setT(null), 2600);
    return () => clearTimeout(h);
  }, [t]);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {t ? (
        <div className="fixed inset-x-0 top-4 z-[60] flex justify-center px-4 pointer-events-none" role="status" aria-live="polite">
          <div className={cx('rounded-full px-4 py-2 text-sm font-medium shadow-lg', t.tone === 'ok' ? 'bg-ink text-bg' : 'bg-bad text-white')}>{t.msg}</div>
        </div>
      ) : null}
    </ToastCtx.Provider>
  );
}

// ---------- confirm dialog ----------
export function Confirm({ open, title, children, confirmLabel = 'Ya', tone = 'primary', onConfirm, onClose, busy }: {
  open: boolean; title: string; children?: ReactNode; confirmLabel?: string; tone?: Variant; onConfirm: () => void; onClose: () => void; busy?: boolean;
}) {
  return (
    <Sheet open={open} onClose={onClose} title={title}
      footer={<div className="grid grid-cols-2 gap-3"><Button variant="secondary" onClick={onClose}>Kembali</Button><Button variant={tone} onClick={onConfirm} busy={busy}>{confirmLabel}</Button></div>}>
      {children}
    </Sheet>
  );
}
