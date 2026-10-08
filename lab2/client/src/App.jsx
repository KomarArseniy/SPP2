import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { FILTERS } from './constants.js';
import TaskItem from './components/TaskItem.jsx';
import TaskForm from './components/TaskForm.jsx';
import Toasts from './components/Toasts.jsx';

export default function App() {
  const [tasks, setTasks] = useState([]);
  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState(''); // «отложенное» значение поиска
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [toasts, setToasts] = useState([]);
  const toastId = useRef(0);

  const notify = useCallback((text, type = 'error') => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, text, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), type === 'error' ? 7000 : 3000);
  }, []);
  const dismissToast = (id) => setToasts((t) => t.filter((x) => x.id !== id));

  // debounce поиска
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setTasks(await api.listTasks({ status, q: query }));
      setLoadError(null);
    } catch (err) {
      setLoadError(err.message);
    } finally {
      setLoading(false);
    }
  }, [status, query]);

  useEffect(() => { load(); }, [load]);

  // --- операции над задачами: обновляем состояние без перезагрузки страницы ---
  const matchesFilter = (t) => status === 'all' || t.status === status;

  const handleCreate = async (data) => {
    const task = await api.createTask(data); // ошибки обработает форма
    if (matchesFilter(task)) setTasks((list) => [task, ...list]);
    setCreating(false);
    notify('Задача создана', 'success');
    return task;
  };

  const replaceTask = (task) =>
    setTasks((list) =>
      matchesFilter(task) ? list.map((t) => (t.id === task.id ? task : t)) : list.filter((t) => t.id !== task.id)
    );

  const handleUpdate = async (id, data) => {
    const task = await api.updateTask(id, data);
    replaceTask(task);
    notify('Изменения сохранены', 'success');
    return task;
  };

  const handleStatus = async (id, newStatus) => {
    try {
      replaceTask(await api.patchTask(id, { status: newStatus }));
    } catch (err) {
      notify(err.message);
      if (err.status === 404) load();
    }
  };

  const handleDelete = async (id) => {
    try {
      await api.deleteTask(id);
      setTasks((list) => list.filter((t) => t.id !== id));
      notify('Задача удалена', 'success');
    } catch (err) {
      notify(err.message);
      if (err.status === 404) setTasks((list) => list.filter((t) => t.id !== id));
    }
  };

  const handleUpload = async (id, files) => {
    const created = await api.uploadFiles(id, files);
    setTasks((list) =>
      list.map((t) => (t.id === id ? { ...t, attachments: [...t.attachments, ...created] } : t))
    );
    notify(`Загружено файлов: ${created.length}`, 'success');
  };

  const handleDeleteAttachment = async (taskId, attId) => {
    try {
      await api.deleteAttachment(taskId, attId);
      setTasks((list) =>
        list.map((t) =>
          t.id === taskId ? { ...t, attachments: t.attachments.filter((a) => a.id !== attId) } : t
        )
      );
    } catch (err) {
      notify(err.message);
      if (err.status === 404) load();
    }
  };

  return (
    <div className="container">
      <header className="page-header">
        <h1>Список задач</h1>
        {!creating && (
          <button className="btn btn--primary" onClick={() => setCreating(true)}>
            + Новая задача
          </button>
        )}
      </header>

      {creating && (
        <TaskForm
          title="Новая задача"
          submitLabel="Создать"
          onSubmit={handleCreate}
          onCancel={() => setCreating(false)}
        />
      )}

      <div className="toolbar">
        <nav className="filters">
          {FILTERS.map(([value, label]) => (
            <button
              key={value}
              className={`filter-link ${status === value ? 'filter-link--active' : ''}`}
              onClick={() => setStatus(value)}
            >
              {label}
            </button>
          ))}
        </nav>
        <input
          className="search"
          type="search"
          placeholder="Поиск по названию и описанию…"
          value={search}
          maxLength={200}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {loadError && (
        <div className="alert alert--error">
          {loadError} <button className="btn btn--small" onClick={load}>Повторить</button>
        </div>
      )}

      {loading && tasks.length === 0 && !loadError && <p className="empty-state">Загрузка…</p>}
      {!loading && !loadError && tasks.length === 0 && (
        <p className="empty-state">
          {query || status !== 'all' ? 'Ничего не найдено.' : 'Задач пока нет. Создайте первую!'}
        </p>
      )}

      <ul className="task-list">
        {tasks.map((task) => (
          <TaskItem
            key={task.id}
            task={task}
            onStatus={handleStatus}
            onUpdate={handleUpdate}
            onDelete={handleDelete}
            onUpload={handleUpload}
            onDeleteAttachment={handleDeleteAttachment}
          />
        ))}
      </ul>

      <Toasts toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
