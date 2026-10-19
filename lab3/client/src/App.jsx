import { useState } from 'react';
import { useAuth } from './auth.jsx';
import { useToast } from './toast.jsx';
import { ROLES } from './permissions.js';
import AuthScreen from './components/AuthScreen.jsx';
import ResetPassword from './components/ResetPassword.jsx';
import TasksView from './components/TasksView.jsx';
import SessionsView from './components/SessionsView.jsx';
import UsersView from './components/UsersView.jsx';

export default function App() {
  const { user, status, logout } = useAuth();
  const notify = useToast();
  const [view, setView] = useState('tasks'); // tasks | security | users
  // ссылка из письма: /?reset_token=...
  const [resetToken, setResetToken] = useState(() => new URLSearchParams(window.location.search).get('reset_token'));

  const finishReset = () => {
    window.history.replaceState({}, '', window.location.pathname);
    setResetToken(null);
    notify('Пароль изменён. Теперь можно войти.', 'success');
  };

  if (status === 'loading') return <p className="empty-state">Загрузка…</p>;
  if (!user) return resetToken ? <ResetPassword token={resetToken} onDone={finishReset} /> : <AuthScreen />;

  const tabs = [['tasks', 'Задачи'], ['security', 'Безопасность'], ...(user.role === 'admin' ? [['users', 'Пользователи']] : [])];
  const current = tabs.some(([id]) => id === view) ? view : 'tasks';

  return (
    <div className="container">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">✓</span>
          <h1>Список задач</h1>
        </div>
        <div className="userbox">
          <div className="userbox__info">
            <strong>{user.name}</strong>
            <span className={`role-badge role-badge--${user.role}`}>{ROLES[user.role]}</span>
          </div>
          <button className="btn btn--small" onClick={logout}>Выйти</button>
        </div>
      </header>

      <nav className="tabs">
        {tabs.map(([id, label]) => (
          <button key={id} className={`tab ${current === id ? 'tab--active' : ''}`} onClick={() => setView(id)}>{label}</button>
        ))}
      </nav>

      {current === 'tasks' && <TasksView />}
      {current === 'security' && <SessionsView />}
      {current === 'users' && user.role === 'admin' && <UsersView />}
    </div>
  );
}
