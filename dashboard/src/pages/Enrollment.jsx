import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { api } from '../api';
import { Spinner, timeAgo, EmptyState } from '../ui.jsx';

const rowVariants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.25, ease: 'easeOut' } },
};
const listVariants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05 } },
};

export default function Enrollment() {
  const [tokens, setTokens] = useState(null);
  const [label, setLabel] = useState('');
  const [department, setDepartment] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [copied, setCopied] = useState('');
  const [provTok, setProvTok] = useState(null); // token being provisioned as Owner
  const [prov, setProv] = useState(null); // provisioning response, 'loading', or {error}
  const [serverUrl, setServerUrl] = useState('');

  const load = () => api.get('/enrollment/tokens').then((d) => setTokens(d.tokens)).catch(() => {});
  useEffect(() => { load(); }, []);

  async function fetchProv(tok, srv) {
    setProv('loading');
    try {
      const d = await api.get(`/enrollment/tokens/${tok.id}/provisioning?server=${encodeURIComponent(srv)}`);
      setProv(d);
    } catch (e) {
      setProv({ error: e.message || 'Failed to build provisioning QR' });
    }
  }
  function openProvision(tok) {
    const origin = window.location.origin;
    setProvTok(tok);
    setServerUrl(origin);
    fetchProv(tok, origin);
  }
  function closeProvision() {
    setProvTok(null);
    setProv(null);
  }

  async function create() {
    await api.post('/enrollment/tokens', {
      label: label || undefined,
      department: department || undefined,
      employee_id: employeeId || undefined,
    });
    setLabel('');
    setDepartment('');
    setEmployeeId('');
    load();
  }
  async function remove(id) {
    await api.del(`/enrollment/tokens/${id}`);
    load();
  }
  function copy(t) {
    navigator.clipboard?.writeText(t);
    setCopied(t);
    setTimeout(() => setCopied(''), 1500);
  }

  if (!tokens) return <Spinner />;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="h-page font-display text-slate-900 dark:text-slate-100">Device Enrollment</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Generate single-use tokens. Enter a token in the SENTROID Android agent to onboard a device.
        </p>
      </div>

      <motion.div
        className="card p-5"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: 'easeOut' }}
      >
        <h2 className="font-display font-semibold text-slate-900 dark:text-slate-100 mb-3">Generate Enrollment Token</h2>
        <p className="text-xs text-slate-400 dark:text-slate-500 mb-3">
          Identity is set here, by the administrator — not typed into the device. The phone only ever shows the
          employee's name and its own status; nothing else about the device holder is exposed on-screen.
        </p>
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-[10rem]">
            <label className="label">Employee name</label>
            <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. J. Khan" />
          </div>
          <div className="flex-1 min-w-[10rem]">
            <label className="label">Employee ID / contact (optional)</label>
            <input className="input" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} placeholder="e.g. EMP-1042" />
          </div>
          <div className="flex-1 min-w-[10rem]">
            <label className="label">Department (optional)</label>
            <input className="input" value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="e.g. Field Operations" />
          </div>
          <button className="btn-primary" onClick={create}>Generate</button>
        </div>
      </motion.div>

      <div className="card overflow-hidden">
        {tokens.length ? (
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">Token</th>
                <th className="th">Employee</th>
                <th className="th">Employee ID</th>
                <th className="th">Dept</th>
                <th className="th">Status</th>
                <th className="th">Created</th>
                <th className="th"></th>
              </tr>
            </thead>
            <motion.tbody variants={listVariants} initial="hidden" animate="show">
              {tokens.map((t) => (
                <motion.tr key={t.id} variants={rowVariants}>
                  <td className="td">
                    <div className="inline-flex items-center gap-2 rounded-lg bg-slate-50 border border-slate-200 dark:bg-slate-800/60 dark:border-slate-700 px-2.5 py-1.5">
                      <span className="font-mono text-sm text-slate-700 dark:text-slate-200">{t.token}</span>
                      <button
                        className="btn-ghost px-2 py-1 text-xs inline-flex items-center gap-1"
                        onClick={() => copy(t.token)}
                        title="Copy token"
                      >
                        {copied === t.token ? (
                          <motion.span
                            key="copied"
                            initial={{ scale: 0.8, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            transition={{ duration: 0.2, ease: 'easeOut' }}
                            className="inline-flex items-center gap-1 text-accent-700 dark:text-accent-300"
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                            Copied
                          </motion.span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-slate-500 dark:text-slate-400">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                            </svg>
                            Copy
                          </span>
                        )}
                      </button>
                    </div>
                  </td>
                  <td className="td text-slate-800 dark:text-slate-100">{t.label || '—'}</td>
                  <td className="td text-slate-500 dark:text-slate-400 font-mono text-xs">{t.employee_id || '—'}</td>
                  <td className="td text-slate-500 dark:text-slate-400">{t.department || '—'}</td>
                  <td className="td">
                    {t.used ? (
                      <span className="badge bg-slate-100 text-slate-600 dark:bg-slate-700/50 dark:text-slate-300">
                        used → {t.device_name || `#${t.device_id}`}
                      </span>
                    ) : (
                      <span className="badge bg-accent-100 text-accent-700 dark:bg-accent-500/15 dark:text-accent-300">available</span>
                    )}
                  </td>
                  <td className="td text-slate-400 dark:text-slate-500">{timeAgo(t.created_at)}</td>
                  <td className="td text-right whitespace-nowrap">
                    {!t.used && (
                      <>
                        <button className="btn-ghost text-xs" onClick={() => openProvision(t)} title="Device Owner QR for a factory-wiped device">
                          Provision (QR)
                        </button>
                        <button className="btn-ghost text-xs text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300" onClick={() => remove(t.id)}>Revoke</button>
                      </>
                    )}
                  </td>
                </motion.tr>
              ))}
            </motion.tbody>
          </table>
        ) : (
          <EmptyState>No enrollment tokens. Generate one above.</EmptyState>
        )}
      </div>

      <AnimatePresence>
        {provTok && (
          <motion.div
            className="fixed inset-0 bg-slate-900/40 grid place-items-center z-50 p-4"
            onClick={closeProvision}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <motion.div
              className="card p-6 w-full max-w-2xl max-h-[92vh] overflow-auto"
              onClick={(e) => e.stopPropagation()}
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              transition={{ duration: 0.22, ease: 'easeOut' }}
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="font-display font-semibold text-slate-900 dark:text-slate-100 text-lg">Provision as Device Owner</h2>
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    {provTok.label ? `${provTok.label} · ` : ''}
                    <span className="font-mono">{provTok.token}</span>
                  </p>
                </div>
                <button className="btn-ghost" onClick={closeProvision}>Close</button>
              </div>

              <div className="mt-4">
                <label className="label">Server URL the phone will use — must be reachable from the device's Wi-Fi (a LAN IP or public host, not localhost)</label>
                <div className="flex gap-2">
                  <input className="input flex-1" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="http://192.168.1.50:4000" />
                  <button className="btn-primary" onClick={() => fetchProv(provTok, serverUrl)}>Update QR</button>
                </div>
              </div>

              {prov === 'loading' ? (
                <div className="py-10"><Spinner /></div>
              ) : prov?.error ? (
                <p className="mt-4 text-sm text-red-600 dark:text-red-400">{prov.error}</p>
              ) : prov ? (
                <div className="mt-4 grid md:grid-cols-2 gap-6">
                  <div className="flex flex-col items-center">
                    <div className="rounded-xl bg-white p-3 ring-1 ring-slate-200">
                      <img src={prov.qr} alt="Device Owner provisioning QR" width={300} height={300} />
                    </div>
                    {!prov.apk_available && (
                      <p className="mt-2 text-xs text-amber-600 dark:text-amber-400 text-center">
                        ⚠ Agent APK not found on the server. Run <span className="font-mono">android-agent/build-apk.sh</span> so <span className="font-mono">/sentroid-agent.apk</span> can download.
                      </p>
                    )}
                    <a className="mt-2 text-xs text-brand-600 dark:text-brand-400 underline break-all text-center" href={prov.download_url} target="_blank" rel="noreferrer">{prov.download_url}</a>
                  </div>

                  <div>
                    <h3 className="font-semibold text-slate-800 dark:text-slate-100 text-sm mb-2">On the phone (factory-wiped)</h3>
                    <ol className="list-decimal ml-5 space-y-1.5 text-sm text-slate-600 dark:text-slate-300">
                      <li><b>Factory reset</b> the device (or start from the initial welcome screen). Do not add any account.</li>
                      <li>On the very first “Hi there / Welcome” screen, <b>tap the same spot 6 times</b>.</li>
                      <li>Connect to <b>Wi-Fi that can reach this server</b>; the QR scanner then opens.</li>
                      <li><b>Scan this QR.</b> Android downloads the agent, verifies its signature, and makes it <b>Device Owner</b>.</li>
                      <li>The agent <b>auto-enrolls</b> with this token — no typing. It shows up here as <span className="font-mono">device_owner</span>.</li>
                    </ol>
                    <details className="mt-3">
                      <summary className="text-xs text-slate-500 dark:text-slate-400 cursor-pointer">Raw provisioning JSON</summary>
                      <pre className="mt-2 text-[11px] leading-snug bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg p-2 overflow-auto max-h-52">{JSON.stringify(prov.payload, null, 2)}</pre>
                    </details>
                  </div>
                </div>
              ) : null}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
