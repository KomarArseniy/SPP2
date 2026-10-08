// Лабораторная работа №1. «Список задач» — приложение с рендерингом на сервере (SSR).
//
// Стек: Node.js + Express + EJS.
// Клиент никогда не получает "голый" JSON и не выполняет никакого JS для
// отрисовки интерфейса — сервер на каждый запрос собирает готовую HTML-страницу
// и отдаёт её браузеру. Все действия пользователя (создание задачи, смена
// статуса, удаление, загрузка файлов, фильтрация) выполняются через обычные
// HTML-формы (GET/POST), без fetch/XHR.

const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const methodOverride = require('method-override');

const store = require('./data/store');

const app = express();
const PORT = process.env.PORT || 3000;

const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// ---------- Настройка шаблонизатора ----------
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ---------- Middleware ----------
app.use(express.urlencoded({ extended: true })); // разбор данных обычных форм
app.use(methodOverride('_method'));               // позволяет формам слать PUT/DELETE через ?_method=
app.use('/public', express.static(path.join(__dirname, 'public')));

// ---------- Загрузка файлов (multer) ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(file.originalname);
    cb(null, `${unique}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } }); // до 10 МБ на файл

// multer 1.x/2.x отдаёт originalname в latin1 — для кириллицы это "кракозябры".
// Перекодируем в UTF-8.
function fixName(name) {
  return Buffer.from(name, 'latin1').toString('utf8');
}

function toAttachment(file) {
  return {
    id: file.filename,
    filename: file.filename,
    originalName: fixName(file.originalname),
    size: file.size,
  };
}

function cleanupFiles(files) {
  (files || []).forEach((f) => fs.unlink(f.path, () => {}));
}

// Обёртка над upload.array: ошибки multer (слишком большой файл, лишние поля)
// превращаются в понятное сообщение, а не в стандартную страницу ошибки.
function uploadFiles(onError) {
  const handler = upload.array('attachments', 10);
  return (req, res, next) => {
    handler(req, res, (err) => {
      if (!err) return next();
      let msg = 'Ошибка загрузки файлов.';
      if (err.code === 'LIMIT_FILE_SIZE') msg = 'Файл слишком большой (максимум 10 МБ).';
      else if (err.code === 'LIMIT_UNEXPECTED_FILE') msg = 'Слишком много файлов (максимум 10 за раз).';
      onError(req, res, msg);
    });
  };
}

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 5000;

function isValidDate(str) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const d = new Date(`${str}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === str;
}

function validateTask({ title, description, dueDate }) {
  if (typeof title !== 'string' || !title.trim()) return 'Название задачи обязательно для заполнения.';
  if (title.trim().length > MAX_TITLE) return `Название не длиннее ${MAX_TITLE} символов.`;
  if (description && String(description).length > MAX_DESCRIPTION) return `Описание не длиннее ${MAX_DESCRIPTION} символов.`;
  if (dueDate && !isValidDate(dueDate)) return 'Некорректная дата завершения.';
  return null;
}

// ---------- Вспомогательное ----------
function formatDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('ru-RU');
}
app.locals.formatDate = formatDate;
app.locals.STATUSES = store.STATUSES;

// ---------- Роуты ----------

// Главная — просто редирект на список задач.
app.get('/', (req, res) => res.redirect('/tasks'));

// Список задач + фильтрация по статусу (?status=todo|in_progress|done|all)
app.get('/tasks', (req, res) => {
  const requested = typeof req.query.status === 'string' ? req.query.status : 'all';
  const status = requested === 'all' || store.STATUSES[requested] ? requested : 'all';
  const tasks = store.getAll({ status });
  res.render('index', {
    tasks,
    currentStatus: status,
    error: req.query.error || null,
  });
});

// Форма создания новой задачи
app.get('/tasks/new', (req, res) => {
  res.render('new', { error: null, values: {} });
});

// Создание задачи (multipart/form-data — текстовые поля + файлы)
app.post(
  '/tasks',
  uploadFiles((req, res, msg) =>
    res.status(400).render('new', { error: msg, values: req.body || {} })),
  (req, res) => {
    const { title, description, dueDate } = req.body;
    const error = validateTask({ title, description, dueDate });

    if (error) {
      // Файлы, которые multer уже успел сохранить на диск, подчищаем.
      cleanupFiles(req.files);
      return res.status(400).render('new', { error, values: { title, description, dueDate } });
    }

    const attachments = (req.files || []).map(toAttachment);
    const task = store.create({ title, description, dueDate, attachments });
    res.redirect(`/tasks/${task.id}`);
  }
);

// Просмотр одной задачи
app.get('/tasks/:id', (req, res) => {
  const task = store.getById(req.params.id);
  if (!task) return res.status(404).render('not-found', { id: req.params.id });
  res.render('show', { task, error: typeof req.query.error === 'string' ? req.query.error : null });
});

// Смена статуса задачи (форма с select + submit на странице списка/просмотра)
app.post('/tasks/:id/status', (req, res) => {
  const { status, redirectTo } = req.body;
  try {
    const task = store.updateStatus(req.params.id, status);
    if (!task) return res.status(404).render('not-found', { id: req.params.id });
  } catch (err) {
    return res.redirect(`/tasks?error=${encodeURIComponent(err.message)}`);
  }
  res.redirect(redirectTo === 'show' ? `/tasks/${req.params.id}` : '/tasks');
});

// Добавление файлов к уже существующей задаче
app.post(
  '/tasks/:id/attachments',
  uploadFiles((req, res, msg) => res.redirect(`/tasks/${req.params.id}?error=${encodeURIComponent(msg)}`)),
  (req, res) => {
    const task = store.getById(req.params.id);
    if (!task) {
      cleanupFiles(req.files);
      return res.status(404).render('not-found', { id: req.params.id });
    }
    const attachments = (req.files || []).map(toAttachment);
    if (attachments.length) {
      store.addAttachments(req.params.id, attachments);
    }
    res.redirect(`/tasks/${req.params.id}`);
  }
);

// Удаление одного вложения
app.post('/tasks/:id/attachments/:attachmentId/delete', (req, res) => {
  const removed = store.removeAttachment(req.params.id, req.params.attachmentId);
  if (removed) {
    fs.unlink(path.join(UPLOADS_DIR, removed.filename), () => {});
  }
  res.redirect(`/tasks/${req.params.id}`);
});

// Скачивание файла с исходным именем
app.get('/files/:filename', (req, res) => {
  const tasks = store.getAll();
  let attachment = null;
  for (const t of tasks) {
    attachment = t.attachments.find((a) => a.filename === req.params.filename);
    if (attachment) break;
  }
  const filePath = path.join(UPLOADS_DIR, req.params.filename);
  if (!attachment || !fs.existsSync(filePath)) {
    return res.status(404).send('Файл не найден');
  }
  res.download(filePath, attachment.originalName);
});

// Удаление задачи целиком (вместе с файлами)
app.post('/tasks/:id/delete', (req, res) => {
  const task = store.remove(req.params.id);
  if (task) {
    task.attachments.forEach((a) => fs.unlink(path.join(UPLOADS_DIR, a.filename), () => {}));
  }
  res.redirect('/tasks');
});

// 404
app.use((req, res) => res.status(404).render('not-found', { id: null }));

// Необработанные ошибки
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Внутренняя ошибка сервера');
});

app.listen(PORT, () => {
  console.log(`SSR Todo app listening on http://localhost:${PORT}`);
});
