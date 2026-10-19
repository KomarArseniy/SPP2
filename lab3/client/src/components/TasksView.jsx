import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { FILTERS } from '../constants.js';
import { canCreate } from '../permissions.js';
import { useAuth } from '../auth.jsx';
import { useToast } from '../toast.jsx';
import TaskItem from './TaskItem.jsx';
import TaskForm from './TaskForm.jsx';

export default function TasksView() {
  const { user } = useAuth();
  const notify = useToast();
  const [tasks, setTasks] = useState([]);
  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState(''); // «отложенное» значение поиска
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [creating, setCreating] = useState(false);

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
      if (err.status === 404 || err.status === 403) load();
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
    setTasks((list) => list.map((t) => (t.id === id ? { ...t, attachments: [...t.attachments, ...created] } : t)));
    notify(`Загружено файлов: ${created.length}`, 'success');
  };

  const handleDeleteAttachment = async (taskId, attId) => {
    try {
      await api.deleteAttachment(taskId, attId);
      setTasks((list) =>
        list.map((t) => (t.id === taskId ? { ...t, attachments: t.attachments.filter((a) => a.id !== attId) } : t))
      );
    } catch (err) {
      notify(err.message);
      if (err.status === 404) load();
    }
  };

  const handleDownload = async (attachment) => {
    try {
      await api.downloadAttachment(attachment);
    } catch (err) {
      notify(err.message);
    }
  };

  return (
    <>
      <div className="view-header">
        <div>
          <h2>Задачи</h2>
          <p className="subtitle">{loading && tasks.length === 0 ? 'Загрузка…' : `Показано задач: ${tasks.length}`}</p>
        </div>
        {canCreate(user) && !creating && (
          <button className="btn btn--primary" onClick={() => setCreating(true)}>+ Новая задача</button>
        )}
      </div>

      {user.role === 'viewer' && (
        <div className="alert alert--info">У вас роль «Наблюдатель»: задачи доступны только для просмотра и скачивания файлов.</div>
      )}

      {creating && (
        <TaskForm title="Новая задача" submitLabel="Создать" onSubmit={handleCreate} onCancel={() => setCreating(false)} />
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
          {query || status !== 'all' ? 'Ничего не найдено.' : 'Задач пока нет.'}
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
            onDownload={handleDownload}
          />
        ))}
      </ul>
    </>
  );
}
