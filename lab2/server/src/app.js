// REST API: задачи + вложения.
//
//  GET    /api/health
//  GET    /api/tasks?status=&q=              200  список (фильтр по статусу, поиск)
//  POST   /api/tasks                         201  создать (JSON)
//  GET    /api/tasks/:id                     200  одна задача (с вложениями)
//  PUT    /api/tasks/:id                     200  полная замена полей (JSON)
//  PATCH  /api/tasks/:id                     200  частичное изменение (JSON)
//  DELETE /api/tasks/:id                     204  удалить задачу и её файлы
//  POST   /api/tasks/:id/attachments         201  загрузить файлы (multipart/form-data)
//  GET    /api/tasks/:id/attachments/:aid    200  скачать файл
//  DELETE /api/tasks/:id/attachments/:aid    204  удалить файл

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const { pool } = require('./db');
const { HttpError, badRequest, notFound } = require('./errors');
const { parseId, validateTask, validateListQuery } = require('./validate');

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '..', 'uploads');
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_FILES = 10;
const MAX_FILES_PER_TASK = 20;

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) =>
      cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).slice(0, 20)}`),
  }),
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES },
}).array('files', MAX_FILES);

// multer отдаёт имя в latin1 — возвращаем нормальный UTF-8 (кириллица).
const fixName = (name) => Buffer.from(name, 'latin1').toString('utf8').slice(0, 255);

const removeFile = (storedName) =>
  fs.promises.unlink(path.join(UPLOADS_DIR, storedName)).catch(() => {});

// ---------- Преобразование строк БД в JSON ----------
function dateToString(d) {
  if (!d) return null;
  // DATE приходит как Date в локальной зоне процесса — собираем строку вручную.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const toAttachment = (r) => ({
  id: r.id,
  taskId: r.task_id,
  name: r.original_name,
  mimeType: r.mime_type,
  size: r.size,
  createdAt: r.created_at,
  url: `/api/tasks/${r.task_id}/attachments/${r.id}`,
});

const toTask = (r, attachments = []) => ({
  id: r.id,
  title: r.title,
  description: r.description,
  status: r.status,
  dueDate: dateToString(r.due_date),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  attachments,
});

async function loadAttachments(taskIds) {
  if (!taskIds.length) return new Map();
  const { rows } = await pool.query(
    'SELECT * FROM attachments WHERE task_id = ANY($1) ORDER BY id',
    [taskIds]
  );
  const map = new Map();
  rows.forEach((r) => {
    if (!map.has(r.task_id)) map.set(r.task_id, []);
    map.get(r.task_id).push(toAttachment(r));
  });
  return map;
}

async function getTaskOr404(id) {
  const { rows } = await pool.query('SELECT * FROM tasks WHERE id = $1', [id]);
  if (!rows[0]) throw notFound(`Задача с id=${id} не найдена.`);
  const att = await loadAttachments([id]);
  return toTask(rows[0], att.get(id) || []);
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function idParam(raw, what = 'id') {
  const id = parseId(raw);
  if (id === null) throw badRequest(`Некорректный ${what}: ожидается положительное целое число.`);
  return id;
}

// ---------- Приложение ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

const api = express.Router();

api.get('/health', wrap(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok' });
}));

api.get('/tasks', wrap(async (req, res) => {
  const { value, errors } = validateListQuery(req.query);
  if (errors.length) throw badRequest('Некорректные параметры запроса.', errors);

  const where = [];
  const params = [];
  if (value.status) {
    params.push(value.status);
    where.push(`status = $${params.length}`);
  }
  if (value.q) {
    params.push(`%${value.q.replace(/[\\%_]/g, '\\$&')}%`);
    where.push(`(title ILIKE $${params.length} OR description ILIKE $${params.length})`);
  }
  const sql = `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY created_at DESC, id DESC`;
  const { rows } = await pool.query(sql, params);
  const att = await loadAttachments(rows.map((r) => r.id));
  res.json(rows.map((r) => toTask(r, att.get(r.id) || [])));
}));

api.post('/tasks', wrap(async (req, res) => {
  const { value, errors } = validateTask(req.body);
  if (errors.length) throw badRequest('Данные не прошли проверку.', errors);

  const { rows } = await pool.query(
    `INSERT INTO tasks (title, description, status, due_date)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [value.title, value.description, value.status, value.dueDate]
  );
  res.status(201).location(`/api/tasks/${rows[0].id}`).json(toTask(rows[0]));
}));

api.get('/tasks/:id', wrap(async (req, res) => {
  res.json(await getTaskOr404(idParam(req.params.id)));
}));

api.put('/tasks/:id', wrap(async (req, res) => {
  const id = idParam(req.params.id);
  const { value, errors } = validateTask(req.body);
  if (errors.length) throw badRequest('Данные не прошли проверку.', errors);

  const { rows } = await pool.query(
    `UPDATE tasks SET title=$1, description=$2, status=$3, due_date=$4, updated_at=now()
     WHERE id=$5 RETURNING *`,
    [value.title, value.description, value.status, value.dueDate, id]
  );
  if (!rows[0]) throw notFound(`Задача с id=${id} не найдена.`);
  const att = await loadAttachments([id]);
  res.json(toTask(rows[0], att.get(id) || []));
}));

api.patch('/tasks/:id', wrap(async (req, res) => {
  const id = idParam(req.params.id);
  const { value, errors } = validateTask(req.body, { partial: true });
  if (errors.length) throw badRequest('Данные не прошли проверку.', errors);
  if (!Object.keys(value).length) {
    throw badRequest('Не передано ни одного поля для изменения.');
  }

  const columns = { title: 'title', description: 'description', status: 'status', dueDate: 'due_date' };
  const sets = [];
  const params = [];
  Object.entries(value).forEach(([key, v]) => {
    params.push(v);
    sets.push(`${columns[key]} = $${params.length}`);
  });
  params.push(id);
  const { rows } = await pool.query(
    `UPDATE tasks SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (!rows[0]) throw notFound(`Задача с id=${id} не найдена.`);
  const att = await loadAttachments([id]);
  res.json(toTask(rows[0], att.get(id) || []));
}));

api.delete('/tasks/:id', wrap(async (req, res) => {
  const id = idParam(req.params.id);
  const { rows: files } = await pool.query('SELECT stored_name FROM attachments WHERE task_id = $1', [id]);
  const { rowCount } = await pool.query('DELETE FROM tasks WHERE id = $1', [id]);
  if (!rowCount) throw notFound(`Задача с id=${id} не найдена.`);
  await Promise.all(files.map((f) => removeFile(f.stored_name)));
  res.status(204).end();
}));

// Загрузка файлов. Сначала проверяем, что задача существует, а уже потом принимаем тело.
api.post('/tasks/:id/attachments',
  wrap(async (req, res, next) => {
    const id = idParam(req.params.id);
    await getTaskOr404(id);
    req.taskId = id;
    next();
  }),
  (req, res, next) => {
    if (!req.is('multipart/form-data')) {
      return next(new HttpError(415, 'Файлы нужно отправлять как multipart/form-data (поле "files").'));
    }
    return upload(req, res, next);
  },
  wrap(async (req, res) => {
    const files = req.files || [];
    const cleanup = () => Promise.all(files.map((f) => removeFile(f.filename)));

    if (!files.length) throw badRequest('Не передано ни одного файла (поле "files").');

    const { rows: [{ count }] } = await pool.query(
      'SELECT count(*)::int AS count FROM attachments WHERE task_id = $1', [req.taskId]);
    if (count + files.length > MAX_FILES_PER_TASK) {
      await cleanup();
      throw badRequest(`У задачи может быть не больше ${MAX_FILES_PER_TASK} файлов.`);
    }

    try {
      const created = [];
      for (const f of files) {
        const { rows } = await pool.query(
          `INSERT INTO attachments (task_id, stored_name, original_name, mime_type, size)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [req.taskId, f.filename, fixName(f.originalname), f.mimetype || 'application/octet-stream', f.size]
        );
        created.push(toAttachment(rows[0]));
      }
      await pool.query('UPDATE tasks SET updated_at = now() WHERE id = $1', [req.taskId]);
      res.status(201).json(created);
    } catch (err) {
      await cleanup();
      throw err;
    }
  })
);

async function getAttachmentOr404(taskId, attId) {
  const { rows } = await pool.query(
    'SELECT * FROM attachments WHERE id = $1 AND task_id = $2', [attId, taskId]);
  if (!rows[0]) throw notFound(`Файл с id=${attId} у задачи ${taskId} не найден.`);
  return rows[0];
}

api.get('/tasks/:id/attachments/:aid', wrap(async (req, res) => {
  const att = await getAttachmentOr404(idParam(req.params.id), idParam(req.params.aid, 'id файла'));
  const filePath = path.join(UPLOADS_DIR, att.stored_name);
  if (!fs.existsSync(filePath)) throw notFound('Файл отсутствует на диске.');
  res.type(att.mime_type);
  res.download(filePath, att.original_name);
}));

api.delete('/tasks/:id/attachments/:aid', wrap(async (req, res) => {
  const taskId = idParam(req.params.id);
  const att = await getAttachmentOr404(taskId, idParam(req.params.aid, 'id файла'));
  await pool.query('DELETE FROM attachments WHERE id = $1', [att.id]);
  await pool.query('UPDATE tasks SET updated_at = now() WHERE id = $1', [taskId]);
  await removeFile(att.stored_name);
  res.status(204).end();
}));

api.use((req, res, next) => next(notFound('Маршрут API не найден.')));
app.use('/api', api);

// ---------- Обработка ошибок ----------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  let status = 500;
  let message = 'Внутренняя ошибка сервера.';
  let details;

  if (err instanceof HttpError) {
    ({ status, message, details } = err);
  } else if (err instanceof multer.MulterError) {
    status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    message = {
      LIMIT_FILE_SIZE: `Файл слишком большой (максимум ${MAX_FILE_SIZE / 1024 / 1024} МБ).`,
      LIMIT_FILE_COUNT: `Слишком много файлов (максимум ${MAX_FILES} за раз).`,
      LIMIT_UNEXPECTED_FILE: 'Файлы нужно отправлять в поле "files" (не более 10).',
    }[err.code] || `Ошибка загрузки файла: ${err.message}`;
    (req.files || []).forEach((f) => removeFile(f.filename));
  } else if (err.type === 'entity.parse.failed') {
    status = 400;
    message = 'Тело запроса не является корректным JSON.';
  } else if (err.type === 'entity.too.large') {
    status = 413;
    message = 'Тело запроса слишком большое.';
  } else {
    console.error(err);
  }
  res.status(status).json({ error: { message, ...(details ? { details } : {}) } });
});

module.exports = { app, UPLOADS_DIR };
