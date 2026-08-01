import { createContext, useContext, useEffect, useState } from 'react';
import { api, setToken, getToken } from './api';

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    api
      .get('/auth/me')
      .then((d) => setUser(d.user))
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
  }, []);

  async function login(username, password) {
    const d = await api.post('/auth/login', { username, password });
    setToken(d.token);
    setUser(d.user);
    return d.user;
  }

  async function logout() {
    try {
      await api.post('/auth/logout');
    } catch {
      /* ignore */
    }
    setToken(null);
    setUser(null);
  }

  return (
    <AuthCtx.Provider value={{ user, loading, login, logout }}>{children}</AuthCtx.Provider>
  );
}

export const useAuth = () => useContext(AuthCtx);

// Role ranking mirrors the backend config.ROLES.
const ROLE_RANK = { auditor: 1, operator: 2, admin: 3, super_admin: 4 };
export function hasRole(user, role) {
  return (ROLE_RANK[user?.role] || 0) >= (ROLE_RANK[role] || 99);
}
