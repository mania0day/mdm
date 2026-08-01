// Small shared presentational helpers used across pages.
import { useEffect, useRef, useState } from 'react';

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
