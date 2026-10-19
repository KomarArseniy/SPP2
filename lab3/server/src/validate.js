// Валидация входных данных. Каждая функция возвращает { value, errors },
// где errors — массив { field, message }.

const STATUSES = ['todo', 'in_progress', 'done'];
const ROLES = ['viewer', 'user', 'admin'];
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

const bodyError = { value: {}, errors: [{ field: 'body', message: 'Тело запроса должно быть JSON-объектом.' }] };

// ---------- задачи ----------
// Полная валидация (POST и PUT). Для PATCH partial=true — поля необязательны.
function validateTask(body, { partial = false } = {}) {
  const errors = [];
  const value = {};
  if (!isPlainObject(body)) return bodyError;

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

// ---------- пользователи и пароли ----------
function checkEmail(raw, errors) {
  if (typeof raw !== 'string' || !raw.trim()) {
    errors.push({ field: 'email', message: 'Укажите email.' });
    return null;
  }
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push({ field: 'email', message: 'Некорректный email.' });
    return null;
  }
  return email;
}

function checkNewPassword(raw, errors, field = 'password') {
  if (typeof raw !== 'string' || raw.length < 8) {
    errors.push({ field, message: 'Пароль должен содержать не менее 8 символов.' });
    return null;
  }
  if (raw.length > 128) {
    errors.push({ field, message: 'Пароль не длиннее 128 символов.' });
    return null;
  }
  if (!/[A-Za-zА-Яа-яЁё]/.test(raw) || !/\d/.test(raw)) {
    errors.push({ field, message: 'Пароль должен содержать и буквы, и цифры.' });
    return null;
  }
  return raw;
}

function validateRegister(body) {
  if (!isPlainObject(body)) return bodyError;
  const errors = [];
  const email = checkEmail(body.email, errors);
  const password = checkNewPassword(body.password, errors);
  let name = null;
  if (typeof body.name !== 'string' || !body.name.trim()) {
    errors.push({ field: 'name', message: 'Укажите имя.' });
  } else if (body.name.trim().length > 100) {
    errors.push({ field: 'name', message: 'Имя не длиннее 100 символов.' });
  } else {
    name = body.name.trim();
  }
  return { value: { email, password, name }, errors };
}

function validateLogin(body) {
  if (!isPlainObject(body)) return bodyError;
  const errors = [];
  const email = checkEmail(body.email, errors);
  if (typeof body.password !== 'string' || !body.password || body.password.length > 128) {
    errors.push({ field: 'password', message: 'Укажите пароль.' });
  }
  return { value: { email, password: body.password }, errors };
}

function validateForgot(body) {
  if (!isPlainObject(body)) return bodyError;
  const errors = [];
  const email = checkEmail(body.email, errors);
  return { value: { email }, errors };
}

function validateReset(body) {
  if (!isPlainObject(body)) return bodyError;
  const errors = [];
  if (typeof body.token !== 'string' || !/^[\w-]{20,200}$/.test(body.token)) {
    errors.push({ field: 'token', message: 'Некорректная ссылка восстановления.' });
  }
  const password = checkNewPassword(body.password, errors);
  return { value: { token: body.token, password }, errors };
}

function validateChangePassword(body) {
  if (!isPlainObject(body)) return bodyError;
  const errors = [];
  if (typeof body.currentPassword !== 'string' || !body.currentPassword) {
    errors.push({ field: 'currentPassword', message: 'Укажите текущий пароль.' });
  }
  const newPassword = checkNewPassword(body.newPassword, errors, 'newPassword');
  return { value: { currentPassword: body.currentPassword, newPassword }, errors };
}

function validateUserPatch(body) {
  if (!isPlainObject(body)) return bodyError;
  const errors = [];
  const value = {};
  if (body.role !== undefined) {
    if (!ROLES.includes(body.role)) errors.push({ field: 'role', message: `Роль должна быть одной из: ${ROLES.join(', ')}.` });
    else value.role = body.role;
  }
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 100) {
      errors.push({ field: 'name', message: 'Имя — непустая строка до 100 символов.' });
    } else value.name = body.name.trim();
  }
  if (!errors.length && !Object.keys(value).length) {
    errors.push({ field: 'body', message: 'Не передано ни одного поля для изменения (role, name).' });
  }
  return { value, errors };
}

module.exports = {
  STATUSES, ROLES, parseId, validateTask, validateListQuery,
  validateRegister, validateLogin, validateForgot, validateReset, validateChangePassword, validateUserPatch,
};
