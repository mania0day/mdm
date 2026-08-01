import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { api } from '../api';
import { useAuth, hasRole } from '../auth.jsx';
import { Spinner } from '../ui.jsx';

const FIELDS = [
  { key: 'min_password_length', label: 'Min password length', type: 'number' },
  { key: 'require_password', label: 'Require screen-lock password', type: 'bool' },
  { key: 'password_quality', label: 'Password quality', type: 'select', options: ['none', 'numeric', 'alphanumeric', 'complex'] },
  { key: 'max_failed_passwords', label: 'Wipe after N failed unlocks', type: 'number' },
  { key: 'max_screen_timeout_seconds', label: 'Max screen timeout (s)', type: 'number' },
  { key: 'disable_camera', label: 'Disable camera', type: 'bool' },
  { key: 'require_encryption', label: 'Require storage encryption', type: 'bool' },
  { key: 'block_rooted', label: 'Flag rooted devices', type: 'bool' },
  { key: 'force_location_on', label: 'Force location always-on (block user)', type: 'bool' },
];

const listVariants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05 } },
};

const itemVariants = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: 'easeOut' } },
};

function PolicyEditor({ policy, onSave, onClose, canEdit }) {
  const [name, setName] = useState(policy?.name || '');
  const [description, setDescription] = useState(policy?.description || '');
  const [config, setConfig] = useState(policy?.config || {});
  const [isDefault, setIsDefault] = useState(!!policy?.is_default);

  function set(k, v) {
    setConfig((c) => ({ ...c, [k]: v }));
  }

  return (
    <motion.div
      className="fixed inset-0 bg-slate-900/40 grid place-items-center z-50 p-4"
      onClick={onClose}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
    >
      <motion.div
        className="card p-6 w-full max-w-lg max-h-[90vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.96 }}
        transition={{ duration: 0.22, ease: 'easeOut' }}
      >
        <h2 className="font-display font-semibold text-brand-800 dark:text-slate-100 text-lg mb-4">
          {policy ? 'Edit Policy' : 'New Policy'}
        </h2>
        <div className="space-y-4">
          <div>
            <label className="label">Name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} disabled={!canEdit} />
          </div>
          <div>
            <label className="label">Description</label>
            <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} disabled={!canEdit} />
          </div>
          <div className="grid grid-cols-1 gap-3">
            {FIELDS.map((f) => (
              <div key={f.key} className="flex items-center justify-between gap-3">
                <span className="text-sm text-slate-700 dark:text-slate-200">{f.label}</span>
                {f.type === 'bool' ? (
                  <input type="checkbox" className="h-4 w-4 accent-brand-600" checked={!!config[f.key]} onChange={(e) => set(f.key, e.target.checked)} disabled={!canEdit} />
                ) : f.type === 'select' ? (
                  <select className="input max-w-[10rem]" value={config[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} disabled={!canEdit}>
                    {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : (
                  <input type="number" className="input max-w-[8rem]" value={config[f.key] ?? 0} onChange={(e) => set(f.key, Number(e.target.value))} disabled={!canEdit} />
                )}
              </div>
            ))}
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
            <input type="checkbox" className="h-4 w-4 accent-brand-600" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} disabled={!canEdit} />
            Set as default policy for new devices
          </label>
        </div>
        <div className="flex justify-end gap-2 mt-6">
          <button className="btn-ghost" onClick={onClose}>Close</button>
          {canEdit && (
            <button className="btn-primary" onClick={() => onSave({ name, description, config, is_default: isDefault })}>
              Save
            </button>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

export default function Policies() {
  const { user } = useAuth();
  const canEdit = hasRole(user, 'admin');
  const [policies, setPolicies] = useState(null);
  const [editing, setEditing] = useState(null);

  const load = () => api.get('/policies').then((d) => setPolicies(d.policies)).catch(() => {});
  useEffect(() => { load(); }, []);

  async function save(body) {
    if (editing?.id) await api.put(`/policies/${editing.id}`, body);
    else await api.post('/policies', body);
    setEditing(null);
    load();
  }

  async function remove(p) {
    if (!confirm(`Delete policy "${p.name}"?`)) return;
    await api.del(`/policies/${p.id}`);
    load();
  }

  if (!policies) return <Spinner />;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold text-brand-800 dark:text-slate-100">Security Policies</h1>
          <p className="text-sm text-slate-400 dark:text-slate-500">Rule-based enforcement pushed to managed devices</p>
        </div>
        {canEdit && (
          <button className="btn-primary" onClick={() => setEditing({})}>+ New Policy</button>
        )}
      </div>

      <motion.div
        className="grid grid-cols-1 md:grid-cols-2 gap-4"
        variants={listVariants}
        initial="hidden"
        animate="show"
      >
        {policies.map((p) => (
          <motion.div
            key={p.id}
            className="card card-hover p-5"
            variants={itemVariants}
            whileHover={{ y: -2 }}
            transition={{ type: 'spring', stiffness: 300, damping: 24 }}
          >
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-display font-semibold text-brand-800 dark:text-slate-100">{p.name}</h3>
                  {p.is_default ? <span className="badge bg-brand-50 text-brand-700 ring-1 ring-brand-600/20 dark:bg-brand-500/15 dark:text-brand-300 dark:ring-brand-400/25">default</span> : null}
                </div>
                <p className="text-sm text-slate-400 dark:text-slate-500 mt-0.5">{p.description}</p>
              </div>
              <span className="text-xs text-slate-500 dark:text-slate-400">{p.device_count} device(s)</span>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-4 text-xs">
              {Object.entries(p.config).slice(0, 8).map(([k, v]) => (
                <div key={k} className="flex justify-between">
                  <span className="text-slate-500 dark:text-slate-400">{k.replace(/_/g, ' ')}</span>
                  <span className="text-slate-700 dark:text-slate-200 font-mono">{String(v)}</span>
                </div>
              ))}
            </div>
            <div className="flex gap-2 mt-4">
              <button className="btn-ghost text-xs" onClick={() => setEditing(p)}>
                {canEdit ? 'Edit' : 'View'}
              </button>
              {canEdit && !p.is_default && (
                <button className="btn-ghost text-xs text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300" onClick={() => remove(p)}>Delete</button>
              )}
            </div>
          </motion.div>
        ))}
      </motion.div>

      <AnimatePresence>
        {editing && (
          <PolicyEditor
            policy={editing.id ? editing : null}
            canEdit={canEdit}
            onSave={save}
            onClose={() => setEditing(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
