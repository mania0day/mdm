// Circular security-posture score indicator. Deliberately restrained: one
// accent color driven by the score itself, no gradients, no decoration.
export default function ScoreRing({ score, size = 140, stroke = 10, label = 'Score' }) {
  const clamped = Math.max(0, Math.min(100, score));
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const offset = circumference - (clamped / 100) * circumference;

  const color = clamped >= 75 ? '#16A34A' : clamped >= 50 ? '#D97706' : '#DC2626';
  const scoreLabel = clamped >= 75 ? 'Healthy' : clamped >= 50 ? 'Needs attention' : 'At risk';

  return (
    <div className="inline-flex flex-col items-center gap-2">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#E5E7EB" strokeWidth={stroke} />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            style={{ transition: 'stroke-dashoffset 0.8s cubic-bezier(0.4,0,0.2,1)' }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-3xl font-bold tabular-nums text-slate-900 dark:text-slate-100">{clamped}</span>
          <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-400 dark:text-slate-500">{label}</span>
        </div>
      </div>
      <span className="text-xs font-medium text-slate-500 dark:text-slate-400">{scoreLabel}</span>
    </div>
  );
}
