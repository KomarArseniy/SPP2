import { useRef, useState } from 'react';
import { STATUSES, formatDate, formatSize, isOverdue, MAX_FILE_SIZE } from '../constants.js';
import TaskForm from './TaskForm.jsx';

export default function TaskItem({ task, onStatus, onUpdate, onDelete, onUpload, onDeleteAttachment }) {
  const [editing, setEditing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const fileInput = useRef(null);
  const overdue = isOverdue(task);

  const handleFiles = async (e) => {
    const files = Array.from(e.target.files);
    e.target.value = '';
    if (!files.length) return;
    setUploadError(null);

    const tooBig = files.find((f) => f.size > MAX_FILE_SIZE);
    if (tooBig) {
      setUploadError(`Файл «${tooBig.name}» больше 10 МБ.`);
      return;
    }
    setUploading(true);
    try {
      await onUpload(task.id, files);
    } catch (err) {
      setUploadError(err.message);
    } finally {
      setUploading(false);
    }
  };

  const confirmDelete = () => {
    if (window.confirm(`Удалить задачу «${task.title}» вместе с файлами?`)) onDelete(task.id);
  };

  if (editing) {
    return (
      <li className="task-card">
        <TaskForm
          initial={task}
          title="Редактирование задачи"
          submitLabel="Сохранить"
          onSubmit={async (data) => {
            await onUpdate(task.id, data);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      </li>
    );
  }

  return (
    <li className={`task-card ${overdue ? 'task-card--overdue' : ''}`}>
      <div className="task-card__main">
        <span className="task-card__title">{task.title}</span>
        <span className={`badge badge--${task.status}`}>{STATUSES[task.status]}</span>
      </div>

      {task.description && <p className="task-card__description">{task.description}</p>}

      {task.dueDate && (
        <div className="meta-item">
          Срок: {formatDate(task.dueDate)}
          {overdue && <strong className="overdue-label"> просрочено</strong>}
        </div>
      )}

      <ul className="attachment-list">
        {task.attachments.map((a) => (
          <li key={a.id} className="attachment-item">
            <a href={a.url} download>{a.name}</a>
            <span className="attachment-size">({formatSize(a.size)})</span>
            <button
              className="btn btn--small btn--danger"
              onClick={() => onDeleteAttachment(task.id, a.id)}
              aria-label={`Удалить файл ${a.name}`}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      {uploadError && <div className="alert alert--error">{uploadError}</div>}

      <div className="task-card__actions">
        <select value={task.status} onChange={(e) => onStatus(task.id, e.target.value)} aria-label="Статус">
          {Object.entries(STATUSES).map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>

        <input ref={fileInput} type="file" multiple hidden onChange={handleFiles} />
        <button className="btn btn--small" onClick={() => fileInput.current.click()} disabled={uploading}>
          {uploading ? 'Загрузка…' : '📎 Прикрепить'}
        </button>
        <button className="btn btn--small" onClick={() => setEditing(true)}>Изменить</button>
        <button className="btn btn--small btn--danger" onClick={confirmDelete}>Удалить</button>
      </div>
    </li>
  );
}
