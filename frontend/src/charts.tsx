import { ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { formatRpCompact } from '@jes/shared';
import { cx } from './ui';

/*
 * Small SVG chart kit for the owner dashboard (dataviz mark specs):
 * columns ≤ 24px with a 4px rounded data-end and square baseline, 2px gap between grouped columns,
 * hairline solid gridlines, one y-axis, compact ticks, text in text tokens (never the series colour),
 * and a hover/tap tooltip per column group. Colours come from the --color-chart-* tokens.
 */

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    if (!ref.current) return;
    // measure now; the observer's first callback can be delayed in background/throttled tabs
    setW(Math.floor(ref.current.getBoundingClientRect().width));
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** Clean tick values spanning [min, max] with ~4 steps of 1/2/2.5/5 × 10^k. */
function niceTicks(min: number, max: number, target = 4) {
  if (min === max) max = min + 1;
  const raw = (max - min) / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw)!;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v));
  return ticks;
}

/** Column path: rounded 4px corners at the data end only, square on the baseline. */
function columnPath(x: number, w: number, y0: number, y1: number) {
  const up = y1 < y0;
  const h = Math.abs(y1 - y0);
  if (h < 0.5) return '';
  const r = Math.min(4, w / 2, h);
  if (up) {
    return `M${x},${y0} V${y1 + r} Q${x},${y1} ${x + r},${y1} H${x + w - r} Q${x + w},${y1} ${x + w},${y1 + r} V${y0} Z`;
  }
  return `M${x},${y0} V${y1 - r} Q${x},${y1} ${x + r},${y1} H${x + w - r} Q${x + w},${y1} ${x + w},${y1 - r} V${y0} Z`;
}

export interface Series { name: string; color: string; negativeColor?: string }
export interface ColumnRow { key: string; label: string; values: number[]; muted?: boolean; tooltip: ReactNode }

export function ColumnChart({
  rows, series, height = 200, reference, labels, ariaLabel, onSelect,
}: {
  rows: ColumnRow[]; series: Series[]; height?: number; ariaLabel: string;
  /** a thin labelled reference line, e.g. the average */
  reference?: { value: number; label: string };
  /** selective direct labels: row key → text shown at that column's data end */
  labels?: Record<string, string>;
  /** tapping a column also selects that row (e.g. switch the page to that month) */
  onSelect?: (key: string) => void;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const M = { top: 18, right: 6, bottom: 22, left: 46 };
  const plotW = Math.max(0, width - M.left - M.right);
  const plotH = height - M.top - M.bottom;
  const all = rows.flatMap((r) => r.values);
  const ticks = niceTicks(Math.min(0, ...all, reference?.value ?? 0), Math.max(0, ...all, reference?.value ?? 0));
  const lo = ticks[0], hi = ticks.at(-1)!;
  const y = (v: number) => M.top + plotH - ((v - lo) / (hi - lo)) * plotH;
  const band = rows.length ? plotW / rows.length : 0;
  const n = series.length;
  const barW = Math.max(3, Math.min(24, (band * 0.72 - (n - 1) * 2) / n));
  const groupW = n * barW + (n - 1) * 2;
  const every = band >= 30 ? 1 : band >= 16 ? 2 : 3;

  useEffect(() => {
    if (active === null) return;
    const close = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setActive(null); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [active, ref]);

  const tipLeft = active === null ? 0 : Math.min(Math.max(M.left + band * active + band / 2, 90), width - 90);

  return (
    <div ref={ref} className="relative select-none">
      {width > 0 ? (
        <svg width={width} height={height} role="group" aria-label={ariaLabel} className="block overflow-visible">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.left} x2={width - M.right} y1={y(t)} y2={y(t)} stroke={t === 0 ? 'var(--color-chart-axis)' : 'var(--color-chart-grid)'} strokeWidth={1} shapeRendering="crispEdges" />
              <text x={M.left - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted tabular" fontSize={10}>{formatRpCompact(t).replace('Rp', '')}</text>
            </g>
          ))}
          {active !== null ? <rect x={M.left + band * active} y={M.top - 4} width={band} height={plotH + 4} rx={6} className="fill-sunken" /> : null}
          {rows.map((r, i) => {
            const gx = M.left + band * i + (band - groupW) / 2;
            return (
              <g key={r.key} opacity={r.muted ? 0.45 : 1}>
                {r.values.map((v, s) => (
                  <path key={s} d={columnPath(gx + s * (barW + 2), barW, y(0), y(v))}
                    fill={v < 0 && series[s].negativeColor ? series[s].negativeColor : series[s].color} />
                ))}
                {labels?.[r.key] ? (
                  <text x={gx + groupW / 2} y={r.values[0] < 0 ? y(r.values[0]) + 12 : y(Math.max(...r.values)) - 5} textAnchor="middle" fontSize={10} className="fill-ink font-medium tabular">
                    {labels[r.key]}
                  </text>
                ) : null}
                {i % every === 0 || i === rows.length - 1 ? (
                  <text x={M.left + band * i + band / 2} y={height - 6} textAnchor="middle" fontSize={10} className={cx('fill-muted', r.muted && 'italic')}>{r.label}</text>
                ) : null}
              </g>
            );
          })}
          {reference ? (
            <g>
              <line x1={M.left} x2={width - M.right} y1={y(reference.value)} y2={y(reference.value)} stroke="var(--color-muted)" strokeWidth={1} strokeOpacity={0.6} shapeRendering="crispEdges" />
              {reference.label ? <text x={width - M.right} y={y(reference.value) - 4} textAnchor="end" fontSize={10} className="fill-muted">{reference.label}</text> : null}
            </g>
          ) : null}
          {/* hit targets: the whole column band, larger than the marks */}
          {rows.map((r, i) => (
            <rect key={r.key} x={M.left + band * i} y={M.top - 4} width={band} height={plotH + M.bottom} fill="transparent" tabIndex={0}
              role="button" aria-label={`${r.label}: lihat detail`} className="outline-none cursor-pointer"
              onPointerEnter={(e) => e.pointerType === 'mouse' && setActive(i)}
              onPointerLeave={(e) => e.pointerType === 'mouse' && setActive(null)}
              onClick={() => { setActive(i); onSelect?.(r.key); }}
              onFocus={() => setActive(i)} onBlur={() => setActive(null)} />
          ))}
        </svg>
      ) : <div style={{ height }} />}
      {active !== null && rows[active] ? (
        <div className="pointer-events-none absolute z-10 rounded-xl border border-line bg-surface px-3 py-2 text-xs shadow-lg min-w-40"
          style={{ left: tipLeft, top: -6, transform: 'translate(-50%, -100%)' }} role="status">
          {rows[active].tooltip}
        </div>
      ) : null}
    </div>
  );
}

/** Legend for ≥ 2 series: swatch beside text-token label (identity is never colour-alone). */
export function Legend({ items }: { items: { name: string; color: string; shape?: 'square' | 'line' }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      {items.map((it) => (
        <li key={it.name} className="flex items-center gap-1.5">
          <span className={cx('inline-block', it.shape === 'line' ? 'h-0.5 w-4' : 'size-2.5 rounded-sm')} style={{ background: it.color }} aria-hidden />
          {it.name}
        </li>
      ))}
    </ul>
  );
}

/** Stat-tile sparkline: de-emphasised line, current period marked with the accent dot. */
export function Sparkline({ values, color, height = 28 }: { values: number[]; color: string; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  if (values.length < 2) return <div ref={ref} style={{ height }} />;
  const min = Math.min(...values), max = Math.max(...values);
  const pad = 4;
  const x = (i: number) => pad + (i / (values.length - 1)) * (width - pad * 2);
  const y = (v: number) => pad + (max === min ? 0.5 : 1 - (v - min) / (max - min)) * (height - pad * 2);
  const pts = values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
  return (
    <div ref={ref} aria-hidden>
      {width > 0 ? (
        <svg width={width} height={height} className="block overflow-visible">
          <polyline points={pts} fill="none" stroke="var(--color-chart-axis)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={x(values.length - 1)} cy={y(values.at(-1)!)} r={4} fill={color} stroke="var(--color-surface)" strokeWidth={2} />
        </svg>
      ) : <div style={{ height }} />}
    </div>
  );
}

/** Ranked horizontal bars for one measure (single hue = magnitude). Values sit outside the bar, in text ink. */
export function BarList({ items, color, total }: { items: { label: string; value: number }[]; color: string; total: number }) {
  const max = Math.max(1, ...items.map((i) => Math.abs(i.value)));
  return (
    <ul className="space-y-2.5">
      {items.map((it) => (
        <li key={it.label} className="text-sm">
          <div className="flex justify-between gap-3">
            <span className="truncate">{it.label}</span>
            <span className="tabular text-muted shrink-0">{formatRpCompact(it.value)}{total > 0 ? ` · ${Math.round((it.value / total) * 100)}%` : ''}</span>
          </div>
          <div className="mt-1 h-2.5">
            <div className="h-full rounded-r-[4px]" style={{ width: `${Math.max(1, (Math.abs(it.value) / max) * 100)}%`, background: color }} />
          </div>
        </li>
      ))}
    </ul>
  );
}
