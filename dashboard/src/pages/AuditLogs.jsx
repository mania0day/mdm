import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth, hasRole } from '../auth.jsx';
import { Spinner, StatusBadge, OnlineDot, timeAgo, EmptyState } from '../ui.jsx';

const REFRESH_MS = 8000;

// ---- Report export ---------------------------------------------------------
// Reports are built client-side from the JSON the API already returns, so no
// new server endpoint is needed. CSV opens straight into Excel/Sheets; JSON
// keeps the full structured detail.

const CSV_COLUMNS = [
  ['created_at', 'Time (UTC)'],
  ['actor_type', 'Actor type'],
  ['actor_label', 'Actor'],
  ['action', 'Action'],
  ['target_type', 'Target type'],
  ['target_id', 'Target id'],
  ['details', 'Details'],
  ['ip', 'IP'],
];

function csvCell(value) {
  const s = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows) {
  const lines = [CSV_COLUMNS.map(([, h]) => h).join(',')];
  for (const r of rows) lines.push(CSV_COLUMNS.map(([k]) => csvCell(r[k])).join(','));
  return lines.join('\n');
}

function downloadBlob(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function slugify(s) {
  return String(s || 'logs').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'logs';
}

function baseName(name) {
  return `sentroid-audit-${slugify(name)}-${new Date().toISOString().slice(0, 10)}`;
}

function exportCsv(name, rows) {
  downloadBlob(`${baseName(name)}.csv`, toCsv(rows), 'text/csv;charset=utf-8');
}

function exportJson(name, rows) {
  downloadBlob(`${baseName(name)}.json`, JSON.stringify(rows, null, 2), 'application/json');
}

// Fetch one entity's full log and download it directly from the picker row —
// "a report per device / per user" without having to open each one first.
async function downloadEntityLogs(kind, id, name) {
  const qs = new URLSearchParams({ limit: '1000' });
  if (kind === 'device') qs.set('device_id', String(id));
  else {
    qs.set('actor_id', String(id));
    qs.set('actor_type', 'user');
  }
  try {
    const d = await api.get(`/audit-logs?${qs.toString()}`);
    exportCsv(name, d.logs || []);
  } catch {
    /* transient network error — the row's "View logs" still works */
  }
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v12M7 10l5 5 5-5M4 21h16" />
    </svg>
  );
}

// Compact, clearly-tappable action button (replaces the old tiny text-xs links).
function ActionButton({ onClick, to, children }) {
  const cls =
    'inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white transition-colors';
  return to ? (
    <Link to={to} className={cls}>{children}</Link>
  ) : (
    <button type="button" onClick={onClick} className={cls}>{children}</button>
  );
}

function DevicePicker({ devices, q, setQ }) {
  const filtered = devices.filter((d) =>
    [d.name, d.model, d.owner_name, d.department].filter(Boolean).join(' ').toLowerCase().includes(q.toLowerCase()),
  );
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-slate-500 dark:text-slate-400">Pick a device to view its activity, or download its report.</p>
        <input className="input max-w-xs" placeholder="Search devices…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="card overflow-hidden">
        {filtered.length ? (
          <table className="w-full">
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-800/60">
                <th className="th">Device</th>
                <th className="th">Status</th>
                <th className="th">Last Seen</th>
                <th className="th text-right">Report</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((d) => (
                <tr key={d.id} className="border-t border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60">
                  <td className="td">
                    <div className="font-medium text-slate-800 dark:text-slate-100">{d.name}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 font-mono">{d.model || d.device_uid}</div>
                  </td>
                  <td className="td"><StatusBadge status={d.status} /></td>
                  <td className="td"><OnlineDot online={d.online} /></td>
                  <td className="td">
                    <div className="flex items-center justify-end gap-2">
                      <ActionButton onClick={() => downloadEntityLogs('device', d.id, d.name)}>
                        <DownloadIcon /> CSV
                      </ActionButton>
                      <ActionButton to={`/audit?device=${d.id}`}>View logs →</ActionButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState>No devices match your search.</EmptyState>
        )}
      </div>
    </div>
  );
}

function UserPicker({ users, q, setQ }) {
  const filtered = users.filter((u) => [u.username, u.full_name, u.role].filter(Boolean).join(' ').toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-slate-500 dark:text-slate-400">Pick an administrator to see what they've done, or download their report.</p>
        <input className="input max-w-xs" placeholder="Search users…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="card overflow-hidden">
        {filtered.length ? (
          <table className="w-full">
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-800/60">
                <th className="th">User</th>
                <th className="th">Role</th>
                <th className="th">Last Login</th>
                <th className="th text-right">Report</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((u) => (
                <tr key={u.id} className="border-t border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60">
                  <td className="td">
                    <div className="font-medium text-slate-800 dark:text-slate-100">{u.full_name}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 font-mono">@{u.username}</div>
                  </td>
                  <td className="td text-slate-600 dark:text-slate-300 capitalize">{u.role?.replace('_', ' ')}</td>
                  <td className="td text-slate-400 dark:text-slate-500">{timeAgo(u.last_login)}</td>
                  <td className="td">
                    <div className="flex items-center justify-end gap-2">
                      <ActionButton onClick={() => downloadEntityLogs('user', u.id, u.full_name || u.username)}>
                        <DownloadIcon /> CSV
                      </ActionButton>
                      <ActionButton to={`/audit?user=${u.id}`}>View logs →</ActionButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState>No users match your search.</EmptyState>
        )}
      </div>
    </div>
  );
}

function LogTable({ logs }) {
  if (!logs.length) return <EmptyState>No log entries yet.</EmptyState>;
  return (
    <table className="w-full">
      <thead>
        <tr className="bg-slate-50 dark:bg-slate-800/60">
          <th className="th">Time</th>
          <th className="th">Actor</th>
          <th className="th">Action</th>
          <th className="th">Details</th>
          <th className="th">IP</th>
        </tr>
      </thead>
      <tbody>
        {logs.map((l) => (
          <tr key={l.id} className="border-t border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60">
            <td className="td text-slate-400 dark:text-slate-500 whitespace-nowrap">{timeAgo(l.created_at)}</td>
            <td className="td">
              <span className="text-xs text-slate-400 dark:text-slate-500 uppercase mr-1.5">{l.actor_type}</span>
              <span className="text-slate-700 dark:text-slate-200">{l.actor_label || '—'}</span>
            </td>
            <td className="td font-mono text-xs text-slate-600 dark:text-slate-300">{l.action}</td>
            <td className="td text-xs text-slate-400 dark:text-slate-500 max-w-sm truncate">
              {l.details ? JSON.stringify(l.details) : '—'}
            </td>
            <td className="td text-xs text-slate-400 dark:text-slate-500 font-mono">{l.ip || '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function AuditLogs() {
  const { user } = useAuth();
  const isAdmin = hasRole(user, 'admin');
  const [params, setParams] = useSearchParams();
  const deviceId = params.get('device');
  const userId = params.get('user');
  const mode = deviceId ? 'device' : userId ? 'user' : params.get('mode') === 'user' ? 'user' : 'device';

  const [devices, setDevices] = useState(null);
  const [users, setUsers] = useState(null);
  const [logs, setLogs] = useState(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    let live = true;
    const poll = () => api.get('/devices').then((d) => live && setDevices(d.devices)).catch(() => {});
    poll();
    const t = setInterval(poll, REFRESH_MS);
    return () => { live = false; clearInterval(t); };
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    api.get('/users').then((d) => setUsers(d.users)).catch(() => {});
  }, [isAdmin]);

  useEffect(() => {
    if (!deviceId && !userId) { setLogs(null); return; }
    let live = true;
    const load = () => {
      const qs = new URLSearchParams();
      if (deviceId) qs.set('device_id', deviceId);
      if (userId) { qs.set('actor_id', userId); qs.set('actor_type', 'user'); }
      api.get(`/audit-logs?${qs.toString()}`).then((d) => live && setLogs(d.logs)).catch(() => {});
    };
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => { live = false; clearInterval(t); };
  }, [deviceId, userId]);

  const device = deviceId && devices ? devices.find((d) => String(d.id) === deviceId) : null;
  const selectedUser = userId && users ? users.find((u) => String(u.id) === userId) : null;
  const selected = device || selectedUser;
  const entityName = device ? device.name : selectedUser ? selectedUser.full_name : 'logs';

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          {selected ? (
            <>
              <button onClick={() => setParams({})} className="text-xs text-brand-600 dark:text-brand-300 hover:text-brand-800 mb-1">
                ← Back
              </button>
              <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">{entityName} — Activity</h1>
            </>
          ) : (
            <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">Audit Logs</h1>
          )}
          <p className="text-sm text-slate-500 dark:text-slate-400">Accountability trail of administrative and device actions</p>
        </div>

        {/* Export the currently-open log as a downloadable report. */}
        {selected && (
          <div className="flex items-center gap-2 shrink-0">
            <ActionButton onClick={() => exportCsv(entityName, logs || [])}>
              <DownloadIcon /> Export CSV
            </ActionButton>
            <ActionButton onClick={() => exportJson(entityName, logs || [])}>
              <DownloadIcon /> Export JSON
            </ActionButton>
          </div>
        )}
      </div>

      {!selected && isAdmin && (
        <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-700 p-0.5 bg-white dark:bg-slate-900">
          <button
            onClick={() => setParams({})}
            className={`px-3.5 py-1.5 text-sm rounded-md ${mode === 'device' ? 'bg-brand-600 text-white' : 'text-slate-600 dark:text-slate-300'}`}
          >
            By device
          </button>
          <button
            onClick={() => setParams({ mode: 'user' })}
            className={`px-3.5 py-1.5 text-sm rounded-md ${mode === 'user' ? 'bg-brand-600 text-white' : 'text-slate-600 dark:text-slate-300'}`}
          >
            By user
          </button>
        </div>
      )}

      {!selected ? (
        mode === 'user' ? (
          users ? <UserPicker users={users} q={q} setQ={setQ} /> : <Spinner />
        ) : devices ? (
          <DevicePicker devices={devices} q={q} setQ={setQ} />
        ) : (
          <Spinner />
        )
      ) : (
        <div className="card overflow-hidden">
          {logs ? <LogTable logs={logs} /> : <Spinner />}
        </div>
      )}
    </div>
  );
}
