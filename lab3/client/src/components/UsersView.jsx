import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { ROLES } from '../permissions.js';
import { useAuth } from '../auth.jsx';
import { useToast } from '../toast.jsx';
import { describeAgent, formatDateTime } from '../constants.js';

// Админ-панель: роли, блокировки, подключения пользователей.
export default function UsersView() {
  const { user: me } = useAuth();
  const notify = useToast();
  const [users, setUsers] = useState(null);
  const [error, setError] = useState(null);
  const [openSessions, setOpenSessions] = useState({}); // userId -> список сессий

  const load = useCallback(async () => {
    try {
      setUsers(await api.listUsers());
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const run = async (action, okText) => {
    try {
      await action();
      if (okText) notify(okText, 'success');
    } catch (err) {
      notify(err.message);
    }
    load();
  };

  const toggleSessions = async (u) => {
    if (openSessions[u.id]) {
      setOpenSessions((s) => ({ ...s, [u.id]: null }));
      return;
    }
    try {
      setOpenSessions((s) => ({ ...s, [u.id]: [] }));
      const list = await api.listUserSessions(u.id);
      setOpenSessions((s) => ({ ...s, [u.id]: list }));
    } catch (err) {
      notify(err.message);
    }
  };

  return (
    <>
      <div className="view-header">
        <div>
          <h2>Пользователи</h2>
          <p className="subtitle">Роли, блокировки входа и подключения</p>
        </div>
      </div>

      {error && <div className="alert alert--error">{error}</div>}
      {!users && !error && <p className="empty-state">Загрузка…</p>}

      <ul className="task-list">
        {users?.map((u) => (
          <li key={u.id} className="task-card">
            <div className="task-card__main">
              <span className="task-card__title">
                {u.name} {u.id === me.id && <span className="badge badge--todo">это вы</span>}
              </span>
              {u.locked && <span className="badge badge--lock">Вход заблокирован</span>}
            </div>
            <div className="meta-row">
              <span className="meta-item">{u.email}</span>
              <span className="meta-item">Последний вход: {formatDateTime(u.lastLoginAt)}</span>
              <span className="meta-item">Подключений: {u.activeSessions}</span>
            </div>

            <div className="task-card__actions">
              <select
                value={u.role}
                disabled={u.id === me.id}
                title={u.id === me.id ? 'Свою роль менять нельзя' : 'Роль'}
                onChange={(e) => run(() => api.updateUser(u.id, { role: e.target.value }), 'Роль изменена')}
                aria-label="Роль"
              >
                {Object.entries(ROLES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              {u.locked && (
                <button className="btn btn--small" onClick={() => run(() => api.unlockUser(u.id), 'Блокировка снята')}>
                  Разблокировать
                </button>
              )}
              <button className="btn btn--small" onClick={() => toggleSessions(u)}>
                {openSessions[u.id] ? 'Скрыть подключения' : 'Подключения'}
              </button>
              {u.id !== me.id && u.activeSessions > 0 && (
                <button
                  className="btn btn--small btn--danger"
                  onClick={() => run(async () => {
                    await api.revokeUserSessions(u.id);
                    setOpenSessions((s) => ({ ...s, [u.id]: null }));
                  }, 'Подключения завершены')}
                >
                  Завершить все
                </button>
              )}
              {u.id !== me.id && (
                <button
                  className="btn btn--small btn--danger"
                  onClick={() => window.confirm(`Удалить пользователя «${u.name}»?`) && run(() => api.deleteUser(u.id), 'Пользователь удалён')}
                >
                  Удалить
                </button>
              )}
            </div>

            {openSessions[u.id] && (
              <ul className="attachment-list">
                {openSessions[u.id].length === 0 && <li className="meta-item">Нет активных подключений</li>}
                {openSessions[u.id].map((s) => (
                  <li key={s.id} className="attachment-item">
                    {describeAgent(s.userAgent)} · {s.ip || '—'} · активность {formatDateTime(s.lastUsedAt)}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
