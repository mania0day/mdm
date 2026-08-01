import { useState } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuth } from '../auth.jsx';
import ThemeToggle from '../components/ThemeToggle.jsx';

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.1, delayChildren: 0.1 } },
};
const item = {
  hidden: { opacity: 0, y: 18 },
  show: { opacity: 1, y: 0, transition: { duration: 0.55, ease: [0.16, 1, 0.3, 1] } },
};

function UserIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z" />
    </svg>
  );
}
function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 018 0v4" />
    </svg>
  );
}
function Shield({ className }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2l8 3v6c0 5-3.4 8.5-8 11-4.6-2.5-8-6-8-11V5l8-3z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

function StatusRow({ label, delay }) {
  return (
    <motion.div variants={item} className="flex items-center gap-2.5 text-sm text-brand-100/90">
      <motion.span
        className="h-2 w-2 rounded-full bg-accent-400"
        animate={{ opacity: [1, 0.4, 1] }}
        transition={{ duration: 2, repeat: Infinity, delay }}
      />
      {label}
    </motion.div>
  );
}

export default function Login() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('Admin@123');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/" replace />;

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login(username, password);
      navigate('/');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative min-h-screen grid lg:grid-cols-2 bg-app">
      <div className="absolute top-4 right-4 z-20"><ThemeToggle /></div>
      {/* ---- Brand panel (deep security blue, tasteful motion) ---- */}
      <div className="relative hidden lg:flex flex-col justify-center px-16 xl:px-24 overflow-hidden bg-gradient-to-br from-brand-700 via-brand-800 to-brand-900">
        {/* soft drifting highlights */}
        <motion.div
          className="pointer-events-none absolute -top-24 -right-16 h-80 w-80 rounded-full bg-brand-400/20 blur-3xl"
          animate={{ x: [0, 24, 0], y: [0, 18, 0] }}
          transition={{ duration: 14, repeat: Infinity, ease: 'easeInOut' }}
        />
        <motion.div
          className="pointer-events-none absolute bottom-0 -left-20 h-80 w-80 rounded-full bg-accent-500/15 blur-3xl"
          animate={{ x: [0, 20, 0], y: [0, -16, 0] }}
          transition={{ duration: 16, repeat: Infinity, ease: 'easeInOut' }}
        />
        {/* faint grid */}
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.07]"
          style={{ backgroundImage: 'linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)', backgroundSize: '44px 44px' }}
        />

        <motion.div variants={container} initial="hidden" animate="show" className="relative">
          <motion.div variants={item} className="flex items-center gap-3 mb-10">
            <div className="grid h-12 w-12 place-items-center rounded-xl bg-white/10 ring-1 ring-white/20 text-white backdrop-blur">
              <Shield className="h-7 w-7" />
            </div>
            <div>
              <div className="text-2xl font-bold tracking-tight text-white font-display">SENTROID</div>
              <div className="text-[10px] uppercase tracking-[0.28em] text-brand-200">MDM Command Console</div>
            </div>
          </motion.div>

          <motion.h1 variants={item} className="text-4xl xl:text-5xl font-bold leading-[1.1] text-white font-display tracking-tight">
            Secure Remote
            <br />
            <span className="text-accent-300">Support Terminal</span>
          </motion.h1>
          <motion.p variants={item} className="mt-5 max-w-md text-brand-100/80 leading-relaxed">
            Centralized visibility, policy enforcement, and remote command execution across your
            entire Android device fleet — from one hardened console.
          </motion.p>

          <motion.div variants={item} className="mt-10 space-y-3">
            <StatusRow label="Encrypted channel established" delay={0} />
            <StatusRow label="Policy engine online" delay={0.4} />
            <StatusRow label="Real-time device monitoring active" delay={0.8} />
          </motion.div>

          <motion.div variants={item} className="mt-10 flex flex-wrap gap-2.5">
            {['Device Owner', 'RBAC', 'Audit Trail', 'Zero-Touch'].map((c) => (
              <span key={c} className="rounded-full bg-white/10 ring-1 ring-white/15 px-3 py-1 text-xs text-brand-50 backdrop-blur">
                {c}
              </span>
            ))}
          </motion.div>
        </motion.div>
      </div>

      {/* ---- Login card ---- */}
      <div className="flex items-center justify-center px-6 py-12">
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          className="w-full max-w-md"
        >
          {/* mobile brand */}
          <div className="lg:hidden flex flex-col items-center mb-8">
            <div className="grid h-14 w-14 place-items-center rounded-xl bg-brand-600 text-white shadow-md">
              <Shield className="h-8 w-8" />
            </div>
            <div className="mt-3 text-xl font-bold tracking-tight text-brand-800 dark:text-slate-100 font-display">SENTROID</div>
          </div>

          <div className="card p-8">
            <div className="mb-6">
              <h2 className="text-xl font-bold text-brand-800 dark:text-slate-100 font-display">Administrator Access</h2>
              <p className="text-sm text-slate-500 dark:text-slate-400 flex items-center gap-2 mt-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-accent-500 pulse-dot" />
                Authenticate to enter the console
              </p>
            </div>

            <form onSubmit={submit} className="space-y-4">
              <Field icon={<UserIcon />} label="Username">
                <input
                  className="w-full bg-transparent outline-none text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="admin"
                  autoFocus
                />
              </Field>
              <Field icon={<LockIcon />} label="Password">
                <input
                  type="password"
                  className="w-full bg-transparent outline-none text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                />
              </Field>

              <AnimatePresence>
                {error && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1, x: [0, -8, 8, -6, 6, 0] }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.4 }}
                    className="text-sm text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-lg px-3 py-2"
                  >
                    {error}
                  </motion.div>
                )}
              </AnimatePresence>

              <motion.button
                type="submit"
                disabled={busy}
                whileHover={{ scale: 1.01 }}
                whileTap={{ scale: 0.98 }}
                className="w-full rounded-lg bg-brand-600 hover:bg-brand-700 py-3 font-semibold text-white shadow-[0_8px_24px_-10px_rgba(3,105,161,0.6)] disabled:opacity-70 transition-colors"
              >
                <span className="flex items-center justify-center gap-2">
                  {busy ? (
                    <>
                      <span className="h-4 w-4 rounded-full border-2 border-white/40 border-t-white animate-spin" />
                      Authenticating…
                    </>
                  ) : (
                    <>
                      Enter Console
                      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M5 12h14M13 6l6 6-6 6" />
                      </svg>
                    </>
                  )}
                </span>
              </motion.button>
            </form>

            <div className="mt-6 flex items-center justify-between text-xs text-slate-400">
              <span className="font-mono">v1.0 · secure</span>
              <span className="font-mono">admin / Admin@123</span>
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
}

function Field({ icon, label, children }) {
  return (
    <label className="block group">
      <span className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1.5 block">{label}</span>
      <div className="flex items-center gap-2.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3.5 py-2.5 transition-all focus-within:border-brand-600 dark:focus-within:border-brand-400 focus-within:shadow-focus">
        <span className="text-slate-400 group-focus-within:text-brand-600 dark:group-focus-within:text-brand-400 transition-colors">{icon}</span>
        {children}
      </div>
    </label>
  );
}
