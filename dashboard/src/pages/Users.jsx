import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { api } from '../api';
import { useAuth, hasRole } from '../auth.jsx';
import { Spinner, timeAgo } from '../ui.jsx';

const ROLE_DESC = {
  auditor: 'Read-only: devices, logs, reports',
  operator: '+ non-destructive commands (lock, ping, locate)',
  admin: '+ wipe, policies, enrollment, deregister',
  super_admin: '+ user management',
};

const ROLE_BADGE = {
  super_admin: 'bg-brand-100 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300',
  admin: 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300',
  operator: 'bg-slate-100 text-slate-600 dark:bg-slate-700/50 dark:text-slate-300',
  auditor: 'bg-slate-100 text-slate-500 dark:bg-slate-700/50 dark:text-slate-300',
};

export default function Users() {
  const { user } = useAuth();
  const isSuper = hasRole(user, 'super_admin');
  const [users, setUsers] = useState(null);
  const [form, setForm] = useState({ username: '', full_name: '', password: '', role: 'operator' });
  const [error, setError] = useState('');

  const load = () => api.get('/users').then((d) => setUsers(d.users)).catch(() => {});
  useEffect(() => { load(); }, []);

  async function create() {
    setError('');
    try {
      await api.post('/users', form);
      setForm({ username: '', full_name: '', password: '', role: 'operator' });
      load();
    } catch (e) {
      setError(e.message);
    }
  }
  async function setActive(u, active) {
    await api.patch(`/users/${u.id}`, { active });
    load();
  }
  async function setRole(u, role) {
    await api.patch(`/users/${u.id}`, { role });
    load();
  }

  if (!users) return <Spinner />;

  return (
    <div className="space-y-5">
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: 'easeOut' }}
      >
        <h1 className="text-2xl font-display font-bold text-slate-900 dark:text-slate-100">Administrators</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">Role-based access control for the MDM console</p>
      </motion.div>

      {isSuper && (
        <motion.div
          className="card p-5"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: 'easeOut' }}
        >
          <h2 className="font-display font-semibold text-slate-900 dark:text-slate-100 mb-3">Add Administrator</h2>
          <div className="grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
            <div>
              <label className="label">Username</label>
              <input className="input" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
            </div>
            <div>
              <label className="label">Full name</label>
              <input className="input" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
            </div>
            <div>
              <label className="label">Password</label>
              <input type="password" className="input" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
            </div>
            <div>
              <label className="label">Role</label>
              <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                {Object.keys(ROLE_DESC).map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <button className="btn-primary" onClick={create}>Create</button>
          </div>
          {error && <div className="text-sm text-red-500 dark:text-red-400 mt-2">{error}</div>}
          <p className="text-xs text-slate-400 dark:text-slate-500 mt-3">{ROLE_DESC[form.role]}</p>
        </motion.div>
      )}

      <div className="card overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="bg-slate-50 dark:bg-slate-800/60">
              <th className="th">User</th>
              <th className="th">Role</th>
              <th className="th">Status</th>
              <th className="th">Last Login</th>
              {isSuper && <th className="th"></th>}
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr
                key={u.id}
                className="border-t border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-colors"
              >
                <td className="td">
                  <div className="flex items-center gap-3">
                    <div className="h-9 w-9 shrink-0 rounded-full bg-brand-600 text-white flex items-center justify-center text-sm font-semibold">
                      {(u.full_name || u.username || '?').charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <div className="font-medium text-slate-800 dark:text-slate-100">{u.full_name}</div>
                      <div className="text-xs text-slate-500 dark:text-slate-400 font-mono">@{u.username}</div>
                    </div>
                  </div>
                </td>
                <td className="td">
                  {isSuper && u.id !== user.id ? (
                    <select className="input max-w-[10rem]" value={u.role} onChange={(e) => setRole(u, e.target.value)}>
                      {Object.keys(ROLE_DESC).map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  ) : (
                    <span className={`badge capitalize ${ROLE_BADGE[u.role] || 'bg-slate-100 text-slate-600 dark:bg-slate-700/50 dark:text-slate-300'}`}>
                      {u.role.replace('_', ' ')}
                    </span>
                  )}
                </td>
                <td className="td">
                  <span className={`badge ${u.active ? 'bg-accent-100 text-accent-700 dark:bg-accent-500/15 dark:text-accent-300' : 'bg-slate-100 text-slate-500 dark:bg-slate-700/50 dark:text-slate-300'}`}>
                    {u.active ? 'active' : 'disabled'}
                  </span>
                </td>
                <td className="td text-slate-500 dark:text-slate-400">{u.last_login ? timeAgo(u.last_login) : 'never'}</td>
                {isSuper && (
                  <td className="td text-right">
                    {u.id !== user.id && (
                      <button className="btn-ghost text-xs" onClick={() => setActive(u, !u.active)}>
                        {u.active ? 'Disable' : 'Enable'}
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
