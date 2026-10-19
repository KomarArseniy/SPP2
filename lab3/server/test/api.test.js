// Интеграционные тесты API. Нужна работающая PostgreSQL:
//   DATABASE_URL=postgres://spp:spp@localhost:5432/spp npm test
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.UPLOADS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'spp-uploads-'));
process.env.LOG_LEVEL = 'silent';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'Admin12345!';
process.env.AUTH_RATE_LIMIT_MAX = '1000';
process.env.MAX_FAILED_ATTEMPTS = '3';
process.env.MAX_SESSIONS = '3';
process.env.ACCESS_TOKEN_TTL_SECONDS = '900';

const { app } = require('../src/app');
const { init, pool } = require('../src/db');
const { seed } = require('../src/services/seed');
const { outbox } = require('../src/mailer');
const { signAccessToken } = require('../src/security/tokens');
const { createRateLimiter } = require('../src/security/rateLimit');

let server;
let base;

test.before(async () => {
  await init({ retries: 5 });
  await pool.query('TRUNCATE tasks, users, login_attempts RESTART IDENTITY CASCADE');
  await seed();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});

test.after(async () => {
  server.close();
  await pool.end();
});

// ---------- помощники ----------
async function call(method, url, { body, token, cookie, form, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (cookie) h.Cookie = cookie;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(base + url, { method, headers: h, body: payload });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* не JSON */ }
  const setCookie = res.headers.getSetCookie?.() || [];
  const refresh = setCookie.map((c) => /^refresh_token=([^;]*)/.exec(c)).find(Boolean);
  return { res, status: res.status, json, text, cookie: refresh ? `refresh_token=${refresh[1]}` : null, setCookie };
}

let counter = 0;
async function register(name = 'Тест') {
  counter += 1;
  const email = `u${counter}-${Date.now()}@test.local`;
  const r = await call('POST', '/auth/register', { body: { email, name, password: 'Passw0rd!' } });
  assert.equal(r.status, 201, r.text);
  return { email, password: 'Passw0rd!', token: r.json.accessToken, cookie: r.cookie, user: r.json.user };
}
async function login(email, password = 'Passw0rd!') {
  return call('POST', '/auth/login', { body: { email, password } });
}
async function adminToken() {
  const r = await login('admin@test.local', 'Admin12345!');
  assert.equal(r.status, 200, r.text);
  return r.json.accessToken;
}
async function makeViewer() {
  const u = await register('Наблюдатель');
  const admin = await adminToken();
  const r = await call('PATCH', `/users/${u.user.id}`, { token: admin, body: { role: 'viewer' } });
  assert.equal(r.status, 200);
  return u;
}

// ---------- аутентификация и временные ключи ----------
test('регистрация → вход → /me; refresh-токен в httpOnly cookie', async () => {
  const u = await register();
  assert.equal(u.user.role, 'user');
  const r = await login(u.email);
  assert.equal(r.status, 200);
  assert.equal(r.json.tokenType, 'Bearer');
  assert.ok(r.json.expiresIn > 0);
  const c = r.setCookie.find((x) => x.startsWith('refresh_token='));
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Strict/);
  assert.match(c, /Path=\/api\/auth/);
  assert.ok(!('refreshToken' in r.json), 'refresh-токен не должен быть в теле ответа');

  const me = await call('GET', '/auth/me', { token: r.json.accessToken });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.email, u.email);
  assert.equal(me.json.user.password_hash, undefined);
});

test('регистрация: валидация (400) и дубликат email (409)', async () => {
  const bad = [{}, { email: 'x', name: 'a', password: 'Passw0rd!' }, { email: 'a@b.cc', name: '', password: 'Passw0rd!' },
    { email: 'a@b.cc', name: 'a', password: 'short1' }, { email: 'a@b.cc', name: 'a', password: 'onlyletters' }];
  for (const body of bad) assert.equal((await call('POST', '/auth/register', { body })).status, 400, JSON.stringify(body));
  const u = await register();
  const dup = await call('POST', '/auth/register', { body: { email: u.email.toUpperCase(), name: 'x', password: 'Passw0rd!' } });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error.code, 'CONFLICT');
});

test('401: нет токена, мусорный токен, подделанная подпись, истёкший токен', async () => {
  let r = await call('GET', '/tasks');
  assert.equal(r.status, 401);
  assert.equal(r.json.error.code, 'UNAUTHENTICATED');
  assert.match(r.res.headers.get('www-authenticate'), /^Bearer/);
  assert.ok(r.json.error.requestId);
  assert.ok(r.res.headers.get('x-request-id'));

  r = await call('GET', '/tasks', { token: 'garbage' });
  assert.equal(r.status, 401);
  assert.equal(r.json.error.code, 'INVALID_TOKEN');

  const u = await register();
  const forged = u.token.slice(0, -3) + (u.token.endsWith('aaa') ? 'bbb' : 'aaa');
  assert.equal((await call('GET', '/tasks', { token: forged })).json.error.code, 'INVALID_TOKEN');

  const expired = signAccessToken({ userId: u.user.id, role: 'user', sessionId: 'x' }, { expiresIn: -10 });
  r = await call('GET', '/tasks', { token: expired });
  assert.equal(r.status, 401);
  assert.equal(r.json.error.code, 'TOKEN_EXPIRED');
});

test('refresh: ротация, повтор старого токена отзывает сессию', async () => {
  const u = await register();
  const first = await call('POST', '/auth/refresh', { cookie: u.cookie });
  assert.equal(first.status, 200);
  assert.ok(first.cookie && first.cookie !== u.cookie, 'cookie должен смениться');
  assert.equal((await call('GET', '/auth/me', { token: first.json.accessToken })).status, 200);

  // имитируем «давно ротированный» токен: сдвигаем время ротации за пределы допуска
  await pool.query(`UPDATE sessions SET rotated_at = now() - interval '1 minute' WHERE user_id = $1`, [u.user.id]);
  const reuse = await call('POST', '/auth/refresh', { cookie: u.cookie });
  assert.equal(reuse.status, 401);
  // сессия отозвана целиком, даже «честный» новый токен больше не работает
  assert.equal((await call('POST', '/auth/refresh', { cookie: first.cookie })).status, 401);
  assert.equal((await call('GET', '/auth/me', { token: first.json.accessToken })).json.error.code, 'SESSION_REVOKED');

  assert.equal((await call('POST', '/auth/refresh')).status, 401); // без cookie
});

test('выход завершает сессию; access-токен перестаёт работать сразу', async () => {
  const u = await register();
  const out = await call('POST', '/auth/logout', { cookie: u.cookie });
  assert.equal(out.status, 204);
  const r = await call('GET', '/tasks', { token: u.token });
  assert.equal(r.status, 401);
  assert.equal(r.json.error.code, 'SESSION_REVOKED');
});

// ---------- роли ----------
test('роли: viewer читает, user создаёт и правит своё, admin — всё; 403 и 404', async () => {
  const viewer = await makeViewer();
  const alice = await register('Алиса');
  const bob = await register('Боб');
  const admin = await adminToken();

  // viewer: чтение можно, создание — нет
  assert.equal((await call('GET', '/tasks', { token: viewer.token })).status, 200);
  let r = await call('POST', '/tasks', { token: viewer.token, body: { title: 'x' } });
  assert.equal(r.status, 403);
  assert.equal(r.json.error.code, 'FORBIDDEN');

  // user создаёт, становится владельцем
  r = await call('POST', '/tasks', { token: alice.token, body: { title: 'Задача Алисы', dueDate: '2026-12-01' } });
  assert.equal(r.status, 201);
  assert.match(r.res.headers.get('location'), /\/api\/tasks\/\d+/);
  assert.equal(r.json.owner.id, alice.user.id);
  const id = r.json.id;

  // чужой user: 403 на PUT/PATCH/DELETE и загрузку файлов
  assert.equal((await call('PUT', `/tasks/${id}`, { token: bob.token, body: { title: 'взлом' } })).status, 403);
  assert.equal((await call('PATCH', `/tasks/${id}`, { token: bob.token, body: { status: 'done' } })).status, 403);
  assert.equal((await call('DELETE', `/tasks/${id}`, { token: bob.token })).status, 403);
  const f = new FormData();
  f.append('files', new Blob(['x']), 'x.txt');
  assert.equal((await call('POST', `/tasks/${id}/attachments`, { token: bob.token, form: f })).status, 403);
  // viewer тоже не может менять
  assert.equal((await call('PATCH', `/tasks/${id}`, { token: viewer.token, body: { status: 'done' } })).status, 403);

  // но читать все могут
  assert.equal((await call('GET', `/tasks/${id}`, { token: bob.token })).status, 200);

  // автор правит своё, admin — чужое
  assert.equal((await call('PATCH', `/tasks/${id}`, { token: alice.token, body: { status: 'in_progress' } })).status, 200);
  r = await call('PUT', `/tasks/${id}`, { token: admin, body: { title: 'Правка админа', status: 'done' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.title, 'Правка админа');

  // 404 раньше 403 для несуществующей задачи; плохой id — 400
  assert.equal((await call('DELETE', '/tasks/99999', { token: bob.token })).status, 404);
  assert.equal((await call('GET', '/tasks/abc', { token: bob.token })).status, 400);

  assert.equal((await call('DELETE', `/tasks/${id}`, { token: alice.token })).status, 204);
  assert.equal((await call('GET', `/tasks/${id}`, { token: alice.token })).status, 404);
});

test('CRUD задач, фильтры и валидация (400)', async () => {
  const u = await register();
  let r = await call('POST', '/tasks', { token: u.token, body: { title: '  Сдать лабу  ', dueDate: '2026-12-01' } });
  assert.equal(r.status, 201);
  assert.equal(r.json.title, 'Сдать лабу');
  const id = r.json.id;

  r = await call('PUT', `/tasks/${id}`, { token: u.token, body: { title: 'Новое', description: 'd', status: 'done', dueDate: null } });
  assert.equal(r.json.status, 'done');
  assert.equal(r.json.dueDate, null);
  assert.equal((await call('GET', '/tasks?status=done', { token: u.token })).json.some((t) => t.id === id), true);
  assert.equal((await call('GET', '/tasks?q=нов', { token: u.token })).json.some((t) => t.id === id), true);
  assert.equal((await call('GET', '/tasks?status=zzz', { token: u.token })).status, 400);

  for (const body of [{}, { title: '' }, { title: 'x'.repeat(201) }, { title: 'a', status: 'wrong' }, { title: 'a', dueDate: '2026-13-45' }]) {
    assert.equal((await call('POST', '/tasks', { token: u.token, body })).status, 400, JSON.stringify(body));
  }
  const broken = await fetch(`${base}/tasks`, { method: 'POST', headers: { Authorization: `Bearer ${u.token}`, 'Content-Type': 'application/json' }, body: '{oops' });
  assert.equal(broken.status, 400);
  assert.equal((await broken.json()).error.code, 'INVALID_JSON');
});

test('файлы: загрузка, скачивание (кириллица), удаление, 413/415', async () => {
  const u = await register();
  const { json: task } = await call('POST', '/tasks', { token: u.token, body: { title: 'С файлами' } });
  const form = new FormData();
  form.append('files', new Blob(['привет'], { type: 'text/plain' }), 'отчёт.txt');
  let r = await call('POST', `/tasks/${task.id}/attachments`, { token: u.token, form });
  assert.equal(r.status, 201);
  const [att] = r.json;
  assert.equal(att.name, 'отчёт.txt');

  // скачивание требует авторизации
  assert.equal((await call('GET', att.url.replace('/api', ''))).status, 401);
  r = await call('GET', att.url.replace('/api', ''), { token: u.token });
  assert.equal(r.status, 200);
  assert.equal(r.text, 'привет');
  assert.match(decodeURIComponent(r.res.headers.get('content-disposition')), /отчёт\.txt/);

  const big = new FormData();
  big.append('files', new Blob([Buffer.alloc(10 * 1024 * 1024 + 10)]), 'big.bin');
  assert.equal((await call('POST', `/tasks/${task.id}/attachments`, { token: u.token, form: big })).status, 413);
  assert.equal((await call('POST', `/tasks/${task.id}/attachments`, { token: u.token, body: {} })).status, 415);
  assert.equal((await call('POST', `/tasks/${task.id}/attachments`, { token: u.token, form: new FormData() })).status, 400);

  assert.equal((await call('DELETE', `/tasks/${task.id}/attachments/${att.id}`, { token: u.token })).status, 204);
  assert.equal((await call('DELETE', `/tasks/${task.id}/attachments/${att.id}`, { token: u.token })).status, 404);
  await call('DELETE', `/tasks/${task.id}`, { token: u.token });
  assert.deepEqual(fs.readdirSync(process.env.UPLOADS_DIR), []);
});

// ---------- семантика HTTP ----------
test('405 + Allow, 404 для неизвестных маршрутов, OPTIONS', async () => {
  const u = await register();
  let r = await call('DELETE', '/tasks', { token: u.token });
  assert.equal(r.status, 405);
  assert.match(r.res.headers.get('allow'), /GET/);
  assert.match(r.res.headers.get('allow'), /POST/);
  assert.equal(r.json.error.code, 'METHOD_NOT_ALLOWED');

  r = await call('GET', '/auth/login');
  assert.equal(r.status, 405);
  assert.match(r.res.headers.get('allow'), /POST/);

  assert.equal((await call('GET', '/nope', { token: u.token })).status, 404);
  r = await call('OPTIONS', '/tasks', { token: u.token });
  assert.equal(r.status, 204);
});

// ---------- защита от подбора ----------
test('подбор пароля: блокировка после N неудач (429 + Retry-After), даже верный пароль не пускает; admin снимает', async () => {
  const u = await register();
  let r = await login(u.email, 'Wrong-pass-1');
  assert.equal(r.status, 401);
  assert.equal(r.json.error.code, 'INVALID_CREDENTIALS');
  assert.match(r.json.error.message, /Осталось попыток: 2/);
  r = await login(u.email, 'Wrong-pass-2');
  assert.match(r.json.error.message, /Осталось попыток: 1/);

  r = await login(u.email, 'Wrong-pass-3'); // 3-я неудача -> блокировка
  assert.equal(r.status, 429);
  assert.equal(r.json.error.code, 'ACCOUNT_LOCKED');
  assert.ok(Number(r.res.headers.get('retry-after')) > 0);

  r = await login(u.email, u.password); // верный пароль, но аккаунт заблокирован
  assert.equal(r.status, 429);

  const admin = await adminToken();
  const list = await call('GET', '/users', { token: admin });
  assert.equal(list.json.find((x) => x.id === u.user.id).locked, true);
  assert.equal((await call('POST', `/users/${u.user.id}/unlock`, { token: admin })).status, 204);
  assert.equal((await login(u.email, u.password)).status, 200);
});

test('неизвестный email ведёт себя как существующий (нет утечки, тоже блокируется)', async () => {
  const email = `ghost-${Date.now()}@test.local`;
  let r = await login(email, 'Whatever123');
  assert.equal(r.status, 401);
  assert.equal(r.json.error.code, 'INVALID_CREDENTIALS');
  await login(email, 'Whatever123');
  r = await login(email, 'Whatever123');
  assert.equal(r.status, 429);
});

test('ограничитель частоты: 429 + Retry-After + RateLimit-*', async () => {
  const limiter = createRateLimiter({ name: 't', windowMs: 60_000, max: 2, keyFn: () => 'k' });
  const make = () => {
    const headers = {};
    const res = { setHeader: (k, v) => { headers[k] = v; } };
    let err = null;
    limiter({ log: { warn() {} } }, res, (e) => { err = e; });
    return { headers, err };
  };
  assert.equal(make().err, null);
  assert.equal(make().err, null);
  const third = make();
  assert.equal(third.err.status, 429);
  assert.ok(Number(third.err.headers['Retry-After']) > 0);
  assert.equal(third.headers['RateLimit-Remaining'], 0);
});

// ---------- активные подключения ----------
test('сессии: список, завершение чужого устройства, лимит подключений', async () => {
  const u = await register();
  const second = await login(u.email);
  let r = await call('GET', '/auth/sessions', { token: u.token });
  assert.equal(r.json.length, 2);
  assert.equal(r.json.filter((s) => s.current).length, 1);
  const other = r.json.find((s) => !s.current);

  assert.equal((await call('DELETE', `/auth/sessions/${other.id}`, { token: u.token })).status, 204);
  assert.equal((await call('DELETE', `/auth/sessions/${other.id}`, { token: u.token })).status, 404);
  // завершённое подключение теряет доступ мгновенно
  assert.equal((await call('GET', '/tasks', { token: second.json.accessToken })).status, 401);

  // лимит MAX_SESSIONS=3: четвёртый вход вытесняет самое старое подключение
  const t2 = await login(u.email);
  const t3 = await login(u.email);
  const t4 = await login(u.email);
  r = await call('GET', '/auth/sessions', { token: t4.json.accessToken });
  assert.equal(r.json.length, 3);
  assert.equal((await call('GET', '/tasks', { token: u.token })).status, 401); // самое старое вытеснено
  assert.equal((await call('GET', '/tasks', { token: t2.json.accessToken })).status, 200);

  // «выйти на всех остальных устройствах»
  assert.equal((await call('DELETE', '/auth/sessions', { token: t4.json.accessToken })).status, 204);
  assert.equal((await call('GET', '/tasks', { token: t3.json.accessToken })).status, 401);
  assert.equal((await call('GET', '/tasks', { token: t4.json.accessToken })).status, 200);
});

// ---------- восстановление доступа ----------
test('восстановление через e-mail: письмо, одноразовая ссылка, смена пароля, завершение сессий', async () => {
  const u = await register();
  const before = outbox.length;
  let r = await call('POST', '/auth/forgot-password', { body: { email: u.email } });
  assert.equal(r.status, 202);
  const unknown = await call('POST', '/auth/forgot-password', { body: { email: 'nobody@test.local' } });
  assert.equal(unknown.status, 202); // одинаковый ответ — нет перечисления адресов
  assert.deepEqual(unknown.json, r.json);

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(outbox.length, before + 1);
  const mail = outbox[outbox.length - 1];
  assert.equal(mail.to, u.email);
  const token = /reset_token=([\w-]+)/.exec(mail.text)[1];

  assert.equal((await call('POST', '/auth/reset-password', { body: { token, password: 'short' } })).status, 400);
  assert.equal((await call('POST', '/auth/reset-password', { body: { token: 'x'.repeat(40), password: 'NewPassw0rd!' } })).json.error.code, 'INVALID_RESET_TOKEN');

  r = await call('POST', '/auth/reset-password', { body: { token, password: 'NewPassw0rd!' } });
  assert.equal(r.status, 204);
  // токен одноразовый
  assert.equal((await call('POST', '/auth/reset-password', { body: { token, password: 'Another1234' } })).status, 400);
  // все старые сессии завершены, старый пароль не работает, новый работает
  assert.equal((await call('GET', '/tasks', { token: u.token })).status, 401);
  assert.equal((await login(u.email, u.password)).status, 401);
  assert.equal((await login(u.email, 'NewPassw0rd!')).status, 200);
});

test('восстановление: просроченная ссылка и ограничение частоты запросов', async () => {
  const u = await register();
  await call('POST', '/auth/forgot-password', { body: { email: u.email } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const token = /reset_token=([\w-]+)/.exec(outbox[outbox.length - 1].text)[1];
  await pool.query(`UPDATE password_resets SET expires_at = now() - interval '1 minute' WHERE user_id = $1`, [u.user.id]);
  const r = await call('POST', '/auth/reset-password', { body: { token, password: 'NewPassw0rd!' } });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'INVALID_RESET_TOKEN');

  const n = outbox.length;
  for (let i = 0; i < 5; i += 1) await call('POST', '/auth/forgot-password', { body: { email: u.email } });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(outbox.length - n <= 2, 'писем в час — не больше лимита');
});

test('смена пароля: проверка текущего, завершение остальных сессий', async () => {
  const u = await register();
  const other = await login(u.email);
  let r = await call('POST', '/auth/change-password', { token: u.token, body: { currentPassword: 'nope', newPassword: 'NewPassw0rd!' } });
  assert.equal(r.status, 400);
  r = await call('POST', '/auth/change-password', { token: u.token, body: { currentPassword: u.password, newPassword: 'NewPassw0rd!' } });
  assert.equal(r.status, 204);
  assert.equal((await call('GET', '/tasks', { token: other.json.accessToken })).status, 401);
  assert.equal((await call('GET', '/tasks', { token: u.token })).status, 200);
});

// ---------- администрирование ----------
test('админ-панель: только admin; смена роли действует сразу; нельзя менять себя; удаление', async () => {
  const u = await register();
  const admin = await adminToken();
  assert.equal((await call('GET', '/users', { token: u.token })).status, 403);
  assert.equal((await call('GET', '/users')).status, 401);

  const adminUser = (await call('GET', '/auth/me', { token: admin })).json.user;
  assert.equal((await call('PATCH', `/users/${adminUser.id}`, { token: admin, body: { role: 'viewer' } })).status, 409);
  assert.equal((await call('PATCH', `/users/${u.user.id}`, { token: admin, body: { role: 'god' } })).status, 400);
  assert.equal((await call('PATCH', '/users/999999', { token: admin, body: { role: 'viewer' } })).status, 404);

  assert.equal((await call('POST', '/tasks', { token: u.token, body: { title: 'ok' } })).status, 201);
  await call('PATCH', `/users/${u.user.id}`, { token: admin, body: { role: 'viewer' } });
  // роль берётся из БД, поэтому ограничение действует немедленно, без перелогина
  assert.equal((await call('POST', '/tasks', { token: u.token, body: { title: 'no' } })).status, 403);

  const sess = await call('GET', `/users/${u.user.id}/sessions`, { token: admin });
  assert.equal(sess.status, 200);
  assert.equal((await call('DELETE', `/users/${u.user.id}/sessions`, { token: admin })).status, 204);
  assert.equal((await call('GET', '/tasks', { token: u.token })).status, 401);

  assert.equal((await call('DELETE', `/users/${adminUser.id}`, { token: admin })).status, 409);
  assert.equal((await call('DELETE', `/users/${u.user.id}`, { token: admin })).status, 204);
  assert.equal((await call('DELETE', `/users/${u.user.id}`, { token: admin })).status, 404);
});

test('health-check доступен без авторизации', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
});
