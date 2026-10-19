import { useState } from 'react';
import { api } from '../api.js';

// Открывается по ссылке из письма: /?reset_token=...
export default function ResetPassword({ token, onDone }) {
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState(null);
  const [fieldError, setFieldError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (ev) => {
    ev.preventDefault();
    setError(null);
    setFieldError(null);
    if (password.length < 8) return setFieldError('Не менее 8 символов, буквы и цифры.');
    if (password !== repeat) return setFieldError('Пароли не совпадают.');

    setBusy(true);
    try {
      await api.resetPassword(token, password);
      onDone();
    } catch (err) {
      setFieldError(err.fieldErrors?.password || null);
      setError(err.fieldErrors?.password ? null : err.message);
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <form className="task-form auth-card" onSubmit={submit} noValidate>
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">✓</span>
          <div>
            <h1>Новый пароль</h1>
            <p className="subtitle">Восстановление доступа</p>
          </div>
        </div>
        {error && <div className="alert alert--error" role="alert">{error}</div>}
        <label className="field">
          <span>Новый пароль</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" autoFocus />
          {fieldError && <small className="field__error">{fieldError}</small>}
        </label>
        <label className="field">
          <span>Повторите пароль</span>
          <input type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" />
        </label>
        <button className="btn btn--primary auth-submit" type="submit" disabled={busy}>
          {busy ? 'Сохранение…' : 'Сохранить пароль'}
        </button>
        <div className="auth-links">
          <button type="button" className="link-btn" onClick={onDone}>← Ко входу</button>
        </div>
      </form>
    </div>
  );
}
