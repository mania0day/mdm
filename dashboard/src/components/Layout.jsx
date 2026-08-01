import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuth, hasRole } from '../auth.jsx';
import { api } from '../api';
import ThemeToggle from './ThemeToggle.jsx';

const NAV = [
  { to: '/', label: 'Overview', end: true, icon: 'grid' },
  { to: '/devices', label: 'Devices', icon: 'phone' },
  { to: '/policies', label: 'Policies', icon: 'shield' },
  { to: '/alerts', label: 'Alerts', icon: 'bell' },
  { to: '/enrollment', label: 'Enrollment', icon: 'key', role: 'admin' },
  { to: '/audit', label: 'Audit Logs', icon: 'list' },
  { to: '/users', label: 'Users', icon: 'users', role: 'admin' },
];

const TITLES = {
  '/': 'Operations Overview',
  '/devices': 'Device Inventory',
  '/policies': 'Security Policies',
  '/alerts': 'Monitoring Alerts',
  '/enrollment': 'Device Enrollment',
  '/audit': 'Audit Logs',
  '/users': 'Administrators',
};

function Icon({ name }) {
  const paths = {
    grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
    phone: 'M7 2h10v20H7zM11 18h2',
    shield: 'M12 2l8 3v6c0 5-3.4 8.5-8 11-4.6-2.5-8-6-8-11V5l8-3z',
    bell: 'M6 8a6 6 0 1112 0c0 7 3 9 3 9H3s3-2 3-9M10 21a2 2 0 004 0',
    key: 'M15 7a4 4 0 11-8 0 4 4 0 018 0zM11 11l-7 7v3h3l7-7',
    list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
    users: 'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 7a4 4 0 100 8 4 4 0 000-8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75',
  };
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={paths[name]} />
    </svg>
  );
}

function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="font-mono text-xs text-slate-400 tabular-nums">
      {now.toISOString().slice(11, 19)} <span className="text-slate-300 dark:text-slate-600">UTC</span>
    </span>
  );
}

function Logo() {
  return (
    <div className="grid h-9 w-9 place-items-center rounded-lg bg-brand-600 text-white shadow-sm">
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2l8 3v6c0 5-3.4 8.5-8 11-4.6-2.5-8-6-8-11V5l8-3z" />
        <path d="M9 12l2 2 4-4" />
      </svg>
    </div>
  );
}

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [alertCount, setAlertCount] = useState(0);

  useEffect(() => {
    let live = true;
    const poll = () =>
      api.get('/alerts').then((d) => live && setAlertCount(d.unacknowledged)).catch(() => {});
    poll();
    const t = setInterval(poll, 15000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  async function doLogout() {
    await logout();
    navigate('/login');
  }

  const title = TITLES[location.pathname] || (location.pathname.startsWith('/devices/') ? 'Device Detail' : 'Console');
  const items = NAV.filter((n) => !n.role || hasRole(user, n.role));

  return (
    <div className="bg-app min-h-screen flex">
      {/* Sidebar */}
      <aside className="w-64 shrink-0 bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 flex flex-col">
        <div className="px-5 py-5 flex items-center gap-3 border-b border-slate-100 dark:border-slate-800">
          <Logo />
          <div>
            <div className="font-display font-bold tracking-tight text-brand-800 dark:text-slate-100 leading-tight text-[17px]">SENTROID</div>
            <div className="text-[10px] uppercase tracking-[0.22em] text-slate-400 dark:text-slate-500 font-medium">MDM Console</div>
          </div>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1">
          {items.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                `relative flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
                  isActive
                    ? 'text-brand-700 dark:text-brand-300 font-semibold'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-50 dark:hover:bg-slate-800'
                }`
              }
            >
              {({ isActive }) => (
                <>
                  {isActive && (
                    <motion.span
                      layoutId="nav-active"
                      className="absolute inset-0 rounded-lg bg-brand-50 dark:bg-brand-500/15 border border-brand-100 dark:border-brand-500/25"
                      transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                    />
                  )}
                  {isActive && (
                    <motion.span
                      layoutId="nav-bar"
                      className="absolute left-0 top-1.5 bottom-1.5 w-1 rounded-full bg-brand-600 dark:bg-brand-400"
                      transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                    />
                  )}
                  <span className="relative"><Icon name={n.icon} /></span>
                  <span className="relative flex-1">{n.label}</span>
                  {n.to === '/alerts' && alertCount > 0 && (
                    <span className="relative badge bg-red-100 text-red-700 ring-1 ring-red-600/20 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-400/25">{alertCount}</span>
                  )}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="px-4 py-4 border-t border-slate-100 dark:border-slate-800">
          <div className="flex items-center gap-2.5 mb-3">
            <div className="h-9 w-9 rounded-full bg-brand-600 grid place-items-center text-xs font-bold text-white">
              {(user?.full_name || 'A').slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">{user?.full_name}</div>
              <div className="text-xs text-slate-400 dark:text-slate-500 capitalize">{user?.role?.replace('_', ' ')}</div>
            </div>
          </div>
          <button onClick={doLogout} className="btn-ghost w-full text-xs">Sign out</button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 min-w-0 flex flex-col">
        <header className="sticky top-0 z-20 bg-white/85 dark:bg-slate-900/80 backdrop-blur border-b border-slate-200 dark:border-slate-800 px-6 py-3.5 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="h-1.5 w-1.5 rounded-full bg-brand-500" />
            <h1 className="text-base font-semibold text-brand-800 dark:text-slate-100 font-display tracking-tight">{title}</h1>
          </div>
          <div className="flex items-center gap-4">
            <span className="hidden sm:flex items-center gap-1.5 badge bg-accent-100 text-accent-700 ring-1 ring-accent-600/20 dark:bg-accent-500/15 dark:text-accent-300 dark:ring-accent-400/25">
              <span className="h-1.5 w-1.5 rounded-full bg-accent-500 pulse-dot" /> SECURE
            </span>
            <Clock />
            <ThemeToggle />
          </div>
        </header>

        <div className="flex-1 overflow-auto">
          <div className="max-w-7xl mx-auto px-6 py-6">
            <AnimatePresence mode="wait">
              <motion.div
                key={location.pathname}
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
              >
                <Outlet />
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </main>
    </div>
  );
}
