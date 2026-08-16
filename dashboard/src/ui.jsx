// Small shared presentational helpers used across pages.
import { useEffect, useRef, useState } from 'react';

/** Tell the sidebar (and anyone else listening) to re-fetch alert counts now. */
export function notifyAlertsChanged() {
  window.dispatchEvent(new Event('sentroid:alerts-changed'));
}

/**
 * Triggers the browser's native print dialog, which on every modern browser
 * offers "Save as PDF" — this is deliberately not a client-side PDF library:
 * it needs no new dependency, and it renders the live recharts SVG/tables
 * exactly as styled by index.css's @media print rules.
 */
export function PdfButton({ label = 'Download PDF' }) {
  return (
    <button onClick={() => window.print()} className="btn-ghost no-print">
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 9V2h12v7M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2M6 14h12v8H6z" />
      </svg>
      {label}
    </button>
  );
}

/** Letterhead shown only inside the printed/PDF output (hidden on-screen). */
export function PrintHeader({ title, subtitle }) {
  return (
    <div className="print-only mb-6 pb-4 border-b-2 border-slate-800">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-lg font-bold tracking-tight">SENTROID MDM</div>
          <div className="text-sm mt-0.5">{title}</div>
          {subtitle && <div className="text-xs text-slate-500 mt-0.5">{subtitle}</div>}
        </div>
        <div className="text-xs text-slate-500 text-right">
          Generated {new Date().toLocaleString()}
        </div>
      </div>
    </div>
  );
}

/** Count-up animated integer; animates from the previous value on change. */
export function AnimatedNumber({ value }) {
  const [display, setDisplay] = useState(0);
  const fromRef = useRef(0);
  useEffect(() => {
    const from = fromRef.current;
    const to = Number(value) || 0;
    if (from === to) {
      setDisplay(to);
      return;
    }
    let raf;
    const start = performance.now();
    const dur = 800;
    const tick = (t) => {
      const p = Math.min(1, (t - start) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      setDisplay(Math.round(from + (to - from) * e));
      if (p < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = to;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{display}</>;
}

export function StatusBadge({ status }) {
  const map = {
    active: 'bg-accent-100 text-accent-700 ring-1 ring-accent-600/20 dark:bg-accent-500/15 dark:text-accent-300 dark:ring-accent-400/25',
    locked: 'bg-amber-100 text-amber-700 ring-1 ring-amber-600/20 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-400/25',
    disabled: 'bg-slate-100 text-slate-600 ring-1 ring-slate-400/20 dark:bg-slate-700/50 dark:text-slate-300 dark:ring-slate-500/25',
    wipe_pending: 'bg-red-100 text-red-700 ring-1 ring-red-600/20 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-400/25',
    wiped: 'bg-red-100 text-red-700 ring-1 ring-red-600/30 dark:bg-red-500/20 dark:text-red-300 dark:ring-red-400/30',
    pending: 'bg-slate-100 text-slate-600 ring-1 ring-slate-400/20 dark:bg-slate-700/50 dark:text-slate-300 dark:ring-slate-500/25',
    unenrolled: 'bg-orange-100 text-orange-700 ring-1 ring-orange-600/20 dark:bg-orange-500/15 dark:text-orange-300 dark:ring-orange-400/25',
  };
  const fallback = 'bg-slate-100 text-slate-600 ring-1 ring-slate-400/20 dark:bg-slate-700/50 dark:text-slate-300 dark:ring-slate-500/25';
  return (
    <span className={`badge ${map[status] || fallback}`}>
      {String(status || 'unknown').replace('_', ' ')}
    </span>
  );
}

export function ComplianceBadge({ value }) {
  const map = {
    compliant: 'bg-accent-100 text-accent-700 ring-1 ring-accent-600/20 dark:bg-accent-500/15 dark:text-accent-300 dark:ring-accent-400/25',
    non_compliant: 'bg-red-100 text-red-700 ring-1 ring-red-600/20 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-400/25',
    unknown: 'bg-slate-100 text-slate-600 ring-1 ring-slate-400/20 dark:bg-slate-700/50 dark:text-slate-300 dark:ring-slate-500/25',
  };
  return (
    <span className={`badge ${map[value] || map.unknown}`}>
      {String(value || 'unknown').replace('_', '-')}
    </span>
  );
}

const STATUS_DOT_COLOR = {
  active: 'bg-accent-500',
  locked: 'bg-amber-500',
  disabled: 'bg-slate-400',
  wipe_pending: 'bg-red-500',
  wiped: 'bg-red-500',
  pending: 'bg-slate-400',
  unenrolled: 'bg-orange-500',
};

/** Lighter dot+text status indicator for dense tables — the pill badge is reserved for headers/hero contexts. */
export function StatusDot({ status }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-slate-700 dark:text-slate-200">
      <span className={`h-2 w-2 rounded-full shrink-0 ${STATUS_DOT_COLOR[status] || 'bg-slate-400'}`} />
      {String(status || 'unknown').replace('_', ' ')}
    </span>
  );
}

const COMPLIANCE_DOT_COLOR = { compliant: 'bg-accent-500', non_compliant: 'bg-red-500', unknown: 'bg-slate-400' };

export function ComplianceDot({ value }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-slate-700 dark:text-slate-200">
      <span className={`h-2 w-2 rounded-full shrink-0 ${COMPLIANCE_DOT_COLOR[value] || 'bg-slate-400'}`} />
      {String(value || 'unknown').replace('_', '-')}
    </span>
  );
}

export function OnlineDot({ online }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
      <span
        className={`h-2 w-2 rounded-full ${online ? 'bg-accent-500 pulse-dot' : 'bg-slate-300 dark:bg-slate-600'}`}
      />
      {online ? 'Online' : 'Offline'}
    </span>
  );
}

/** Larger, plain-language verdict pill for report headers (vs. the compact table ComplianceBadge). */
export function VerdictPill({ compliant }) {
  const style = compliant
    ? 'bg-accent-50 text-accent-700 border border-accent-200 dark:bg-accent-500/10 dark:text-accent-300 dark:border-accent-500/25'
    : 'bg-red-50 text-red-700 border border-red-200 dark:bg-red-500/10 dark:text-red-300 dark:border-red-500/25';
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-semibold ${style}`}>
      {compliant ? 'Compliant' : 'Non-compliant'}
    </span>
  );
}

export function SeverityBadge({ severity }) {
  const map = {
    info: 'bg-brand-100 text-brand-700 ring-1 ring-brand-600/20 dark:bg-brand-500/15 dark:text-brand-300 dark:ring-brand-400/25',
    warning: 'bg-amber-100 text-amber-700 ring-1 ring-amber-600/20 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-400/25',
    critical: 'bg-red-100 text-red-700 ring-1 ring-red-600/20 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-400/25',
  };
  return <span className={`badge ${map[severity] || map.info}`}>{severity}</span>;
}

export function timeAgo(ts) {
  if (!ts) return 'never';
  const d = new Date(ts.includes('T') ? ts : ts + 'Z');
  const secs = Math.floor((Date.now() - d.getTime()) / 1000);
  if (secs < 0) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

export function Spinner() {
  return (
    <div className="flex items-center justify-center py-20">
      <div className="h-8 w-8 rounded-full border-2 border-slate-200 dark:border-slate-700 border-t-brand-600 dark:border-t-brand-400 animate-spin" />
    </div>
  );
}

export function EmptyState({ children }) {
  return <div className="text-center text-slate-400 py-16">{children}</div>;
}
