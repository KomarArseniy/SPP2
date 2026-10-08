// Простейший файловый "репозиторий" задач.
// Все данные хранятся в data/tasks.json и читаются/пишутся синхронно —
// для лабораторной работы это осознанное упрощение вместо полноценной БД.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_FILE = path.join(__dirname, 'tasks.json');

// Возможные статусы задачи и их подписи для интерфейса.
const STATUSES = {
  todo: 'Не начата',
  in_progress: 'В работе',
  done: 'Выполнена',
};

function ensureDbFile() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, '[]', 'utf-8');
  }
}

function readAll() {
  ensureDbFile();
  const raw = fs.readFileSync(DB_FILE, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    return [];
  }
}

function writeAll(tasks) {
  fs.writeFileSync(DB_FILE, JSON.stringify(tasks, null, 2), 'utf-8');
}

function getAll({ status } = {}) {
  const tasks = readAll();
  const filtered = status && status !== 'all'
    ? tasks.filter((t) => t.status === status)
    : tasks;

  // Свежесозданные задачи — сверху.
  return filtered.slice().sort((a, b) => b.createdAt - a.createdAt);
}

function getById(id) {
  return readAll().find((t) => t.id === id);
}

function create({ title, description, dueDate, attachments }) {
  const tasks = readAll();
  const task = {
    id: crypto.randomUUID(),
    title: title.trim(),
    description: (description || '').trim(),
    dueDate: dueDate || null,
    status: 'todo',
    attachments: attachments || [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  tasks.push(task);
  writeAll(tasks);
  return task;
}

function updateStatus(id, status) {
  if (!Object.keys(STATUSES).includes(status)) {
    throw new Error(`Неизвестный статус: ${status}`);
  }
  const tasks = readAll();
  const task = tasks.find((t) => t.id === id);
  if (!task) return null;
  task.status = status;
  task.updatedAt = Date.now();
  writeAll(tasks);
  return task;
}

function addAttachments(id, attachments) {
  const tasks = readAll();
  const task = tasks.find((t) => t.id === id);
  if (!task) return null;
  task.attachments.push(...attachments);
  task.updatedAt = Date.now();
  writeAll(tasks);
  return task;
}

function removeAttachment(id, attachmentId) {
  const tasks = readAll();
  const task = tasks.find((t) => t.id === id);
  if (!task) return null;
  const removed = task.attachments.find((a) => a.id === attachmentId);
  task.attachments = task.attachments.filter((a) => a.id !== attachmentId);
  task.updatedAt = Date.now();
  writeAll(tasks);
  return removed || null;
}

function remove(id) {
  const tasks = readAll();
  const task = tasks.find((t) => t.id === id);
  const remaining = tasks.filter((t) => t.id !== id);
  writeAll(remaining);
  return task || null;
}

module.exports = {
  STATUSES,
  getAll,
  getById,
  create,
  updateStatus,
  addAttachments,
  removeAttachment,
  remove,
};
