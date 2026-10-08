export const STATUSES = {
  todo: 'Не начата',
  in_progress: 'В работе',
  done: 'Выполнена',
};

export const FILTERS = [['all', 'Все'], ...Object.entries(STATUSES)];

export function formatDate(str) {
  if (!str) return '';
  const [y, m, d] = str.split('-');
  return `${d}.${m}.${y}`;
}

export function isOverdue(task) {
  if (!task.dueDate || task.status === 'done') return false;
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return task.dueDate < today;
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

export const MAX_FILE_SIZE = 10 * 1024 * 1024;
