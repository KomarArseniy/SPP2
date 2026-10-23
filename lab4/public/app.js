'use strict';
/* TypeRush — клиент. Чистый JavaScript, без фреймворков и сборки. */
(() => {
  const $ = (id) => document.getElementById(id);
  const el = {
    conn: $('conn'), join: $('join'), joinForm: $('joinForm'), nameInput: $('nameInput'), joinError: $('joinError'),
    game: $('game'), lanes: $('lanes'), phaseLabel: $('phaseLabel'),
    typingCard: $('typingCard'), textbox: $('textbox'), text: $('text'), typer: $('typer'),
    overlay: $('overlay'), overlayBig: $('overlayBig'), overlaySmall: $('overlaySmall'),
    sWpm: $('sWpm'), sAcc: $('sAcc'), sProg: $('sProg'), sTime: $('sTime'),
    hint: $('hint'), readyBtn: $('readyBtn'),
    results: $('results'), resultsBody: $('resultsBody'), resultsBanner: $('resultsBanner'), nextIn: $('nextIn'),
    lb: $('lb'), lbEmpty: $('lbEmpty')
  };

  // ------------------------------------------------------------ состояние
  let ws = null;
  let me = null;               // { id, name }
  let desiredName = '';        // имя, под которым нужно (пере)входить
  let state = null;            // последнее состояние от сервера
  let clockOffset = 0;         // разница часов сервера и клиента
  let leaderboard = [];

  // локальное состояние набора текста
  let charEls = [];
  let builtTextId = null;
  let words = [];              // текст, разбитый по пробелам
  let wordStarts = [];         // индекс первого символа каждого слова в тексте
  let wIdx = 0;                // номер текущего слова
  let committed = [];          // что набрано в уже завершённых словах
  let committedMissing = [];   // сколько символов не дописано в каждом завершённом слове (штраф, снимается при возврате)
  let committedPos = 0;        // сколько символов тексты пройдено завершёнными словами (с пробелами)
  let committedCorrect = 0;    // сколько из них набрано верно
  let prev = '';               // набранное в текущем слове
  let typedKeys = 0;
  let errors = 0;
  let finishedLocal = false;
  let finishElapsed = 0;
  let lastOverlayKey = '';

  const serverNow = () => Date.now() + clockOffset;
  const phase = () => (state ? state.phase : 'waiting');
  const myServerPlayer = () => (state && me ? state.players.find((p) => p.id === me.id) : null);
  const isRacing = () => phase() === 'racing' && !finishedLocal && (myServerPlayer() ? myServerPlayer().inRace : false);

  // ------------------------------------------------------------ соединение
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      setConn(true);
      if (desiredName) sendJoin(desiredName);
    };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      onMessage(msg);
    };
    ws.onclose = () => {
      setConn(false);
      setTimeout(connect, 1500); // простое автоматическое переподключение
    };
  }
  const send = (obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };
  const sendJoin = (name) => send({ type: 'join', name });

  function setConn(ok) {
    el.conn.className = `conn ${ok ? '' : 'conn--off'}`;
    el.conn.querySelector('span').textContent = ok ? 'онлайн' : 'нет соединения…';
  }

  function onMessage(msg) {
    switch (msg.type) {
      case 'joined':
        me = { id: msg.id, name: msg.name };
        try { localStorage.setItem('typerush:name', msg.name); } catch { /* ignore */ }
        el.join.hidden = true;
        el.game.hidden = false;
        break;
      case 'error':
        if (msg.code === 'name_taken' && me) { setTimeout(() => sendJoin(desiredName), 1500); break; } // возвращаемся после обрыва
        el.joinError.textContent = msg.message;
        desiredName = '';
        me = null;
        el.join.hidden = false;
        el.game.hidden = true;
        break;
      case 'leaderboard':
        leaderboard = msg.rows;
        renderLeaderboard();
        break;
      case 'state':
        clockOffset = msg.now - Date.now();
        state = msg;
        applyState();
        break;
      default:
    }
  }

  // ------------------------------------------------------------ вход
  el.joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = el.nameInput.value.trim();
    el.joinError.textContent = '';
    desiredName = name;
    sendJoin(name);
  });
  try { el.nameInput.value = localStorage.getItem('typerush:name') || ''; } catch { /* ignore */ }

  el.readyBtn.addEventListener('click', () => {
    const mine = myServerPlayer();
    send({ type: 'ready', value: !(mine && mine.ready) });
  });

  // ------------------------------------------------------------ текст и ввод
  // Ввод пословный: пробел завершает слово (даже с ошибками) и переводит к следующему.
  // Поэтому ошибка портит только своё слово, а машинка едет всегда — просто падает точность.
  function buildText(text) {
    el.text.textContent = '';
    words = text.split(' ');
    wordStarts = [];
    let pos = 0;
    for (const w of words) { wordStarts.push(pos); pos += w.length + 1; }
    charEls = [...text].map((ch) => {
      const s = document.createElement('span');
      s.className = 'c';
      s.textContent = ch;
      el.text.appendChild(s);
      return s;
    });
    el.typer.maxLength = words[0].length;
  }

  const countMatches = (typed, word) => {
    let n = 0;
    for (let i = 0; i < typed.length && i < word.length; i++) if (typed[i] === word[i]) n++;
    return n;
  };

  // прогресс: pos — сколько символов текста пройдено, correct — сколько из них набрано верно
  function computeProgress() {
    if (!words.length) return { pos: 0, correct: 0 };
    if (finishedLocal) return { pos: state.text.length, correct: committedCorrect + countMatches(prev, words[wIdx] || '') };
    const w = words[wIdx];
    return { pos: committedPos + Math.min(prev.length, w.length), correct: committedCorrect + countMatches(prev, w) };
  }

  function paintText() {
    for (let w = 0; w < words.length; w++) {
      const word = words[w];
      const start = wordStarts[w];
      const typed = w < wIdx ? committed[w] : w === wIdx ? prev : '';
      for (let i = 0; i < word.length; i++) {
        let cls = 'c';
        if (i < typed.length) cls += typed[i] === word[i] ? ' ok' : ' bad';
        else if (w < wIdx) cls += ' miss'; // символ пропущен
        else if (w === wIdx && i === typed.length && !finishedLocal) cls += ' cur';
        const node = charEls[start + i];
        if (node.className !== cls) node.className = cls;
      }
      if (w < words.length - 1) { // пробел после слова
        const sp = charEls[start + word.length];
        const cls = w === wIdx && prev.length >= word.length && !finishedLocal ? 'c cur' : 'c';
        if (sp.className !== cls) sp.className = cls;
      }
    }
  }

  function resetTyping() {
    wIdx = 0;
    committed = [];
    committedMissing = [];
    committedPos = 0;
    committedCorrect = 0;
    prev = '';
    typedKeys = 0;
    errors = 0;
    finishedLocal = false;
    finishElapsed = 0;
    el.typer.value = '';
  }

  function sendProgress() {
    const { pos, correct } = computeProgress();
    send({ type: 'progress', pos, correct, typed: typedKeys, errors });
    paintText();
    updateLiveStats();
    updateMyLane(pos / state.text.length);
  }

  // завершить текущее слово (нажат пробел)
  function commitWord() {
    if (wIdx >= words.length - 1 || !prev.length) return; // последнее слово пробелом не завершается
    const word = words[wIdx];
    const matches = countMatches(prev, word);
    const missing = word.length - prev.length;
    if (missing > 0) { errors += missing; typedKeys += missing; } // недописанные символы считаем ошибками
    committed.push(prev);
    committedMissing.push(Math.max(0, missing));
    committedPos += word.length + 1;
    committedCorrect += matches + (matches === word.length ? 1 : 0);
    wIdx++;
    prev = '';
    el.typer.value = '';
    el.typer.maxLength = words[wIdx].length;
  }

  // вернуться к предыдущему слову (Backspace при пустом поле): слово снова можно править
  function uncommitWord() {
    if (wIdx === 0) return false;
    const missing = committedMissing.pop();
    const typed = committed.pop();
    wIdx--;
    const word = words[wIdx];
    const matches = countMatches(typed, word);
    committedPos -= word.length + 1;
    committedCorrect -= matches + (matches === word.length ? 1 : 0);
    errors -= missing; // штраф за недописанное снимаем: слово можно дописать
    typedKeys -= missing;
    prev = typed;
    el.typer.maxLength = word.length;
    el.typer.value = typed;
    const end = typed.length;
    el.typer.setSelectionRange(end, end);
    return true;
  }

  let backspaceHandledAt = 0;
  el.typer.addEventListener('beforeinput', (e) => {
    if (e.inputType && /paste|drop/i.test(e.inputType)) { e.preventDefault(); return; } // вставка запрещена
    // запасной путь для экранных клавиатур: «стереть» при пустом поле
    if (e.inputType === 'deleteContentBackward' && isRacing() && el.typer.value === '' && Date.now() - backspaceHandledAt > 80) {
      e.preventDefault();
      if (uncommitWord()) sendProgress();
    }
  });
  ['paste', 'drop', 'cut'].forEach((ev) => el.typer.addEventListener(ev, (e) => e.preventDefault()));

  el.typer.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && isRacing() && el.typer.value === '' && wIdx > 0) {
      e.preventDefault();
      backspaceHandledAt = Date.now();
      if (uncommitWord()) sendProgress();
      return;
    }
    if (e.key === ' ' && isRacing()) {
      e.preventDefault();
      commitWord();
      sendProgress();
    }
  });

  el.typer.addEventListener('input', () => {
    if (!isRacing()) { el.typer.value = prev; return; }
    let v = el.typer.value;
    const hadSpace = v.includes(' '); // запасной путь для экранных клавиатур, где keydown не даёт ' '
    v = v.replace(/ /g, '');
    const word = words[wIdx];
    if (v.length - prev.length > 3) { el.typer.value = prev; return; } // защита от «вставки» не через paste
    for (let i = prev.length; i < v.length; i++) {
      typedKeys++;
      if (v[i] !== word[i]) errors++;
    }
    prev = v;
    el.typer.value = v;
    if (hadSpace) commitWord();
    else if (wIdx === words.length - 1 && prev.length >= word.length) { // последнее слово набрано полностью — финиш
      finishedLocal = true;
      finishElapsed = serverNow() - state.startedAt;
      el.typer.disabled = true;
    }
    sendProgress();
  });

  el.textbox.addEventListener('mousedown', () => { if (!el.typer.disabled) setTimeout(() => el.typer.focus(), 0); });
  el.typer.addEventListener('focus', () => el.textbox.classList.add('textbox--active'));
  el.typer.addEventListener('blur', () => el.textbox.classList.remove('textbox--active'));
  document.addEventListener('keydown', (e) => {
    if (isRacing() && document.activeElement !== el.typer && !e.ctrlKey && !e.metaKey && !e.altKey) el.typer.focus();
  });

  // ------------------------------------------------------------ дорожки
  const lanes = new Map(); // id -> { root, name, ready, stat, place, car }

  function carSvg(hue) {
    const body = `hsl(${hue} 85% 58%)`;
    const dark = `hsl(${hue} 80% 38%)`;
    return `<svg viewBox="0 0 56 26" aria-hidden="true">
      <path d="M3 19c0-3.2 1.2-5.2 4.2-6l8.3-1.6 6.2-5.2c1.2-1 2.4-1.4 4-1.4h9.5c2.6 0 4.6.9 6.4 2.6l3.7 3.6c4.2.4 7.2 1.5 8.3 4.5.4 1.1.4 2.3.4 3.5H3z" fill="${body}"/>
      <path d="M3 19h50c0 1.6-.2 2.6-1.2 2.6H4.2C3.2 21.6 3 20.6 3 19z" fill="${dark}"/>
      <path d="M23.5 7.4c.8-.6 1.6-.8 2.7-.8h8.4c1.6 0 2.6.5 3.7 1.5l2.6 2.7H20.2z" fill="#d7f3ff" opacity=".92"/>
      <circle cx="15" cy="21" r="4.6" fill="#0f1220"/><circle cx="15" cy="21" r="1.8" fill="#9aa4bd"/>
      <circle cx="43" cy="21" r="4.6" fill="#0f1220"/><circle cx="43" cy="21" r="1.8" fill="#9aa4bd"/>
      <rect x="51" y="14.3" width="3" height="2" rx="1" fill="#fde68a"/>
    </svg>`;
  }

  function makeLane(p) {
    const root = document.createElement('div');
    root.className = 'lane';
    root.innerHTML = `<div class="lane__finish"></div>
      <div class="lane__name"><span></span><em class="lane__ready"></em></div>
      <div class="lane__stat"></div><div class="lane__place"></div>
      <div class="car">${carSvg(p.hue)}</div>`;
    el.lanes.appendChild(root);
    return {
      root,
      name: root.querySelector('.lane__name span'),
      ready: root.querySelector('.lane__ready'),
      stat: root.querySelector('.lane__stat'),
      place: root.querySelector('.lane__place'),
      car: root.querySelector('.car')
    };
  }

  const setCar = (lane, progress) => { lane.car.style.left = `calc((100% - 78px) * ${Math.min(1, Math.max(0, progress))} + 6px)`; };

  function updateMyLane(progress) {
    const lane = me && lanes.get(me.id);
    if (lane) setCar(lane, progress);
  }

  function renderLanes() {
    const ids = new Set(state.players.map((p) => p.id));
    for (const [id, lane] of lanes) if (!ids.has(id)) { lane.root.remove(); lanes.delete(id); }
    for (const p of state.players) {
      const lane = lanes.get(p.id) || (lanes.set(p.id, makeLane(p)), lanes.get(p.id));
      const mine = me && p.id === me.id;
      lane.root.className = `lane${mine ? ' lane--me' : ''}${p.connected ? '' : ' lane--off'}`;
      lane.name.textContent = p.name + (mine ? ' (вы)' : '');
      lane.ready.textContent = p.finished ? `🏁 ${p.place} место` : phase() === 'waiting' && p.ready ? '✓ готов' : '';
      lane.ready.classList.toggle('lane__ready--fin', p.finished);
      lane.stat.textContent = phase() === 'racing' || phase() === 'results' ? `${p.wpm} WPM` : '';
      if (!(mine && isRacing())) setCar(lane, p.finished ? 1 : p.progress); // свою машинку двигаем сразу при наборе
    }
  }

  // ------------------------------------------------------------ состояние → интерфейс
  const PHASES = {
    waiting: ['Ожидание игроков', ''],
    countdown: ['Приготовьтесь…', 'pill--warn'],
    racing: ['Гонка идёт', 'pill--go'],
    results: ['Финиш', 'pill--warn']
  };

  function applyState() {
    const ph = phase();
    if (ph !== 'racing') { // во время гонки подпись обновляет updateTimed (там таймер добивания)
      const [label, cls] = PHASES[ph];
      el.phaseLabel.textContent = label;
      el.phaseLabel.className = `pill ${cls}`;
    }

    // текст гонки
    if (ph === 'waiting') {
      if (!el.text.dataset.placeholder) {
        builtTextId = null;
        charEls = [];
        resetTyping();
        el.text.textContent = 'Нажмите «Готов» — текст появится после обратного отсчёта.';
        el.text.dataset.placeholder = '1';
      }
    } else if (state.textId !== builtTextId) {
      builtTextId = state.textId;
      delete el.text.dataset.placeholder;
      resetTyping();
      buildText(state.text);
    }
    el.text.classList.toggle('is-hidden', ph === 'countdown');
    el.text.style.color = el.text.dataset.placeholder ? 'var(--muted)' : '';
    el.text.style.fontFamily = el.text.dataset.placeholder ? 'inherit' : '';
    el.text.style.fontSize = el.text.dataset.placeholder ? '17px' : '';

    const mine = myServerPlayer();
    if (mine && mine.finished && !finishedLocal && ph === 'racing') finishedLocal = true; // вернулись после обрыва уже финишировавшим

    // поле ввода
    const canType = ph === 'racing' && !finishedLocal && mine && mine.inRace;
    if (el.typer.disabled === canType) {
      el.typer.disabled = !canType;
      if (canType) setTimeout(() => el.typer.focus(), 0);
    }

    // блоки
    el.typingCard.hidden = ph === 'results';
    el.results.hidden = ph !== 'results';

    // кнопка и подсказка
    el.readyBtn.hidden = ph !== 'waiting';
    const ready = Boolean(mine && mine.ready);
    el.readyBtn.textContent = ready ? '✓ Готов (отменить)' : 'Готов';
    el.readyBtn.className = `btn ${ready ? 'btn--on' : 'btn--primary'}`;

    renderLanes();
    if (builtTextId !== null && charEls.length) paintText();
    if (ph === 'results') renderResults();
    updateLiveStats();
    updateTimed();
  }

  function renderLeaderboard() {
    el.lb.textContent = '';
    el.lbEmpty.hidden = leaderboard.length > 0;
    for (const row of leaderboard) {
      const li = document.createElement('li');
      if (me && row.name.toLowerCase() === me.name.toLowerCase()) li.className = 'me';
      const name = document.createElement('div');
      name.className = 'lb__name';
      name.textContent = row.name;
      const sub = document.createElement('span');
      sub.className = 'lb__sub';
      sub.textContent = `средний ${row.avgWpm} · побед ${row.wins} · гонок ${row.races}`;
      name.appendChild(sub);
      const wpm = document.createElement('div');
      wpm.className = 'lb__wpm';
      wpm.textContent = row.bestWpm;
      li.append(name, wpm);
      el.lb.appendChild(li);
    }
  }

  function renderResults() {
    const rows = state.results;
    const medals = ['🥇', '🥈', '🥉'];
    el.resultsBody.textContent = '';
    for (const r of rows) {
      const tr = document.createElement('tr');
      if (me && r.id === me.id) tr.className = 'me';
      const cells = [
        r.finished ? (medals[r.place - 1] || String(r.place)) : '—',
        null,
        String(r.wpm),
        `${r.accuracy}%`,
        r.finished ? 'Финиш' : `не добрался (${Math.round(r.progress * 100)}%)`
      ];
      cells.forEach((c, i) => {
        const td = document.createElement('td');
        if (i === 1) {
          const dot = document.createElement('span');
          dot.className = 'dot';
          dot.style.background = `hsl(${r.hue} 85% 58%)`;
          td.append(dot, document.createTextNode(r.name));
        } else td.textContent = c;
        tr.appendChild(td);
      });
      el.resultsBody.appendChild(tr);
    }
    const my = me && rows.find((r) => r.id === me.id);
    let text = 'Гонка завершена.';
    if (my) {
      if (!my.finished) text = 'Вы не успели допечатать текст. В следующий раз получится!';
      else if (my.place === 1 && rows.length > 1) text = `🏆 Победа! ${my.wpm} WPM, точность ${my.accuracy}%`;
      else text = `Вы заняли ${my.place} место — ${my.wpm} WPM, точность ${my.accuracy}%`;
    }
    el.resultsBanner.textContent = text;
  }

  function fmtTime(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function updateLiveStats() {
    if (!state) return;
    const mine = myServerPlayer();
    const len = state.text.length || 1;
    const ph = phase();
    if (ph === 'racing' && mine && mine.inRace) {
      const elapsed = finishedLocal && finishElapsed ? finishElapsed : serverNow() - state.startedAt;
      const { pos, correct } = computeProgress();
      const minutes = elapsed / 60000;
      const wpm = mine.finished ? mine.wpm : minutes > 0.015 ? Math.round(correct / 5 / minutes) : 0;
      el.sWpm.textContent = wpm;
      el.sAcc.textContent = `${typedKeys ? Math.max(0, Math.round(((typedKeys - errors) / typedKeys) * 100)) : 100}%`;
      el.sProg.textContent = `${Math.round((pos / len) * 100)}%`;
      el.sTime.textContent = fmtTime(elapsed);
    } else if (ph === 'waiting' || ph === 'countdown') {
      el.sWpm.textContent = '0';
      el.sAcc.textContent = '100%';
      el.sProg.textContent = '0%';
      el.sTime.textContent = '0:00';
    }
  }

  // таймеры, зависящие от времени (отсчёт, подсказки) — обновляем каждый кадр
  function updateTimed() {
    if (!state) return;
    const ph = phase();
    const mine = myServerPlayer();
    const t = serverNow();
    let key = '';
    let big = '';
    let small = '';

    if (ph === 'countdown') {
      const sec = Math.max(1, Math.ceil((state.countdownEnd - t) / 1000));
      key = `c${sec}`; big = String(sec); small = 'Приготовьтесь, сейчас начнётся гонка';
    } else if (ph === 'racing' && t - state.startedAt < 800) {
      key = 'go'; big = 'GO!'; small = '';
    }
    el.overlay.hidden = !key;
    if (key && key !== lastOverlayKey) {
      el.overlayBig.textContent = big;
      el.overlaySmall.textContent = small;
      el.overlayBig.classList.remove('pop');
      void el.overlayBig.offsetWidth; // перезапуск анимации
      el.overlayBig.classList.add('pop');
    }
    lastOverlayKey = key;

    // подсказка
    let hint = '';
    if (ph === 'waiting') {
      const total = state.players.length;
      const readyN = state.players.filter((p) => p.ready).length;
      if (state.lobbyEnd) {
        const left = Math.max(0, Math.ceil((state.lobbyEnd - t) / 1000));
        hint = `Готовы ${readyN} из ${total}. Старт через ${left} с или когда нажмут «Готов» все.`;
      } else hint = total > 1 ? `В комнате ${total} игроков. Нажмите «Готов», когда будете готовы.` : 'Вы пока один. Откройте вторую вкладку или позовите друзей — можно играть и в одиночку.';
    } else if (ph === 'countdown') hint = 'Положите пальцы на клавиатуру…';
    else if (ph === 'racing') {
      const graceLeft = state.finishDeadline ? Math.max(0, Math.ceil((state.finishDeadline - t) / 1000)) : 0;
      if (mine && mine.finished) hint = state.finishDeadline ? `Вы финишировали! Остальные могут успеть ещё ${graceLeft} с.` : 'Вы финишировали! Ждём остальных…';
      else if (state.finishDeadline) hint = `Кто-то уже финишировал — у вас осталось ${graceLeft} с. Скорее!`;
      else hint = 'Пробел — следующее слово, Backspace стирает (и в прошлом слове). Ошибки не останавливают машинку.';

      // таймер показываем только когда кто-то уже финишировал
      const label = state.finishDeadline ? `Финиш через ${graceLeft} с` : 'Гонка идёт';
      const cls = `pill ${state.finishDeadline ? 'pill--warn' : 'pill--go'}`;
      if (el.phaseLabel.textContent !== label) el.phaseLabel.textContent = label;
      if (el.phaseLabel.className !== cls) el.phaseLabel.className = cls;
    }
    if (el.hint.textContent !== hint) el.hint.textContent = hint;

    if (ph === 'results') el.nextIn.textContent = `Новый раунд через ${Math.max(0, Math.ceil((state.resultsEnd - t) / 1000))} с`;
  }

  function frame() {
    if (state) {
      updateTimed();
      if (phase() === 'racing') updateLiveStats();
    }
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------ старт
  connect();
  requestAnimationFrame(frame);
})();
