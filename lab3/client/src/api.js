// Тонкая обёртка над fetch для работы с REST API.
// * access-токен хранится только в памяти (не в localStorage), refresh-токен — в httpOnly-cookie;
// * при 401 TOKEN_EXPIRED токен обновляется автоматически и запрос повторяется один раз;
// * любая ошибка превращается в ApiError с понятным сообщением, кодом и полями формы.

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'NETWORK_ERROR', details = [], retryAfter = null, requestId = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details; // [{ field, message }]
    this.retryAfter = retryAfter; // секунд (из заголовка Retry-After)
    this.requestId = requestId;
  }

  // Ошибки по полям -> { title: '...', dueDate: '...' }
  get fieldErrors() {
    return Object.fromEntries(this.details.map((d) => [d.field, d.message]));
  }
}

let accessToken = null;
let onAuthLost = () => {};

export const setAccessToken = (token) => { accessToken = token; };
export const setAuthLostHandler = (fn) => { onAuthLost = fn; };

async function rawRequest(method, url, { json, formData, auth = true, blob = false } = {}) {
  const options = { method, headers: {} };
  if (auth && accessToken) options.headers.Authorization = `Bearer ${accessToken}`;
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

  if (res.ok) {
    if (res.status === 204) return null;
    return blob ? res.blob() : res.json();
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* тело не JSON */
  }
  const retryAfter = Number(res.headers.get('Retry-After')) || null;
  const message =
    data?.error?.message ||
    (res.status >= 500 ? 'Ошибка сервера. Попробуйте позже.' : `Ошибка запроса (${res.status}).`);
  throw new ApiError(message, {
    status: res.status,
    code: data?.error?.code || `HTTP_${res.status}`,
    details: data?.error?.details || [],
    retryAfter,
    requestId: data?.error?.requestId || res.headers.get('X-Request-Id'),
  });
}

// Один общий запрос обновления токена, даже если «просрочилось» сразу несколько запросов.
let refreshing = null;
function refreshAccess() {
  if (!refreshing) {
    refreshing = rawRequest('POST', '/api/auth/refresh', { auth: false })
      .then((data) => { accessToken = data.accessToken; return data; })
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

async function request(method, url, options = {}) {
  try {
    return await rawRequest(method, url, options);
  } catch (err) {
    if (options.auth === false || err.status !== 401) throw err;

    if (err.code === 'TOKEN_EXPIRED') {
      try {
        await refreshAccess();
      } catch (refreshErr) {
        accessToken = null;
        onAuthLost();
        throw refreshErr;
      }
      return rawRequest(method, url, options); // повтор с новым токеном
    }
    // сессия отозвана / токен недействителен — нужен повторный вход
    accessToken = null;
    onAuthLost();
    throw err;
  }
}

const withToken = (data) => { accessToken = data.accessToken; return data; };

export const api = {
  // --- аутентификация ---
  register: (data) => rawRequest('POST', '/api/auth/register', { json: data, auth: false }).then(withToken),
  login: (data) => rawRequest('POST', '/api/auth/login', { json: data, auth: false }).then(withToken),
  restoreSession: () => refreshAccess(), // при загрузке страницы: пробуем войти по refresh-cookie
  logout: () => rawRequest('POST', '/api/auth/logout', { auth: false }).finally(() => { accessToken = null; }),
  forgotPassword: (email) => rawRequest('POST', '/api/auth/forgot-password', { json: { email }, auth: false }),
  resetPassword: (token, password) => rawRequest('POST', '/api/auth/reset-password', { json: { token, password }, auth: false }),
  changePassword: (data) => request('POST', '/api/auth/change-password', { json: data }),
  listSessions: () => request('GET', '/api/auth/sessions'),
  revokeSession: (id) => request('DELETE', `/api/auth/sessions/${id}`),
  revokeOtherSessions: () => request('DELETE', '/api/auth/sessions'),

  // --- пользователи (admin) ---
  listUsers: () => request('GET', '/api/users'),
  updateUser: (id, data) => request('PATCH', `/api/users/${id}`, { json: data }),
  deleteUser: (id) => request('DELETE', `/api/users/${id}`),
  unlockUser: (id) => request('POST', `/api/users/${id}/unlock`),
  listUserSessions: (id) => request('GET', `/api/users/${id}/sessions`),
  revokeUserSessions: (id) => request('DELETE', `/api/users/${id}/sessions`),

  // --- задачи ---
  listTasks: ({ status, q } = {}) => {
    const params = new URLSearchParams();
    if (status && status !== 'all') params.set('status', status);
    if (q) params.set('q', q);
    const qs = params.toString();
    return request('GET', `/api/tasks${qs ? `?${qs}` : ''}`);
  },
  createTask: (data) => request('POST', '/api/tasks', { json: data }),
  updateTask: (id, data) => request('PUT', `/api/tasks/${id}`, { json: data }),
  patchTask: (id, data) => request('PATCH', `/api/tasks/${id}`, { json: data }),
  deleteTask: (id) => request('DELETE', `/api/tasks/${id}`),
  uploadFiles: (id, files) => {
    const fd = new FormData();
    Array.from(files).forEach((f) => fd.append('files', f));
    return request('POST', `/api/tasks/${id}/attachments`, { formData: fd });
  },
  deleteAttachment: (taskId, attId) => request('DELETE', `/api/tasks/${taskId}/attachments/${attId}`),

  // Скачивание: ссылке <a href> нельзя передать заголовок Authorization, поэтому файл
  // запрашивается через fetch с токеном и сохраняется из Blob.
  async downloadAttachment(attachment) {
    const blob = await request('GET', attachment.url, { blob: true });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = attachment.name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    // убираем ссылку и освобождаем память чуть позже, когда браузер уже начал скачивание
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 10_000);
  },
};
