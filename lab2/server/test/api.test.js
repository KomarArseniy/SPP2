// Интеграционные тесты API. Нужна работающая PostgreSQL:
//   DATABASE_URL=postgres://spp:spp@localhost:5432/spp npm test
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.UPLOADS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'spp-uploads-'));
const { app } = require('../src/app');
const { init, pool } = require('../src/db');

let server;
let base;

test.before(async () => {
  await init({ retries: 5 });
  await pool.query('TRUNCATE tasks RESTART IDENTITY CASCADE');
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});

test.after(async () => {
  server.close();
  await pool.end();
});

const json = (method, url, body) =>
  fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

test('CRUD задачи и правильные коды ответов', async () => {
  let r = await json('POST', '/tasks', { title: '  Сдать лабу  ', dueDate: '2026-12-01' });
  assert.equal(r.status, 201);
  const task = await r.json();
  assert.equal(task.title, 'Сдать лабу');
  assert.equal(task.status, 'todo');
  assert.equal(task.dueDate, '2026-12-01');
  assert.match(r.headers.get('location'), /\/api\/tasks\/\d+/);

  r = await json('GET', `/tasks/${task.id}`);
  assert.equal(r.status, 200);

  r = await json('PUT', `/tasks/${task.id}`, { title: 'Новое', description: 'd', status: 'done', dueDate: null });
  assert.equal(r.status, 200);
  const updated = await r.json();
  assert.equal(updated.status, 'done');
  assert.equal(updated.dueDate, null);

  r = await json('PATCH', `/tasks/${task.id}`, { status: 'in_progress' });
  assert.equal(r.status, 200);
  const patched = await r.json();
  assert.equal(patched.status, 'in_progress');
  assert.equal(patched.title, 'Новое');

  r = await json('GET', '/tasks?status=in_progress');
  assert.equal((await r.json()).length, 1);
  r = await json('GET', '/tasks?status=done');
  assert.equal((await r.json()).length, 0);
  r = await json('GET', '/tasks?q=нов');
  assert.equal((await r.json()).length, 1);

  r = await json('DELETE', `/tasks/${task.id}`);
  assert.equal(r.status, 204);
  r = await json('GET', `/tasks/${task.id}`);
  assert.equal(r.status, 404);
  r = await json('DELETE', `/tasks/${task.id}`);
  assert.equal(r.status, 404);
});

test('валидация входных данных → 400', async () => {
  const bad = [
    {},
    { title: '' },
    { title: 'x'.repeat(201) },
    { title: 5 },
    { title: 'a', status: 'wrong' },
    { title: 'a', dueDate: '2026-13-45' },
    { title: 'a', dueDate: 'завтра' },
    { title: 'a', description: 42 },
  ];
  for (const body of bad) {
    const r = await json('POST', '/tasks', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    const e = await r.json();
    assert.ok(e.error.message);
  }
  let r = await json('POST', '/tasks', [1, 2]);
  assert.equal(r.status, 400);
  r = await fetch(base + '/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
  assert.equal(r.status, 400);
  r = await json('GET', '/tasks/abc');
  assert.equal(r.status, 400);
  r = await json('GET', '/tasks/99999999999');
  assert.equal(r.status, 400);
  r = await json('GET', '/tasks?status=zzz');
  assert.equal(r.status, 400);
  r = await json('PATCH', '/tasks/1', {});
  assert.equal(r.status, 400);
  r = await json('GET', '/nope');
  assert.equal(r.status, 404);
  r = await json('PUT', '/tasks/12345', { title: 'a' });
  assert.equal(r.status, 404);
});

test('вложения: загрузка, скачивание (кириллица), удаление, лимиты', async () => {
  const { id } = await (await json('POST', '/tasks', { title: 'С файлами' })).json();

  const form = new FormData();
  form.append('files', new Blob(['привет'], { type: 'text/plain' }), 'отчёт.txt');
  let r = await fetch(`${base}/tasks/${id}/attachments`, { method: 'POST', body: form });
  assert.equal(r.status, 201);
  const [att] = await r.json();
  assert.equal(att.name, 'отчёт.txt');

  r = await fetch(base + att.url.replace('/api', ''));
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'привет');
  assert.match(decodeURIComponent(r.headers.get('content-disposition')), /отчёт\.txt/);

  r = await json('GET', `/tasks/${id}`);
  assert.equal((await r.json()).attachments.length, 1);

  // слишком большой файл
  const big = new FormData();
  big.append('files', new Blob([Buffer.alloc(10 * 1024 * 1024 + 10)]), 'big.bin');
  r = await fetch(`${base}/tasks/${id}/attachments`, { method: 'POST', body: big });
  assert.equal(r.status, 413);

  // без файлов / не multipart / несуществующая задача
  r = await fetch(`${base}/tasks/${id}/attachments`, { method: 'POST', body: new FormData() });
  assert.equal(r.status, 400);
  r = await json('POST', `/tasks/${id}/attachments`, {});
  assert.equal(r.status, 415);
  const f2 = new FormData();
  f2.append('files', new Blob(['x']), 'x.txt');
  r = await fetch(`${base}/tasks/777/attachments`, { method: 'POST', body: f2 });
  assert.equal(r.status, 404);

  r = await json('DELETE', `/tasks/${id}/attachments/${att.id}`);
  assert.equal(r.status, 204);
  r = await json('DELETE', `/tasks/${id}/attachments/${att.id}`);
  assert.equal(r.status, 404);

  // на диске после всех операций не должно остаться мусора
  await json('DELETE', `/tasks/${id}`);
  assert.deepEqual(fs.readdirSync(process.env.UPLOADS_DIR), []);
});
