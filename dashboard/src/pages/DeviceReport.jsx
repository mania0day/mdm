import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api';
import { Spinner, VerdictPill, SeverityBadge, StatusBadge, timeAgo, PdfButton, PrintHeader } from '../ui.jsx';
import ScoreRing from '../components/ScoreRing.jsx';

const TIER_LABEL = { enforced: 'Enforced', owner_only: 'Owner only', monitored: 'Monitored' };
const TIER_STYLE = {
  enforced: 'text-accent-700 dark:text-accent-400',
  owner_only: 'text-amber-700 dark:text-amber-400',
  monitored: 'text-slate-500 dark:text-slate-400',
};
const CVE_LEVEL_STYLE = {
  CRITICAL: 'text-red-700 dark:text-red-400',
  HIGH: 'text-orange-700 dark:text-orange-400',
  MEDIUM: 'text-yellow-700 dark:text-yellow-400',
  LOW: 'text-cyan-700 dark:text-cyan-400',
  NONE: 'text-accent-700 dark:text-accent-400',
};

function MetaItem({ label, value }) {
  return (
    <div className="rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 px-3 py-2">
      <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">{value ?? '—'}</dd>
    </div>
  );
}

function executiveSummary(data) {
  const { device, compliance, cve } = data;
  const name = device.name;
  const parts = [];
  if (compliance.compliant) {
    parts.push(`${name} meets baseline security policy with no open violations.`);
  } else {
    parts.push(`${name} is currently NON-COMPLIANT: ${compliance.violations.join('; ')}.`);
  }
  if (device.management_mode !== 'device_owner') {
    parts.push(
      'This device is Device Admin, not Device Owner, so several policy controls (password quality, camera, microphone, forced location) cannot be enforced at the OS level — only monitored.',
    );
  }
  if (cve?.os_eol) {
    parts.push(cve.os_eol_details + '.');
  } else if (cve?.total_unpatched) {
    parts.push(`${cve.total_unpatched} known CVE(s) remain unpatched against the current security bulletin.`);
  }
  parts.push(`Security posture score ${compliance.score}/100.`);
  return parts.join(' ');
}

export default function DeviceReport() {
  const { id } = useParams();
  const [data, setData] = useState(null);

  useEffect(() => {
    let live = true;
    const load = () => api.get(`/devices/${id}/report`).then((d) => live && setData(d)).catch(() => {});
    load();
    const t = setInterval(load, 8000);
    return () => { live = false; clearInterval(t); };
  }, [id]);

  if (!data) return <Spinner />;
  const { device, compliance, enforcement, cve, alerts, commands } = data;

  const tierCounts = enforcement.reduce((acc, e) => ((acc[e.tier] = (acc[e.tier] || 0) + 1), acc), {});

  return (
    <div className="space-y-6">
      <PrintHeader title={`Device Analysis Report — ${device.name}`} subtitle={`${device.manufacturer} ${device.model} · ${device.serial}`} />
      <div className="no-print flex items-start justify-between gap-3">
        <div>
          <Link to={`/devices/${id}`} className="text-xs text-slate-500 dark:text-slate-400 hover:text-brand-700 dark:hover:text-brand-300">
            ← {device.name}
          </Link>
          <h1 className="mt-1 text-2xl font-bold text-slate-900 dark:text-slate-100">Analysis Report</h1>
          <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
            {device.manufacturer} {device.model} · <span className="font-mono text-xs">{device.serial}</span>
          </p>
        </div>
        <PdfButton />
      </div>

      {/* Hero: score + identity + summary — deliberately the only heavily-colored section on the page */}
      <section className="card overflow-hidden">
        <div className="grid gap-0 lg:grid-cols-[200px_1fr]">
          <div className="flex flex-col items-center justify-center gap-4 border-b border-slate-100 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/40 px-6 py-8 lg:border-b-0 lg:border-r">
            <ScoreRing score={compliance.score} />
            <VerdictPill compliant={compliance.compliant} />
          </div>
          <div className="p-6 space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">Assigned to</p>
                <p className="mt-0.5 text-lg font-bold text-slate-900 dark:text-slate-100">{device.owner_name || 'Unassigned'}</p>
                {device.employee_id && <p className="text-xs text-slate-500 dark:text-slate-400 font-mono">{device.employee_id}</p>}
              </div>
              <div className="flex items-center gap-2 text-xs text-slate-400 dark:text-slate-500">
                <StatusBadge status={device.status} />
                generated {timeAgo(data.generated_at)}
              </div>
            </div>

            <dl className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              <MetaItem label="Platform" value={`Android ${device.os_version}`} />
              <MetaItem label="Security patch" value={device.security_patch} />
              <MetaItem label="Management" value={device.management_mode === 'device_owner' ? 'Device Owner' : device.management_mode === 'device_admin' ? 'Device Admin' : 'None'} />
              <MetaItem label="Rooted" value={device.is_rooted ? 'Yes' : 'No'} />
            </dl>

            <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-3.5 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              <span className="font-semibold text-slate-900 dark:text-slate-100">Summary. </span>
              {executiveSummary(data)}
            </div>
          </div>
        </div>
      </section>

      {/* CVE exposure */}
      {cve && (
        <section className="card overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between flex-wrap gap-2">
            <div>
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Known CVE exposure</h2>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                {cve.os_eol
                  ? cve.os_eol_details
                  : `${cve.total_unpatched} unpatched CVE(s) against security patch ${cve.security_patch}`}
              </p>
            </div>
            <span className={`text-sm font-bold ${CVE_LEVEL_STYLE[cve.overall_level]}`}>{cve.overall_level}</span>
          </div>
          {cve.cves.length ? (
            <div className="max-h-80 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800/60 text-xs uppercase tracking-wide text-slate-400 dark:text-slate-500">
                  <tr>
                    <th className="th">CVE</th>
                    <th className="th">Severity</th>
                    <th className="th">CVSS</th>
                    <th className="th">Title</th>
                    <th className="th">Bulletin</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {cve.cves.map((c) => (
                    <tr key={c.id}>
                      <td className="td font-mono text-xs text-slate-800 dark:text-slate-100">{c.id}</td>
                      <td className="td"><SeverityBadge severity={c.severity === 'CRITICAL' ? 'critical' : c.severity === 'HIGH' ? 'warning' : 'info'} /></td>
                      <td className="td tabular-nums text-slate-700 dark:text-slate-200">{c.cvss?.toFixed(1)}</td>
                      <td className="td text-slate-700 dark:text-slate-200">{c.title}</td>
                      <td className="td text-xs text-slate-400 dark:text-slate-500 whitespace-nowrap">{c.bulletin}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-slate-400 dark:text-slate-500 text-sm py-8 text-center">No known unpatched CVEs</div>
          )}
        </section>
      )}

      {/* Policy enforcement breakdown */}
      <section className="card p-5">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Policy enforcement</h2>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          What the assigned policy specifies vs. what this device's management level can actually apply
        </p>
        <div className="mt-4 flex flex-wrap gap-3 text-xs">
          {['enforced', 'owner_only', 'monitored'].map((t) =>
            tierCounts[t] ? (
              <span key={t} className={`font-semibold ${TIER_STYLE[t]}`}>
                {tierCounts[t]} {TIER_LABEL[t].toLowerCase()}
              </span>
            ) : null,
          )}
        </div>
        <div className="mt-4 divide-y divide-slate-100 dark:divide-slate-800">
          {enforcement.map((e) => (
            <div key={e.key} className="flex items-center justify-between py-2 text-sm">
              <span className="text-slate-600 dark:text-slate-300">{e.key.replace(/_/g, ' ')}</span>
              <div className="flex items-center gap-3">
                <span className="font-mono text-xs text-slate-500 dark:text-slate-400">{String(e.value)}</span>
                <span className={`text-xs font-semibold ${TIER_STYLE[e.tier]}`}>{TIER_LABEL[e.tier]}</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Alerts</h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{alerts.total} recorded</p>
          </div>
          {alerts.recent.length ? (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800 max-h-96 overflow-y-auto">
              {alerts.recent.map((a) => (
                <li key={a.id} className="px-5 py-3 flex items-center gap-3">
                  <SeverityBadge severity={a.severity} />
                  <span className="flex-1 text-sm text-slate-700 dark:text-slate-200">{a.message}</span>
                  <span className="text-xs text-slate-400 dark:text-slate-500 whitespace-nowrap">{timeAgo(a.created_at)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-slate-400 dark:text-slate-500 text-sm py-10 text-center">No alerts</div>
          )}
        </section>

        <section className="card overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Recent commands</h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{commands.total} total issued</p>
          </div>
          {commands.recent.length ? (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800 max-h-96 overflow-y-auto">
              {commands.recent.map((c) => (
                <li key={c.id} className="px-5 py-3 flex items-center gap-3">
                  <span className="font-mono text-xs text-brand-700 dark:text-brand-300 w-28 shrink-0">{c.type}</span>
                  <span className="flex-1 text-xs text-slate-500 dark:text-slate-400 truncate">{c.result || c.status}</span>
                  <span className="text-xs text-slate-400 dark:text-slate-500 whitespace-nowrap">{timeAgo(c.issued_at)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-slate-400 dark:text-slate-500 text-sm py-10 text-center">No commands issued yet</div>
          )}
        </section>
      </div>
    </div>
  );
}
