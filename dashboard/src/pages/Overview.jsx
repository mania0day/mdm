import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import { motion } from 'framer-motion';
import { api } from '../api';
import { Spinner, StatusBadge, timeAgo, AnimatedNumber } from '../ui.jsx';

const gridStagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06 } },
};
const cardItem = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.45, ease: [0.16, 1, 0.3, 1] } },
};

/** Track whether the app is in dark mode (recharts needs JS colors, not CSS). */
function useIsDark() {
  const [dark, setDark] = useState(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
  );
  useEffect(() => {
    const el = document.documentElement;
    const obs = new MutationObserver(() => setDark(el.classList.contains('dark')));
    obs.observe(el, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

function StatCard({ label, value, sub, accent = 'text-brand-800 dark:text-slate-100' }) {
  return (
    <motion.div variants={cardItem} whileHover={{ y: -2 }} className="card card-hover p-5">
      <div className="text-xs uppercase tracking-wider text-slate-400 dark:text-slate-500">{label}</div>
      <div className={`text-3xl font-bold mt-1 ${accent}`}>
        <AnimatedNumber value={value} />
      </div>
      {sub && <div className="text-xs text-slate-400 dark:text-slate-500 mt-1">{sub}</div>}
    </motion.div>
  );
}

const PIE_COLORS = { compliant: '#16a34a', non_compliant: '#dc2626', unknown: '#64748b' };

export default function Overview() {
  const [stats, setStats] = useState(null);
  const isDark = useIsDark();

  useEffect(() => {
    let live = true;
    const poll = () => api.get('/stats').then((d) => live && setStats(d)).catch(() => {});
    poll();
    const t = setInterval(poll, 8000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  if (!stats) return <Spinner />;

  const tooltipStyle = isDark
    ? { background: '#1e293b', border: '1px solid #334155', borderRadius: 8, color: '#e2e8f0' }
    : { background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 8, color: '#1e293b' };
  const axisColor = isDark ? '#94a3b8' : '#64748b';
  const barFill = isDark ? '#38bdf8' : '#0369a1';
  const cursorFill = isDark ? '#33415566' : '#e2e8f055';

  const complianceData = Object.entries(stats.devices.byCompliance || {}).map(([name, value]) => ({ name, value }));
  const statusData = Object.entries(stats.devices.byStatus || {}).map(([name, value]) => ({
    name: name.replace('_', ' '),
    value,
  }));

  return (
    <motion.div variants={gridStagger} initial="hidden" animate="show" className="space-y-6">
      <motion.div variants={cardItem}>
        <h1 className="h-page">Operations Overview</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">Real-time visibility across all managed devices</p>
      </motion.div>

      <motion.div variants={gridStagger} className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Managed Devices"
          value={stats.devices.total}
          sub={`${stats.devices.online} online · ${stats.devices.offline} offline`}
        />
        <StatCard
          label="Online Now"
          value={stats.devices.online}
          accent="text-accent-600 dark:text-accent-400"
          sub="checked in recently"
        />
        <StatCard
          label="Pending Commands"
          value={stats.pendingCommands}
          accent={stats.pendingCommands ? 'text-amber-600 dark:text-amber-400' : 'text-brand-800 dark:text-slate-100'}
          sub="awaiting device pickup"
        />
        <StatCard
          label="Open Alerts"
          value={stats.alerts.unacknowledged}
          accent={stats.alerts.critical ? 'text-red-600 dark:text-red-400' : 'text-brand-800 dark:text-slate-100'}
          sub={`${stats.alerts.critical} critical`}
        />
      </motion.div>

      <motion.div variants={gridStagger} className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <motion.div variants={cardItem} whileHover={{ y: -2 }} className="card card-hover p-5 lg:col-span-1">
          <h2 className="font-display font-semibold text-brand-800 dark:text-slate-100 mb-4">Compliance</h2>
          {complianceData.length ? (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={complianceData} dataKey="value" nameKey="name" innerRadius={55} outerRadius={85} paddingAngle={3}>
                  {complianceData.map((d) => (
                    <Cell key={d.name} fill={PIE_COLORS[d.name] || '#64748b'} stroke="none" />
                  ))}
                </Pie>
                <Tooltip contentStyle={tooltipStyle} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="text-slate-400 dark:text-slate-500 text-sm py-16 text-center">No devices enrolled yet</div>
          )}
          <div className="flex justify-center gap-4 text-xs mt-2 text-slate-700 dark:text-slate-300">
            {complianceData.map((d) => (
              <span key={d.name} className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: PIE_COLORS[d.name] }} />
                {d.name.replace('_', '-')} ({d.value})
              </span>
            ))}
          </div>
        </motion.div>

        <motion.div variants={cardItem} whileHover={{ y: -2 }} className="card card-hover p-5 lg:col-span-2">
          <h2 className="font-display font-semibold text-brand-800 dark:text-slate-100 mb-4">Device Status Distribution</h2>
          {statusData.length ? (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={statusData}>
                <XAxis dataKey="name" stroke={axisColor} fontSize={12} />
                <YAxis stroke={axisColor} fontSize={12} allowDecimals={false} />
                <Tooltip cursor={{ fill: cursorFill }} contentStyle={tooltipStyle} />
                <Bar dataKey="value" fill={barFill} radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="text-slate-400 dark:text-slate-500 text-sm py-16 text-center">No devices enrolled yet</div>
          )}
        </motion.div>
      </motion.div>

      <motion.div variants={cardItem} className="card">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
          <h2 className="font-display font-semibold text-brand-800 dark:text-slate-100">Recent Command Activity</h2>
          <Link to="/audit" className="text-xs text-brand-700 dark:text-brand-300 hover:text-brand-800">
            View audit log →
          </Link>
        </div>
        {stats.recentCommands.length ? (
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">Command</th>
                <th className="th">Device</th>
                <th className="th">Issued By</th>
                <th className="th">Status</th>
                <th className="th">When</th>
              </tr>
            </thead>
            <tbody>
              {stats.recentCommands.map((c) => (
                <tr key={c.id}>
                  <td className="td font-mono text-brand-700 dark:text-brand-300">{c.type}</td>
                  <td className="td text-slate-700 dark:text-slate-200">{c.device_name || '—'}</td>
                  <td className="td text-slate-500 dark:text-slate-400">{c.issued_by_name || 'system'}</td>
                  <td className="td">
                    <StatusBadge status={c.status} />
                  </td>
                  <td className="td text-slate-400 dark:text-slate-500">{timeAgo(c.issued_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="text-slate-400 dark:text-slate-500 text-sm py-12 text-center">No commands issued yet</div>
        )}
      </motion.div>
    </motion.div>
  );
}
