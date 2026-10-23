'use strict';
/**
 * TypeRush — сервер.
 *  - HTTP: раздаёт статические файлы из public/
 *  - WebSocket (ws): игровая логика в реальном времени
 *  - JSON-файл: постоянное хранение статистики игроков
 *
 * Сервер — единственный источник правды: клиент присылает только «сколько символов
 * набрано», а скорость, места и итоги считает сервер.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { WebSocketServer } = require('ws');
const { generateText } = require('./texts');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8'
};

// ---------------------------------------------------------------- хранилище (JSON-файл)
function createStore(file) {
  let data = { players: {}, history: [] };
  try {
    data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    /* файла ещё нет — начинаем с пустых данных */
  }
  let timer = null;

  function flush() {
    clearTimeout(timer);
    timer = null;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, file); // атомарная замена: файл не бывает записан наполовину
    } catch (err) {
      console.error('Не удалось сохранить данные:', err.message); // сервер не должен падать из-за диска
    }
  }
  function save() {
    if (!timer) timer = setTimeout(flush, 200);
  }
  function record(name, { finished, wpm, win }) {
    const key = name.toLowerCase();
    const p = data.players[key] || { name, races: 0, finishedRaces: 0, wins: 0, bestWpm: 0, totalWpm: 0 };
    p.name = name;
    p.races += 1;
    if (finished) {
      p.finishedRaces += 1;
      p.totalWpm += wpm;
      p.bestWpm = Math.max(p.bestWpm, wpm);
    }
    if (win) p.wins += 1;
    data.players[key] = p;
    save();
  }
  function addHistory(entry) {
    data.history.push(entry);
    if (data.history.length > 50) data.history.splice(0, data.history.length - 50);
    save();
  }
  function leaderboard(limit = 10) {
    return Object.values(data.players)
      .filter((p) => p.finishedRaces > 0)
      .sort((a, b) => b.bestWpm - a.bestWpm || b.wins - a.wins)
      .slice(0, limit)
      .map((p) => ({
        name: p.name,
        bestWpm: p.bestWpm,
        avgWpm: Math.round(p.totalWpm / p.finishedRaces),
        wins: p.wins,
        races: p.races
      }));
  }
  return { record, addHistory, leaderboard, flush, get data() { return data; } };
}

// ---------------------------------------------------------------- приложение
function createApp(options = {}) {
  const cfg = {
    port: options.port ?? Number(process.env.PORT || 3000),
    dataFile: options.dataFile || process.env.DATA_FILE || path.join(__dirname, 'data', 'data.json'),
    countdownMs: options.countdownMs ?? 5000,
    lobbyMs: options.lobbyMs ?? 20000,
    resultsMs: options.resultsMs ?? 12000,
    wordCount: options.wordCount ?? 35, // слов в одной гонке
    graceMs: options.graceMs ?? 25000, // после первого финиша остальным даётся столько времени
    raceLimitMs: options.raceLimitMs ?? 600000, // скрытый предохранитель: брошенная вкладка не должна блокировать игру вечно
    maxCps: options.maxCps ?? 25 // верхний предел скорости (≈300 WPM) — защита от накрутки
  };
  const store = createStore(cfg.dataFile);
  const publicDir = path.join(__dirname, 'public');

  // ---- HTTP (статика)
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const file = path.normalize(path.join(publicDir, rel));
    if (!file.startsWith(publicDir + path.sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(buf);
    });
  });

  // ---- игра
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });
  /** @type {Map<string, any>} */
  const players = new Map();
  const game = {
    phase: 'waiting', // waiting → countdown → racing → results → waiting
    textId: 0,
    text: '',
    lobbyEnd: 0,
    countdownEnd: 0,
    startedAt: 0,
    deadline: 0,
    finishDeadline: 0, // когда закончится время на добивание после первого финиша (0 — ещё никто не финишировал)
    resultsEnd: 0,
    finishedCount: 0,
    results: []
  };
  let phaseTimer = null;
  let lobbyTimer = null;
  let dirty = false;

  const now = () => Date.now();
  let hueCounter = Math.floor(Math.random() * 360);
  const nextHue = () => { hueCounter = (hueCounter + 137.5) % 360; return Math.round(hueCounter); }; // «золотой угол» — цвета не похожи друг на друга
  const connected = () => [...players.values()].filter((p) => p.connected);
  const racers = () => [...players.values()].filter((p) => p.inRace);

  function liveWpm(p) {
    if (p.finished) return p.wpm;
    if (game.phase !== 'racing' || !p.inRace) return 0;
    const minutes = (now() - game.startedAt) / 60000;
    return minutes > 0.02 ? Math.round(p.correct / 5 / minutes) : 0;
  }
  function publicPlayer(p) {
    const len = game.text.length || 1;
    return {
      id: p.id,
      name: p.name,
      hue: p.hue,
      ready: p.ready,
      connected: p.connected,
      inRace: p.inRace,
      progress: game.phase === 'waiting' ? 0 : p.pos / len,
      wpm: liveWpm(p),
      finished: p.finished,
      place: p.place
    };
  }
  function stateMessage() {
    const active = game.phase !== 'waiting';
    return {
      type: 'state',
      now: now(),
      phase: game.phase,
      textId: game.textId,
      text: active ? game.text : '',
      lobbyEnd: game.phase === 'waiting' ? game.lobbyEnd : 0,
      countdownEnd: game.countdownEnd,
      startedAt: game.startedAt,
      deadline: game.deadline,
      finishDeadline: game.finishDeadline,
      resultsEnd: game.resultsEnd,
      players: [...players.values()].map(publicPlayer),
      results: game.phase === 'results' ? game.results : []
    };
  }
  function send(ws, msg) {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  }
  function broadcast(msg) {
    const raw = JSON.stringify(msg);
    for (const p of players.values()) if (p.connected && p.ws.readyState === 1) p.ws.send(raw);
  }
  const broadcastLeaderboard = () => broadcast({ type: 'leaderboard', rows: store.leaderboard() });

  // ---- смена фаз
  function resetToWaiting() {
    clearTimeout(phaseTimer);
    clearTimeout(lobbyTimer);
    lobbyTimer = null;
    for (const [id, p] of players) {
      if (!p.connected) {
        players.delete(id);
        continue;
      }
      Object.assign(p, { ready: false, inRace: false, pos: 0, correct: 0, typed: 0, errors: 0, finished: false, place: null, wpm: 0, accuracy: 100 });
    }
    Object.assign(game, { phase: 'waiting', text: '', lobbyEnd: 0, countdownEnd: 0, startedAt: 0, deadline: 0, finishDeadline: 0, resultsEnd: 0, finishedCount: 0, results: [] });
    dirty = true;
  }

  function startCountdown() {
    clearTimeout(lobbyTimer);
    lobbyTimer = null;
    if (game.phase !== 'waiting' || connected().length === 0) return;
    game.textId += 1; // номер раунда: по нему клиент понимает, что текст новый
    game.text = generateText(cfg.wordCount);
    game.phase = 'countdown';
    game.lobbyEnd = 0;
    game.countdownEnd = now() + cfg.countdownMs;
    game.finishedCount = 0;
    game.finishDeadline = 0;
    for (const p of connected()) Object.assign(p, { inRace: true, pos: 0, correct: 0, typed: 0, errors: 0, finished: false, place: null, wpm: 0, accuracy: 100 });
    phaseTimer = setTimeout(startRace, cfg.countdownMs);
    dirty = true;
  }

  function startRace() {
    if (game.phase !== 'countdown') return;
    if (connected().length === 0) return resetToWaiting();
    game.phase = 'racing';
    game.startedAt = now();
    game.deadline = game.startedAt + cfg.raceLimitMs;
    phaseTimer = setTimeout(endRace, cfg.raceLimitMs);
    dirty = true;
  }

  function endRace() {
    if (game.phase !== 'racing') return;
    clearTimeout(phaseTimer);
    const list = racers();
    const total = list.length;
    const ranked = list
      .map((p) => ({ p, wpm: p.finished ? p.wpm : liveWpm(p) }))
      .sort((a, b) => {
        if (a.p.finished && b.p.finished) return a.p.place - b.p.place;
        if (a.p.finished !== b.p.finished) return a.p.finished ? -1 : 1;
        return b.p.pos - a.p.pos;
      });
    game.results = ranked.map(({ p, wpm }) => ({
      id: p.id,
      name: p.name,
      hue: p.hue,
      finished: p.finished,
      place: p.finished ? p.place : null,
      wpm,
      accuracy: p.finished ? p.accuracy : p.typed ? Math.max(0, Math.round(((p.typed - p.errors) / p.typed) * 100)) : 100,
      progress: p.pos / game.text.length
    }));
    for (const r of game.results) {
      const p = players.get(r.id);
      if (p && (r.finished || p.pos > 0)) {
        store.record(r.name, { finished: r.finished, wpm: r.wpm, win: r.finished && r.place === 1 && total >= 2 });
      }
    }
    store.addHistory({ at: new Date().toISOString(), textId: game.textId, results: game.results.map(({ name, place, wpm, accuracy }) => ({ name, place, wpm, accuracy })) });
    game.phase = 'results';
    game.resultsEnd = now() + cfg.resultsMs;
    phaseTimer = setTimeout(resetToWaiting, cfg.resultsMs);
    dirty = true;
    broadcastLeaderboard();
  }

  function checkAllDone() {
    if (game.phase !== 'racing') return;
    const list = racers();
    if (list.length && list.every((p) => p.finished || !p.connected)) endRace();
  }

  // лобби: гонка стартует, когда готовы все, либо через lobbyMs после первого «Готов»
  function evaluateLobby() {
    if (game.phase !== 'waiting') return;
    const list = connected();
    const readyCount = list.filter((p) => p.ready).length;
    if (list.length > 0 && readyCount === list.length) return startCountdown();
    if (readyCount > 0 && !lobbyTimer) {
      game.lobbyEnd = now() + cfg.lobbyMs;
      lobbyTimer = setTimeout(startCountdown, cfg.lobbyMs);
    } else if (readyCount === 0 && lobbyTimer) {
      clearTimeout(lobbyTimer);
      lobbyTimer = null;
      game.lobbyEnd = 0;
    }
    dirty = true;
  }

  // ---- обработка сообщений клиента
  const NAME_RE = /^[\p{L}\p{N}_\- ]{2,16}$/u;

  function handleJoin(ws, msg) {
    if (ws.player) return;
    const name = String(msg.name || '').trim().replace(/\s+/g, ' ');
    if (!NAME_RE.test(name)) return send(ws, { type: 'error', code: 'bad_name', message: 'Имя: 2–16 символов (буквы, цифры, пробел, _ и -).' });
    const key = name.toLowerCase();
    let player = [...players.values()].find((p) => p.name.toLowerCase() === key);
    if (player && player.connected) return send(ws, { type: 'error', code: 'name_taken', message: 'Это имя уже занято. Выберите другое.' });
    if (player) {
      // игрок вернулся после обрыва, пока шла гонка — возвращаем его на место
      player.ws = ws;
      player.connected = true;
    } else {
      player = { id: randomUUID(), name, hue: nextHue(), ws, connected: true, ready: false, inRace: false, pos: 0, correct: 0, typed: 0, errors: 0, finished: false, place: null, wpm: 0, accuracy: 100 };
      players.set(player.id, player);
      if (game.phase === 'countdown') player.inRace = true; // успел до старта — участвует
    }
    ws.player = player;
    send(ws, { type: 'joined', id: player.id, name: player.name });
    send(ws, { type: 'leaderboard', rows: store.leaderboard() });
    send(ws, stateMessage());
    dirty = true;
    if (game.phase === 'waiting') evaluateLobby();
  }

  function handleReady(player, msg) {
    if (game.phase !== 'waiting') return;
    player.ready = Boolean(msg.value);
    evaluateLobby();
    dirty = true;
  }

  function handleProgress(player, msg) {
    if (game.phase !== 'racing' || !player.inRace || player.finished) return;
    const len = game.text.length;
    const pos = Number(msg.pos);
    const typed = Number(msg.typed);
    const errors = Number(msg.errors);
    const correct = msg.correct === undefined ? pos : Number(msg.correct);
    if (![pos, typed, errors, correct].every(Number.isFinite)) return;
    const elapsed = (now() - game.startedAt) / 1000;
    if (pos < 0 || pos > len || pos > elapsed * cfg.maxCps + 15) return; // нереальная скорость — игнорируем
    player.pos = Math.floor(pos);
    player.correct = Math.max(0, Math.min(Math.floor(correct), player.pos)); // верно набранных не больше, чем пройдено
    player.typed = Math.max(0, Math.min(Math.floor(typed), 20000));
    player.errors = Math.max(0, Math.min(Math.floor(errors), player.typed));
    if (player.pos === len) {
      player.finished = true;
      player.place = ++game.finishedCount;
      if (!game.finishDeadline) {
        // первый финишировал: остальным даём ещё graceMs, чтобы закончить
        game.finishDeadline = now() + cfg.graceMs;
        clearTimeout(phaseTimer);
        phaseTimer = setTimeout(endRace, cfg.graceMs);
      }
      const minutes = Math.max((now() - game.startedAt) / 60000, 1e-6);
      player.wpm = Math.round(player.correct / 5 / minutes); // «чистая» скорость: считаются только верные символы
      player.accuracy = player.typed ? Math.max(0, Math.round(((player.typed - player.errors) / player.typed) * 100)) : 100;
      checkAllDone();
    }
    dirty = true;
  }

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    send(ws, { type: 'leaderboard', rows: store.leaderboard() }); // таблицу видно сразу, ещё до входа в игру
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'join') return handleJoin(ws, msg);
      if (!ws.player) return;
      if (msg.type === 'ready') return handleReady(ws.player, msg);
      if (msg.type === 'progress') return handleProgress(ws.player, msg);
    });
    ws.on('close', () => {
      const p = ws.player;
      if (!p || p.ws !== ws) return;
      p.connected = false;
      if (game.phase === 'racing' || game.phase === 'countdown' || game.phase === 'results') {
        // оставляем в списке, чтобы можно было вернуться и чтобы попасть в итоги
        if (game.phase === 'countdown' && connected().length === 0) resetToWaiting();
        checkAllDone();
      } else {
        players.delete(p.id);
        evaluateLobby();
      }
      dirty = true;
    });
    ws.on('error', () => {});
  });

  // раз в 100 мс рассылаем актуальное состояние (если что-то менялось или идёт гонка)
  const tick = setInterval(() => {
    if (dirty || game.phase === 'racing') {
      dirty = false;
      broadcast(stateMessage());
    }
  }, 100);
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);

  return {
    server,
    store,
    config: cfg,
    listen: () => new Promise((resolve) => server.listen(cfg.port, () => resolve(server.address().port))),
    close: () => new Promise((resolve) => {
      clearInterval(tick);
      clearInterval(heartbeat);
      clearTimeout(phaseTimer);
      clearTimeout(lobbyTimer);
      store.flush();
      for (const ws of wss.clients) ws.terminate();
      wss.close(() => server.close(() => resolve()));
    })
  };
}

module.exports = { createApp };

if (require.main === module) {
  const app = createApp();
  app.listen().then((port) => console.log(`TypeRush запущен: http://localhost:${port}`));
  const stop = () => app.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
