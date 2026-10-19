import { useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';

const TITLES = { login: 'Вход', register: 'Регистрация', forgot: 'Восстановление доступа' };

export default function AuthScreen() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState('login'); // login | register | forgot
  const [values, setValues] = useState({ name: '', email: '', password: '' });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);

  const set = (field) => (e) => setValues((v) => ({ ...v, [field]: e.target.value }));
  const switchMode = (m) => { setMode(m); setErrors({}); setFormError(null); setInfo(null); };

  const validate = () => {
    const e = {};
    if (!values.email.trim()) e.email = 'Укажите email.';
    if (mode === 'register' && !values.name.trim()) e.name = 'Укажите имя.';
    if (mode !== 'forgot') {
      if (!values.password) e.password = 'Укажите пароль.';
      else if (mode === 'register' && values.password.length < 8) e.password = 'Не менее 8 символов, буквы и цифры.';
    }
    return e;
  };

  const submit = async (ev) => {
    ev.preventDefault();
    const clientErrors = validate();
    setErrors(clientErrors);
    setFormError(null);
    setInfo(null);
    if (Object.keys(clientErrors).length) return;

    setBusy(true);
    try {
      if (mode === 'login') await login({ email: values.email, password: values.password });
      else if (mode === 'register') await register(values);
      else setInfo((await api.forgotPassword(values.email)).message);
    } catch (err) {
      setErrors(err.fieldErrors || {});
      setFormError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <form className="task-form auth-card" onSubmit={submit} noValidate>
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">✓</span>
          <div>
            <h1>Список задач</h1>
            <p className="subtitle">{TITLES[mode]}</p>
          </div>
        </div>

        {formError && <div className="alert alert--error" role="alert">{formError}</div>}
        {info && <div className="alert alert--ok" role="status">{info}</div>}

        {mode === 'register' && (
          <label className="field">
            <span>Имя</span>
            <input type="text" value={values.name} onChange={set('name')} maxLength={100} autoComplete="name" />
            {errors.name && <small className="field__error">{errors.name}</small>}
          </label>
        )}

        <label className="field">
          <span>Email</span>
          <input type="email" value={values.email} onChange={set('email')} autoComplete="email" autoFocus />
          {errors.email && <small className="field__error">{errors.email}</small>}
        </label>

        {mode !== 'forgot' && (
          <label className="field">
            <span>Пароль</span>
            <input
              type="password"
              value={values.password}
              onChange={set('password')}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
            {errors.password && <small className="field__error">{errors.password}</small>}
          </label>
        )}

        <button className="btn btn--primary auth-submit" type="submit" disabled={busy}>
          {busy ? 'Подождите…' : mode === 'login' ? 'Войти' : mode === 'register' ? 'Создать аккаунт' : 'Отправить ссылку'}
        </button>

        <div className="auth-links">
          {mode !== 'login' && <button type="button" className="link-btn" onClick={() => switchMode('login')}>← Ко входу</button>}
          {mode === 'login' && (
            <>
              <button type="button" className="link-btn" onClick={() => switchMode('register')}>Регистрация</button>
              <button type="button" className="link-btn" onClick={() => switchMode('forgot')}>Забыли пароль?</button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}
