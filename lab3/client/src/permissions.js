export const ROLES = { viewer: 'Наблюдатель', user: 'Пользователь', admin: 'Администратор' };

// viewer — только чтение; user — создаёт задачи и меняет свои; admin — всё.
export const canCreate = (user) => !!user && (user.role === 'user' || user.role === 'admin');
export const canModify = (user, task) =>
  !!user && (user.role === 'admin' || (user.role === 'user' && task.owner?.id === user.id));
