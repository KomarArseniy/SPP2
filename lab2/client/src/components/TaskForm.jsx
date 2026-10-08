import { useState } from 'react';
import { STATUSES } from '../constants.js';

// Форма создания/редактирования. Проверяет данные на клиенте (быстрая обратная связь)
// и показывает ошибки, пришедшие с сервера, рядом с нужными полями.
export default function TaskForm({ initial, title, submitLabel, onSubmit, onCancel }) {
  const [values, setValues] = useState({
    title: initial?.title ?? '',
    description: initial?.description ?? '',
    dueDate: initial?.dueDate ?? '',
    status: initial?.status ?? 'todo',
  });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);

  const set = (field) => (e) => setValues((v) => ({ ...v, [field]: e.target.value }));

  const validate = () => {
    const e = {};
    if (!values.title.trim()) e.title = 'Введите название задачи.';
    else if (values.title.trim().length > 200) e.title = 'Название не длиннее 200 символов.';
    if (values.description.length > 5000) e.description = 'Описание не длиннее 5000 символов.';
    return e;
  };

  const submit = async (ev) => {
    ev.preventDefault();
    const clientErrors = validate();
    setErrors(clientErrors);
    setFormError(null);
    if (Object.keys(clientErrors).length) return;

    setSaving(true);
    try {
      await onSubmit({ ...values, dueDate: values.dueDate || null });
    } catch (err) {
      setErrors(err.fieldErrors || {});
      setFormError(err.message);
      setSaving(false);
    }
  };

  return (
    <form className="task-form" onSubmit={submit} noValidate>
      <h2>{title}</h2>
      {formError && <div className="alert alert--error">{formError}</div>}

      <label className="field">
        <span>Название *</span>
        <input type="text" value={values.title} onChange={set('title')} maxLength={250} autoFocus />
        {errors.title && <small className="field__error">{errors.title}</small>}
      </label>

      <label className="field">
        <span>Описание</span>
        <textarea rows={3} value={values.description} onChange={set('description')} />
        {errors.description && <small className="field__error">{errors.description}</small>}
      </label>

      <div className="field-row">
        <label className="field">
          <span>Ожидаемая дата завершения</span>
          <input type="date" value={values.dueDate} onChange={set('dueDate')} />
          {errors.dueDate && <small className="field__error">{errors.dueDate}</small>}
        </label>

        <label className="field">
          <span>Статус</span>
          <select value={values.status} onChange={set('status')}>
            {Object.entries(STATUSES).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
          {errors.status && <small className="field__error">{errors.status}</small>}
        </label>
      </div>

      <div className="form-actions">
        <button className="btn btn--primary" type="submit" disabled={saving}>
          {saving ? 'Сохранение…' : submitLabel}
        </button>
        <button className="btn" type="button" onClick={onCancel} disabled={saving}>Отмена</button>
      </div>
    </form>
  );
}
