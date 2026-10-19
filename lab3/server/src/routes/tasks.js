// Задачи и вложения. Права:
//   viewer — только чтение; user — создаёт задачи и меняет/удаляет СВОИ; admin — всё.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const { pool } = require('../db');
const config = require('../config');
const { HttpError, badRequest, notFound, forbidden } = require('../errors');
const { wrap, idParam, methodNotAllowed } = require('../http');
const { validateTask, validateListQuery } = require('../validate');
const { authenticate, requireRole } = require('../middleware/auth');

const UPLOADS_DIR = config.uploadsDir || path.join(__dirname, '..', '..', 'uploads');
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_FILES = 10;
const MAX_FILES_PER_TASK = 20;

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).slice(0, 20)}`),
  }),
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES },
}).array('files', MAX_FILES);

// multer отдаёт имя в latin1 — возвращаем нормальный UTF-8 (кириллица).
const fixName = (name) => Buffer.from(name, 'latin1').toString('utf8').slice(0, 255);
const removeFile = (storedName) => fs.promises.unlink(path.join(UPLOADS_DIR, storedName)).catch(() => {});

// ---------- преобразование строк БД в JSON ----------
function dateToString(d) {
  if (!d) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const toAttachment = (r) => ({
  id: r.id, taskId: r.task_id, name: r.original_name, mimeType: r.mime_type, size: r.size,
  createdAt: r.created_at, url: `/api/tasks/${r.task_id}/attachments/${r.id}`,
});

const toTask = (r, attachments = []) => ({
  id: r.id, title: r.title, description: r.description, status: r.status,
  dueDate: dateToString(r.due_date), createdAt: r.created_at, updatedAt: r.updated_at,
  owner: r.owner_id ? { id: r.owner_id, name: r.owner_name } : null,
  attachments,
});

const TASK_SELECT = 'SELECT t.*, u.name AS owner_name FROM tasks t LEFT JOIN users u ON u.id = t.owner_id';

async function loadAttachments(taskIds) {
  if (!taskIds.length) return new Map();
  const { rows } = await pool.query('SELECT * FROM attachments WHERE task_id = ANY($1) ORDER BY id', [taskIds]);
  const map = new Map();
  rows.forEach((r) => {
    if (!map.has(r.task_id)) map.set(r.task_id, []);
    map.get(r.task_id).push(toAttachment(r));
  });
  return map;
}

async function getTaskOr404(id) {
  const { rows } = await pool.query(`${TASK_SELECT} WHERE t.id = $1`, [id]);
  if (!rows[0]) throw notFound(`Задача с id=${id} не найдена.`);
  const att = await loadAttachments([id]);
  return toTask(rows[0], att.get(id) || []);
}

// Менять задачу может её автор или администратор.
function assertCanModify(user, task) {
  if (user.role === 'admin' || (task.owner && task.owner.id === user.id)) return;
  throw forbidden('Изменять и удалять задачу может только её автор или администратор.');
}

// Загружает задачу и проверяет права (сначала 404, потом 403).
const ownedTask = wrap(async (req, res, next) => {
  req.taskId = idParam(req.params.id);
  req.task = await getTaskOr404(req.taskId);
  assertCanModify(req.user, req.task);
  next();
});

const router = express.Router();
router.use(authenticate);

router.route('/')
  .get(wrap(async (req, res) => {
    const { value, errors } = validateListQuery(req.query);
    if (errors.length) throw badRequest('Некорректные параметры запроса.', errors);

    const where = [];
    const params = [];
    if (value.status) {
      params.push(value.status);
      where.push(`t.status = $${params.length}`);
    }
    if (value.q) {
      params.push(`%${value.q.replace(/[\\%_]/g, '\\$&')}%`);
      where.push(`(t.title ILIKE $${params.length} OR t.description ILIKE $${params.length})`);
    }
    const { rows } = await pool.query(
      `${TASK_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.created_at DESC, t.id DESC`,
      params
    );
    const att = await loadAttachments(rows.map((r) => r.id));
    res.json(rows.map((r) => toTask(r, att.get(r.id) || [])));
  }))
  .post(requireRole('user'), wrap(async (req, res) => {
    const { value, errors } = validateTask(req.body);
    if (errors.length) throw badRequest('Данные не прошли проверку.', errors);
    const { rows } = await pool.query(
      `INSERT INTO tasks (title, description, status, due_date, owner_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [value.title, value.description, value.status, value.dueDate, req.user.id]
    );
    res.status(201).location(`/api/tasks/${rows[0].id}`).json(await getTaskOr404(rows[0].id));
  }))
  .all(methodNotAllowed);

router.route('/:id')
  .get(wrap(async (req, res) => res.json(await getTaskOr404(idParam(req.params.id)))))
  .put(requireRole('user'), ownedTask, wrap(async (req, res) => {
    const { value, errors } = validateTask(req.body);
    if (errors.length) throw badRequest('Данные не прошли проверку.', errors);
    await pool.query(
      'UPDATE tasks SET title=$1, description=$2, status=$3, due_date=$4, updated_at=now() WHERE id=$5',
      [value.title, value.description, value.status, value.dueDate, req.taskId]
    );
    res.json(await getTaskOr404(req.taskId));
  }))
  .patch(requireRole('user'), ownedTask, wrap(async (req, res) => {
    const { value, errors } = validateTask(req.body, { partial: true });
    if (errors.length) throw badRequest('Данные не прошли проверку.', errors);
    if (!Object.keys(value).length) throw badRequest('Не передано ни одного поля для изменения.');

    const columns = { title: 'title', description: 'description', status: 'status', dueDate: 'due_date' };
    const sets = [];
    const params = [];
    Object.entries(value).forEach(([key, v]) => {
      params.push(v);
      sets.push(`${columns[key]} = $${params.length}`);
    });
    params.push(req.taskId);
    await pool.query(`UPDATE tasks SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}`, params);
    res.json(await getTaskOr404(req.taskId));
  }))
  .delete(requireRole('user'), ownedTask, wrap(async (req, res) => {
    const { rows: files } = await pool.query('SELECT stored_name FROM attachments WHERE task_id = $1', [req.taskId]);
    await pool.query('DELETE FROM tasks WHERE id = $1', [req.taskId]);
    await Promise.all(files.map((f) => removeFile(f.stored_name)));
    res.status(204).end();
  }))
  .all(methodNotAllowed);

// Загрузка файлов: права и существование задачи проверяются ДО приёма тела запроса.
router.route('/:id/attachments')
  .post(
    requireRole('user'),
    ownedTask,
    (req, res, next) => {
      if (!req.is('multipart/form-data')) {
        return next(new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Файлы нужно отправлять как multipart/form-data (поле "files").'));
      }
      return upload(req, res, next);
    },
    wrap(async (req, res) => {
      const files = req.files || [];
      const cleanup = () => Promise.all(files.map((f) => removeFile(f.filename)));
      if (!files.length) throw badRequest('Не передано ни одного файла (поле "files").');

      const { rows: [{ count }] } = await pool.query('SELECT count(*)::int AS count FROM attachments WHERE task_id = $1', [req.taskId]);
      if (count + files.length > MAX_FILES_PER_TASK) {
        await cleanup();
        throw badRequest(`У задачи может быть не больше ${MAX_FILES_PER_TASK} файлов.`);
      }
      try {
        const created = [];
        for (const f of files) {
          const { rows } = await pool.query(
            `INSERT INTO attachments (task_id, stored_name, original_name, mime_type, size) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
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
  )
  .all(methodNotAllowed);

async function getAttachmentOr404(taskId, attId) {
  const { rows } = await pool.query('SELECT * FROM attachments WHERE id = $1 AND task_id = $2', [attId, taskId]);
  if (!rows[0]) throw notFound(`Файл с id=${attId} у задачи ${taskId} не найден.`);
  return rows[0];
}

router.route('/:id/attachments/:aid')
  .get(wrap(async (req, res) => {
    const att = await getAttachmentOr404(idParam(req.params.id), idParam(req.params.aid, 'id файла'));
    const filePath = path.join(UPLOADS_DIR, att.stored_name);
    if (!fs.existsSync(filePath)) throw notFound('Файл отсутствует на диске.');
    res.type(att.mime_type);
    res.download(filePath, att.original_name);
  }))
  .delete(requireRole('user'), ownedTask, wrap(async (req, res) => {
    const att = await getAttachmentOr404(req.taskId, idParam(req.params.aid, 'id файла'));
    await pool.query('DELETE FROM attachments WHERE id = $1', [att.id]);
    await pool.query('UPDATE tasks SET updated_at = now() WHERE id = $1', [req.taskId]);
    await removeFile(att.stored_name);
    res.status(204).end();
  }))
  .all(methodNotAllowed);

router.removeFile = removeFile;
module.exports = router;
module.exports.UPLOADS_DIR = UPLOADS_DIR;
