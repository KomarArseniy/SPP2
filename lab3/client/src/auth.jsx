import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, setAccessToken, setAuthLostHandler } from './api.js';
import { useToast } from './toast.jsx';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const notify = useToast();
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState('loading'); // loading | anon | authed

  // Сессия завершена на сервере (отозвана, истёк refresh и т.п.) — возвращаем на экран входа.
  useEffect(() => {
    setAuthLostHandler(() => {
      setUser(null);
      setStatus('anon');
      notify('Сессия завершена. Войдите снова.');
    });
  }, [notify]);

  // При загрузке страницы пробуем восстановить вход по refresh-cookie.
  useEffect(() => {
    api.restoreSession()
      .then((data) => { setUser(data.user); setStatus('authed'); })
      .catch(() => setStatus('anon'));
  }, []);

  const startSession = useCallback((data) => { setUser(data.user); setStatus('authed'); return data; }, []);

  const value = useMemo(() => ({
    user,
    status,
    login: (creds) => api.login(creds).then(startSession),
    register: (data) => api.register(data).then(startSession),
    logout: async () => {
      try { await api.logout(); } catch { /* уже вышли */ }
      setAccessToken(null);
      setUser(null);
      setStatus('anon');
    },
  }), [user, status, startSession]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
