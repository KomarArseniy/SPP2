// Тонкая обёртка над fetch для работы с REST API.
// Любая ошибка превращается в ApiError с понятным сообщением и полями формы.

export class ApiError extends Error {
  constructor(message, { status = 0, details = [] } = {}) {
    super(message);
    this.status = status;
    this.details = details; // [{ field, message }]
  }

  // Ошибки по полям -> { title: '...', dueDate: '...' }
  get fieldErrors() {
    return Object.fromEntries(this.details.map((d) => [d.field, d.message]));
  }
}

async function request(method, url, { json, formData } = {}) {
  const options = { method, headers: {} };
  if (json !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(json);
  } else if (formData) {
    options.body = formData; // Content-Type с boundary проставит браузер
  }

  let res;
  try {
    res = await fetch(url, options);
  } catch {
    throw new ApiError('Нет связи с сервером. Проверьте подключение и попробуйте ещё раз.');
  }

  if (res.status === 204) return null;

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* тело не JSON */
  }

  if (!res.ok) {
    const message =
      data?.error?.message ||
      (res.status >= 500 ? 'Ошибка сервера. Попробуйте позже.' : `Ошибка запроса (${res.status}).`);
    throw new ApiError(message, { status: res.status, details: data?.error?.details || [] });
  }
  return data;
}

export const api = {
  listTasks: ({ status, q } = {}) => {
    const params = new URLSearchParams();
    if (status && status !== 'all') params.set('status', status);
    if (q) params.set('q', q);
    const qs = params.toString();
    return request('GET', `/api/tasks${qs ? `?${qs}` : ''}`);
  },
  getTask: (id) => request('GET', `/api/tasks/${id}`),
  createTask: (data) => request('POST', '/api/tasks', { json: data }),
  updateTask: (id, data) => request('PUT', `/api/tasks/${id}`, { json: data }),
  patchTask: (id, data) => request('PATCH', `/api/tasks/${id}`, { json: data }),
  deleteTask: (id) => request('DELETE', `/api/tasks/${id}`),
  uploadFiles: (id, files) => {
    const fd = new FormData();
    Array.from(files).forEach((f) => fd.append('files', f));
    return request('POST', `/api/tasks/${id}/attachments`, { formData: fd });
  },
  deleteAttachment: (taskId, attId) =>
    request('DELETE', `/api/tasks/${taskId}/attachments/${attId}`),
};
