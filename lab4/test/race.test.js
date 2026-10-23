'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { createApp } = require('../server');

const FAST = { countdownMs: 150, lobbyMs: 400, resultsMs: 600, raceLimitMs: 4000, maxCps: 100000 };

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'typerush-')), 'data.json');
}

/** Небольшой клиент для тестов: хранит последнее состояние и умеет ждать условия. */
async function client(port, name) {
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  const c = { ws, state: null, leaderboard: [], errors: [], id: null };
  const waiters = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'state') c.state = m;
    if (m.type === 'leaderboard') c.leaderboard = m.rows;
    if (m.type === 'joined') c.id = m.id;
    if (m.type === 'error') c.errors.push(m);
    waiters.slice().forEach((w) => w());
  });
  await new Promise((r) => ws.on('open', r));
  c.send = (o) => ws.send(JSON.stringify(o));
  c.until = (pred, ms = 3000) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for condition')), ms);
    const check = () => {
      if (pred(c)) { clearTimeout(t); waiters.splice(waiters.indexOf(check), 1); resolve(); }
    };
    waiters.push(check);
    check();
  });
  if (name) {
    c.send({ type: 'join', name });
    await c.until((x) => x.id || x.errors.length);
  }
  return c;
}

test('два игрока видят прогресс друг друга, места и статистика сохраняются в файл', async () => {
  const dataFile = tmpFile();
  let app = createApp({ port: 0, dataFile, ...FAST });
  let port = await app.listen();

  const a = await client(port, 'Алиса');
  const b = await client(port, 'Боб');
  await a.until((c) => c.state && c.state.players.length === 2);

  a.send({ type: 'ready', value: true });
  b.send({ type: 'ready', value: true });
  await a.until((c) => c.state.phase === 'racing');
  await b.until((c) => c.state.phase === 'racing');
  const text = a.state.text;
  assert.ok(text.length > 100, 'сервер прислал текст');

  // Алиса печатает половину — Боб должен увидеть это почти мгновенно
  a.send({ type: 'progress', pos: Math.floor(text.length / 2), typed: 80, errors: 2 });
  await b.until((c) => {
    const p = c.state.players.find((x) => x.name === 'Алиса');
    return p && Math.abs(p.progress - 0.5) < 0.02;
  });

  // Боб финиширует первым
  b.send({ type: 'progress', pos: text.length, typed: text.length, errors: 0 });
  await a.until((c) => c.state.players.find((x) => x.name === 'Боб').place === 1);
  a.send({ type: 'progress', pos: text.length, typed: text.length + 5, errors: 5 });
  await a.until((c) => c.state.phase === 'results');

  const [first, second] = a.state.results;
  assert.equal(first.name, 'Боб');
  assert.equal(first.place, 1);
  assert.equal(second.name, 'Алиса');
  assert.equal(second.place, 2);
  assert.ok(second.accuracy < 100);

  await a.until((c) => c.leaderboard.length === 2);
  assert.equal(a.leaderboard.find((r) => r.name === 'Боб').wins, 1);

  // после паузы — снова ожидание, все «не готовы»
  await a.until((c) => c.state.phase === 'waiting');
  assert.ok(a.state.players.every((p) => !p.ready && p.progress === 0));

  a.ws.close(); b.ws.close();
  await app.close();

  // «перезапуск приложения»: данные должны остаться
  app = createApp({ port: 0, dataFile, ...FAST });
  port = await app.listen();
  const c = await client(port, 'Новичок');
  await c.until((x) => x.leaderboard.length === 2);
  assert.deepEqual(c.leaderboard.map((r) => r.name).sort(), ['Алиса', 'Боб']);
  c.ws.close();
  await app.close();
});

test('имена: занятое и некорректное отклоняются', async () => {
  const app = createApp({ port: 0, dataFile: tmpFile(), ...FAST });
  const port = await app.listen();
  const a = await client(port, 'Игрок');
  const dup = await client(port, 'игрок');
  assert.equal(dup.errors[0].code, 'name_taken');
  const bad = await client(port, '<b>');
  assert.equal(bad.errors[0].code, 'bad_name');
  [a, dup, bad].forEach((c) => c.ws.close());
  await app.close();
});

test('защита от накрутки: нереальная скорость игнорируется', async () => {
  const app = createApp({ port: 0, dataFile: tmpFile(), ...FAST, maxCps: 25 });
  const port = await app.listen();
  const a = await client(port, 'Читер');
  a.send({ type: 'ready', value: true });
  await a.until((c) => c.state.phase === 'racing');
  a.send({ type: 'progress', pos: a.state.text.length, typed: 1, errors: 0 });
  await new Promise((r) => setTimeout(r, 300));
  const me = a.state.players[0];
  assert.equal(me.finished, false);
  assert.equal(me.progress, 0);
  a.ws.close();
  await app.close();
});

test('игрок вернулся после обрыва связи во время гонки — его прогресс сохранён', async () => {
  const app = createApp({ port: 0, dataFile: tmpFile(), ...FAST, raceLimitMs: 5000 });
  const port = await app.listen();
  const a = await client(port, 'Анна');
  const b = await client(port, 'Борис');
  a.send({ type: 'ready', value: true });
  b.send({ type: 'ready', value: true });
  await a.until((c) => c.state.phase === 'racing');
  a.send({ type: 'progress', pos: 40, typed: 40, errors: 0 });
  await b.until((c) => c.state.players.find((p) => p.name === 'Анна').progress > 0);
  a.ws.close();
  await b.until((c) => !c.state.players.find((p) => p.name === 'Анна').connected);
  const a2 = await client(port, 'Анна');
  await a2.until((c) => c.id);
  assert.ok(a2.state.players.find((p) => p.name === 'Анна').progress > 0);
  a2.ws.close(); b.ws.close();
  await app.close();
});

test('ошибки не блокируют прогресс: игрок финиширует, а точность и WPM снижаются', async () => {
  const app = createApp({ port: 0, dataFile: tmpFile(), ...FAST });
  const port = await app.listen();
  const a = await client(port, 'Ошибкин');
  a.send({ type: 'ready', value: true });
  await a.until((c) => c.state.phase === 'racing');
  const len = a.state.text.length;
  // пройдено 50 %, из них верно только 30 % текста
  a.send({ type: 'progress', pos: Math.floor(len / 2), correct: Math.floor(len * 0.3), typed: 100, errors: 20 });
  await a.until((c) => Math.abs(c.state.players[0].progress - 0.5) < 0.02);
  // финиш со смесью верных и неверных символов
  a.send({ type: 'progress', pos: len, correct: Math.floor(len * 0.8), typed: 200, errors: 40 });
  await a.until((c) => c.state.phase === 'results');
  const r = a.state.results[0];
  assert.equal(r.finished, true);
  assert.equal(r.accuracy, 80);
  await a.until((c) => c.leaderboard.length === 1); // финиш с ошибками попадает в таблицу лидеров
  assert.equal(a.leaderboard[0].name, 'Ошибкин');
  a.ws.close();
  await app.close();
});

test('нет лимита времени: после первого финиша остальным даётся время, потом гонка заканчивается', async () => {
  const app = createApp({ port: 0, dataFile: tmpFile(), ...FAST, raceLimitMs: 60000, graceMs: 600 });
  const port = await app.listen();
  const a = await client(port, 'Быстрый');
  const b = await client(port, 'Медленный');
  a.send({ type: 'ready', value: true });
  b.send({ type: 'ready', value: true });
  await a.until((c) => c.state.phase === 'racing');
  assert.equal(a.state.finishDeadline, 0, 'пока никто не финишировал — таймера нет');
  await new Promise((r) => setTimeout(r, 800)); // дольше graceMs — но гонка идёт
  assert.equal(a.state.phase, 'racing');

  const len = a.state.text.length;
  a.send({ type: 'progress', pos: len, correct: len, typed: len, errors: 0 });
  await b.until((c) => c.state.finishDeadline > 0);
  b.send({ type: 'progress', pos: Math.floor(len / 3), correct: Math.floor(len / 3), typed: 60, errors: 0 });
  await a.until((c) => c.state.phase === 'results', 3000);
  const slow = a.state.results.find((r) => r.name === 'Медленный');
  assert.equal(slow.finished, false);
  assert.equal(a.state.results[0].name, 'Быстрый');
  a.ws.close(); b.ws.close();
  await app.close();
});

test('прогресс может уменьшаться (игрок стёр символы)', async () => {
  const app = createApp({ port: 0, dataFile: tmpFile(), ...FAST });
  const port = await app.listen();
  const a = await client(port, 'Стирающий');
  a.send({ type: 'ready', value: true });
  await a.until((c) => c.state.phase === 'racing');
  a.send({ type: 'progress', pos: 50, correct: 50, typed: 50, errors: 0 });
  await a.until((c) => c.state.players[0].progress > 0.2);
  a.send({ type: 'progress', pos: 20, correct: 20, typed: 50, errors: 0 });
  await a.until((c) => c.state.players[0].progress < 0.15);
  a.ws.close();
  await app.close();
});

test('таблица лидеров приходит сразу при подключении (до входа) и переживает перезапуск', async () => {
  const dataFile = tmpFile();
  let app = createApp({ port: 0, dataFile, ...FAST });
  let port = await app.listen();
  const a = await client(port, 'Рекордсмен');
  a.send({ type: 'ready', value: true });
  await a.until((c) => c.state.phase === 'racing');
  const len = a.state.text.length;
  a.send({ type: 'progress', pos: len, correct: len, typed: len, errors: 0 });
  await a.until((c) => c.state.phase === 'results');
  a.ws.close();
  await app.close();

  app = createApp({ port: 0, dataFile, ...FAST });
  port = await app.listen();
  const guest = await client(port); // не входим — как после обновления страницы
  await guest.until((c) => c.leaderboard.length === 1);
  assert.equal(guest.leaderboard[0].name, 'Рекордсмен');
  guest.ws.close();
  await app.close();
});

test('текст гонки: случайные разные слова без знаков препинания, латиницы и «ё»', async () => {
  const { generateText, WORDS } = require('../texts');
  assert.ok(WORDS.length >= 200);
  for (let i = 0; i < 50; i++) {
    const text = generateText(35);
    const words = text.split(' ');
    assert.equal(words.length, 35);
    assert.equal(new Set(words).size, 35, 'слова не повторяются');
    assert.match(text, /^[а-я]+( [а-я]+)*$/, 'только строчные русские буквы и одиночные пробелы');
  }
  assert.notEqual(generateText(35), generateText(35)); // тексты разные
});
