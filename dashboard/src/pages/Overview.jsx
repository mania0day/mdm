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
import { Spinner, StatusBadge, timeAgo, AnimatedNumber, PdfButton, PrintHeader } from '../ui.jsx';

const gridStagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06 } },
};
const cardItem = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.45, ease: [0.16, 1, 0.3, 1] } },
};

function useIsDark() {
  const [dark, setDark] = useState(() => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'));
  useEffect(() => {
    const el = document.documentElement;
    const obs = new MutationObserver(() => setDark(el.classList.contains('dark')));
    obs.observe(el, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

function StatCard({ label, value, sub, accent = 'text-slate-900 dark:text-slate-100' }) {
  return (
    <motion.div variants={cardItem} className="card p-5">
      <div className="text-xs uppercase tracking-wider text-slate-400 dark:text-slate-500">{label}</div>
      <div className={`text-3xl font-bold mt-1 ${accent}`}>
        <AnimatedNumber value={value} />
      </div>
      {sub && <div className="text-xs text-slate-400 dark:text-slate-500 mt-1">{sub}</div>}
    </motion.div>
  );
}

const COMPLIANCE_COLORS = { compliant: '#16a34a', non_compliant: '#dc2626', unknown: '#64748b' };
const ROOTED_COLORS = { not_rooted: '#16a34a', rooted: '#dc2626' };
// Spaced well apart in hue (not all clustered in the same red-orange band)
// so Critical/High/Medium read as visibly distinct tiers, not one blur.
const CVE_COLORS = { NONE: '#16a34a', LOW: '#0891b2', MEDIUM: '#ca8a04', HIGH: '#f97316', CRITICAL: '#dc2626', UNKNOWN: '#94a3b8' };
// Cycled per manufacturer slice — never hardcoded to specific vendor names,
// so a fleet of just one make (or an unfamiliar one) still renders correctly.
const MAKE_PALETTE = ['#4f46e5', '#0891b2', '#16a34a', '#d97706', '#db2777', '#7c3aed', '#0ea5e9', '#65a30d'];

function ChartCard({ title, subtitle, empty, children }) {
  return (
    <motion.div variants={cardItem} className="card p-5">
      <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{subtitle}</p>
      <div className="mt-4">{empty ? <div className="text-slate-400 dark:text-slate-500 text-sm py-16 text-center">{empty}</div> : children}</div>
    </motion.div>
  );
}

function Legend({ items }) {
  return (
    <div className="flex flex-wrap justify-center gap-x-4 gap-y-1.5 text-xs mt-3 text-slate-600 dark:text-slate-300">
      {items.map((it) => (
        <span key={it.label} className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: it.color }} />
          {it.label} ({it.value})
        </span>
      ))}
    </div>
  );
}

export default function Overview() {
  const [stats, setStats] = useState(null);
  const isDark = useIsDark();

  useEffect(() => {
    let live = true;
    const poll = () => api.get('/stats').then((d) => live && setStats(d)).catch(() => {});
    poll();
    const t = setInterval(poll, 8000);
    return () => { live = false; clearInterval(t); };
  }, []);

  if (!stats) return <Spinner />;

  const tooltipStyle = isDark
    ? { background: '#1e293b', border: '1px solid #334155', borderRadius: 8, color: '#e2e8f0' }
    : { background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 8, color: '#1e293b' };
  const axisColor = isDark ? '#94a3b8' : '#64748b';
  const cursorFill = isDark ? '#33415566' : '#e2e8f055';

  const complianceData = Object.entries(stats.devices.byCompliance || {}).map(([name, value]) => ({ name, value, color: COMPLIANCE_COLORS[name] || '#64748b' }));
  const makeData = Object.entries(stats.devices.byManufacturer || {}).map(([name, value], i) => ({ name, value, color: MAKE_PALETTE[i % MAKE_PALETTE.length] }));
  const rootedData = Object.entries(stats.devices.byRooted || {}).map(([name, value]) => ({
    name: name === 'rooted' ? 'Rooted' : 'Not rooted',
    value,
    color: ROOTED_COLORS[name] || '#64748b',
  }));
  // Real CVE volume across the fleet (sum of each device's actual unpatched
  // Critical/High/Medium count) — a device-count-per-tier chart is trivial
  // on a small fleet; the number of actual CVEs is what matters.
  const cveVolumeData = [
    { name: 'Critical', value: stats.cve?.volume?.critical || 0, color: CVE_COLORS.CRITICAL },
    { name: 'High', value: stats.cve?.volume?.high || 0, color: CVE_COLORS.HIGH },
    { name: 'Medium', value: stats.cve?.volume?.medium || 0, color: CVE_COLORS.MEDIUM },
  ];

  return (
    <motion.div variants={gridStagger} initial="hidden" animate="show" className="space-y-6">
      <PrintHeader title="Fleet Security Report" subtitle={`${stats.devices.total} managed device(s)`} />
      <motion.div variants={cardItem} className="no-print flex items-start justify-between gap-3">
        <div>
          <h1 className="h-page">Operations Overview</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">Real-time visibility across all managed devices</p>
        </div>
        <PdfButton label="Download Fleet PDF" />
      </motion.div>

      <motion.div variants={gridStagger} className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Managed Devices" value={stats.devices.total} sub={`${stats.devices.online} online · ${stats.devices.offline} offline`} />
        <StatCard label="Online Now" value={stats.devices.online} accent="text-accent-600 dark:text-accent-400" sub="checked in recently" />
        <StatCard
          label="Rooted Devices"
          value={stats.devices.byRooted?.rooted || 0}
          accent={stats.devices.byRooted?.rooted ? 'text-red-600 dark:text-red-400' : 'text-slate-900 dark:text-slate-100'}
          sub="compromised integrity"
        />
        <StatCard
          label="EOL / Unpatched OS"
          value={stats.cve?.devicesEol || 0}
          accent={stats.cve?.devicesEol ? 'text-red-600 dark:text-red-400' : 'text-slate-900 dark:text-slate-100'}
          sub="no longer receiving updates"
        />
      </motion.div>

      <motion.div variants={gridStagger} className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ChartCard title="Compliance" subtitle="Devices meeting the assigned security policy" empty={!complianceData.length && 'No devices enrolled yet'}>
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie data={complianceData} dataKey="value" nameKey="name" innerRadius={55} outerRadius={85} paddingAngle={3}>
                {complianceData.map((d) => <Cell key={d.name} fill={d.color} stroke="none" />)}
              </Pie>
              <Tooltip contentStyle={tooltipStyle} />
            </PieChart>
          </ResponsiveContainer>
          <Legend items={complianceData.map((d) => ({ label: d.name.replace('_', '-'), value: d.value, color: d.color }))} />
        </ChartCard>

        <ChartCard title="Devices by Make" subtitle="Manufacturer mix of the enrolled fleet" empty={!makeData.length && 'No devices enrolled yet'}>
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie data={makeData} dataKey="value" nameKey="name" innerRadius={55} outerRadius={85} paddingAngle={3}>
                {makeData.map((d) => <Cell key={d.name} fill={d.color} stroke="none" />)}
              </Pie>
              <Tooltip contentStyle={tooltipStyle} />
            </PieChart>
          </ResponsiveContainer>
          <Legend items={makeData.map((d) => ({ label: d.name, value: d.value, color: d.color }))} />
        </ChartCard>

        <ChartCard title="Root Status" subtitle="Devices with compromised OS integrity" empty={!rootedData.length && 'No devices enrolled yet'}>
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie data={rootedData} dataKey="value" nameKey="name" innerRadius={55} outerRadius={85} paddingAngle={3}>
                {rootedData.map((d) => <Cell key={d.name} fill={d.color} stroke="none" />)}
              </Pie>
              <Tooltip contentStyle={tooltipStyle} />
            </PieChart>
          </ResponsiveContainer>
          <Legend items={rootedData.map((d) => ({ label: d.name, value: d.value, color: d.color }))} />
        </ChartCard>

        <ChartCard
          title="Unpatched CVEs by Severity"
          subtitle="Actual CVE count across the fleet, not just a device tally — this is what to fix"
          empty={!cveVolumeData.some((d) => d.value > 0) && 'No unpatched CVEs found'}
        >
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={cveVolumeData} layout="vertical" margin={{ left: 8 }}>
              <XAxis type="number" stroke={axisColor} fontSize={12} allowDecimals={false} />
              <YAxis type="category" dataKey="name" stroke={axisColor} fontSize={12} width={60} />
              <Tooltip cursor={{ fill: cursorFill }} contentStyle={tooltipStyle} />
              <Bar dataKey="value" radius={[0, 6, 6, 0]}>
                {cveVolumeData.map((d) => <Cell key={d.name} fill={d.color} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <Legend items={cveVolumeData.map((d) => ({ label: d.name, value: d.value, color: d.color }))} />
        </ChartCard>
      </motion.div>

      {/* Per-device breakdown backing the charts above — every device, its
          root state, and its CVE tier, sorted worst-first. */}
      <motion.div variants={cardItem} className="card overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-700">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Fleet Risk Detail</h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">Every device behind the charts above, worst risk first</p>
        </div>
        {stats.cve?.devices?.length ? (
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">Device</th>
                <th className="th">Root Status</th>
                <th className="th">CVE Level</th>
                <th className="th">Unpatched</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody>
              {stats.cve.devices.map((d) => (
                <tr key={d.id} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="td">
                    <div className="font-medium text-slate-800 dark:text-slate-100">{d.name}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">{d.manufacturer} {d.model}</div>
                  </td>
                  <td className="td">
                    {d.is_rooted ? (
                      <span className="text-red-600 dark:text-red-400 font-medium">⚠ Rooted</span>
                    ) : (
                      <span className="text-slate-500 dark:text-slate-400">Not rooted</span>
                    )}
                  </td>
                  <td className="td">
                    <span className="font-semibold" style={{ color: CVE_COLORS[d.cve_level] || '#64748b' }}>{d.cve_level}</span>
                  </td>
                  <td className="td text-slate-600 dark:text-slate-300 tabular-nums">{d.unpatched ?? '—'}</td>
                  <td className="td text-right">
                    <Link to={`/devices/${d.id}/report`} className="btn-ghost text-xs">Report →</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="text-slate-400 dark:text-slate-500 text-sm py-10 text-center">No devices enrolled yet</div>
        )}
      </motion.div>

      <motion.div variants={cardItem} className="card">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Recent Command Activity</h2>
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
