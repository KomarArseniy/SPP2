// Валидация входящих данных. Каждая функция возвращает { value, errors },
// где errors — массив { field, message }.

const STATUSES = ['todo', 'in_progress', 'done'];
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 5000;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isValidDate(str) {
  if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const d = new Date(`${str}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === str;
}

// Проверка идентификатора из URL: положительное целое в пределах INTEGER.
function parseId(raw) {
  if (!/^\d+$/.test(String(raw))) return null;
  const n = Number(raw);
  return n >= 1 && n <= 2147483647 ? n : null;
}

// Полная валидация задачи (POST и PUT). Для PATCH partial=true — поля необязательны.
function validateTask(body, { partial = false } = {}) {
  const errors = [];
  const value = {};

  if (!isPlainObject(body)) {
    return { value, errors: [{ field: 'body', message: 'Тело запроса должно быть JSON-объектом.' }] };
  }

  if (!partial || body.title !== undefined) {
    if (typeof body.title !== 'string' || !body.title.trim()) {
      errors.push({ field: 'title', message: 'Название обязательно и должно быть непустой строкой.' });
    } else if (body.title.trim().length > MAX_TITLE) {
      errors.push({ field: 'title', message: `Название не длиннее ${MAX_TITLE} символов.` });
    } else {
      value.title = body.title.trim();
    }
  }

  if (body.description !== undefined || !partial) {
    const d = body.description === undefined || body.description === null ? '' : body.description;
    if (typeof d !== 'string') {
      errors.push({ field: 'description', message: 'Описание должно быть строкой.' });
    } else if (d.length > MAX_DESCRIPTION) {
      errors.push({ field: 'description', message: `Описание не длиннее ${MAX_DESCRIPTION} символов.` });
    } else {
      value.description = d.trim();
    }
  }

  if (body.status !== undefined || !partial) {
    const s = body.status === undefined ? 'todo' : body.status;
    if (!STATUSES.includes(s)) {
      errors.push({ field: 'status', message: `Статус должен быть одним из: ${STATUSES.join(', ')}.` });
    } else {
      value.status = s;
    }
  }

  if (body.dueDate !== undefined || !partial) {
    const dd = body.dueDate === undefined || body.dueDate === '' ? null : body.dueDate;
    if (dd !== null && !isValidDate(dd)) {
      errors.push({ field: 'dueDate', message: 'Дата должна быть в формате ГГГГ-ММ-ДД и существовать в календаре.' });
    } else {
      value.dueDate = dd;
    }
  }

  return { value, errors };
}

function validateListQuery(query) {
  const errors = [];
  const value = { status: null, q: null };
  if (query.status !== undefined && query.status !== 'all') {
    if (typeof query.status !== 'string' || !STATUSES.includes(query.status)) {
      errors.push({ field: 'status', message: `Фильтр status: all или ${STATUSES.join(', ')}.` });
    } else {
      value.status = query.status;
    }
  }
  if (query.q !== undefined) {
    if (typeof query.q !== 'string' || query.q.length > 200) {
      errors.push({ field: 'q', message: 'Параметр q должен быть строкой до 200 символов.' });
    } else if (query.q.trim()) {
      value.q = query.q.trim();
    }
  }
  return { value, errors };
}

module.exports = { STATUSES, parseId, validateTask, validateListQuery };
