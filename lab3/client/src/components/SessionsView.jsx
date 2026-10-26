import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { describeAgent, formatDateTime } from '../constants.js';
import { useToast } from '../toast.jsx';

// «Безопасность»: контроль активных подключений + смена пароля.
export default function SessionsView() {
  const notify = useToast();
  const [sessions, setSessions] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      setSessions(await api.listSessions());
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const revoke = async (id) => {
    try {
      await api.revokeSession(id);
      notify('Подключение завершено', 'success');
      load();
    } catch (err) {
      notify(err.message);
      load();
    }
  };

  const revokeOthers = async () => {
    try {
      await api.revokeOtherSessions();
      notify('Остальные подключения завершены', 'success');
      load();
    } catch (err) {
      notify(err.message);
    }
  };

  return (
    <>
      <div className="view-header">
        <div>
          <h2>Безопасность</h2>
          <p className="subtitle">Активные подключения к вашему аккаунту</p>
        </div>
        {sessions && sessions.length > 1 && (
          <button className="btn btn--danger" onClick={revokeOthers}>Выйти на всех остальных устройствах</button>
        )}
      </div>

      {error && <div className="alert alert--error">{error}</div>}
      {!sessions && !error && <p className="empty-state">Загрузка…</p>}

      <ul className="task-list">
        {sessions?.map((s) => (
          <li key={s.id} className={`task-card ${s.current ? 'task-card--current' : ''}`}>
            <div className="task-card__main">
              <span className="task-card__title">{describeAgent(s.userAgent)}</span>
              {s.current ? <span className="badge badge--done">Это устройство</span> : (
                <button className="btn btn--small btn--danger" onClick={() => revoke(s.id)}>Завершить</button>
              )}
            </div>
            <div className="meta-row">
              <span className="meta-item">IP: {s.ip || '—'}</span>
              <span className="meta-item">Вход: {formatDateTime(s.createdAt)}</span>
              <span className="meta-item">Активность: {formatDateTime(s.lastUsedAt)}</span>
            </div>
          </li>
        ))}
      </ul>

      <ChangePassword notify={notify} onChanged={load} />
    </>
  );
}

function ChangePassword({ notify, onChanged }) {
  const [values, setValues] = useState({ currentPassword: '', newPassword: '' });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (f) => (e) => setValues((v) => ({ ...v, [f]: e.target.value }));

  const submit = async (ev) => {
    ev.preventDefault();
    setErrors({});
    setFormError(null);
    setBusy(true);
    try {
      await api.changePassword(values);
      setValues({ currentPassword: '', newPassword: '' });
      notify('Пароль изменён, остальные подключения завершены', 'success');
      onChanged();
    } catch (err) {
      setErrors(err.fieldErrors || {});
      setFormError(Object.keys(err.fieldErrors || {}).length ? null : err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="task-form" onSubmit={submit} style={{ marginTop: 24 }} noValidate>
      <h3>Смена пароля</h3>
      {formError && <div className="alert alert--error">{formError}</div>}
      <div className="field-row">
        <label className="field">
          <span>Текущий пароль</span>
          <input type="password" value={values.currentPassword} onChange={set('currentPassword')} autoComplete="current-password" />
          {errors.currentPassword && <small className="field__error">{errors.currentPassword}</small>}
        </label>
        <label className="field">
          <span>Новый пароль</span>
          <input type="password" value={values.newPassword} onChange={set('newPassword')} autoComplete="new-password" />
          {errors.newPassword && <small className="field__error">{errors.newPassword}</small>}
        </label>
      </div>
      <button className="btn btn--primary" type="submit" disabled={busy}>{busy ? 'Сохранение…' : 'Изменить пароль'}</button>
    </form>
  );
}
