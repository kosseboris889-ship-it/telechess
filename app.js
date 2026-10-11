/* ============================================================================
   ТелеШахматы — app.js
   Интерфейс: доска, мышь и тач, история ходов, часы, бот, телекинез.
   Работает поверх Chess (engine.js) и Bot (bot.js).
   ============================================================================ */
(function () {
'use strict';

const CHESS = window.Chess;
const BOT = window.Bot;

const $ = selector => document.querySelector(selector);
const COLOR_NAME = { w: 'Белые', b: 'Чёрные' };
const OPPOSITE = { w: 'b', b: 'w' };
const RESULT_TITLE = { '1-0': 'Победа белых', '0-1': 'Победа чёрных', '1/2-1/2': 'Ничья' };

/* Значок заряда телекинеза — своя молния */
const BOLT_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
  '<path d="M13.5 2 5 13.5h5l-1.5 8.5L17 10.5h-5z"/></svg>';

/* Символ фигуры по её коду ('P','p','n'…). */
function glyphFor(piece) {
  return window.Pieces ? window.Pieces.svg(piece) : '';
}

/* Разметка фигуры в клетке доски */
function pieceHtml(piece) {
  return window.Pieces ? window.Pieces.html(piece) : '';
}

const TIME_CONTROLS = {
  off: { t: 0, inc: 0 },
  '3+2': { t: 180, inc: 2 },
  '5+0': { t: 300, inc: 0 },
  '5+3': { t: 300, inc: 3 },
  '10+0': { t: 600, inc: 0 },
  '15+10': { t: 900, inc: 10 },
};

const SETTINGS_KEY = 'telechess.settings.v1';
const GAME_KEY = 'telechess.game.v1';

const settings = {
  mode: 'bot', level: 'medium', color: 'w', time: 'off',
  highlights: true, sound: true, coords: true, flip: false,
  focus: false,
  collapsed: { status: false, moves: false, settings: false },
};

let game = new CHESS.Game();
let viewPly = 0;               /* какой полуход показан на доске */
let botColor = 'w';            /* цвет, которым играет бот */

const ui = {
  selected: null,              /* выбранная клетка */
  moves: [],                   /* легальные ходы из выбранной клетки */
  swapMode: false,
  swapFirst: null,
  drag: null,
  hover: -1,
  botBusy: false,
  token: 0,                    /* защита от «протухшего» хода бота */
  clocks: null,
  pendingPromotion: null,
  journalOpen: false,
  scrollBeforeFocus: 0,
};

/* ------------------------------------------------------------------ мелочи */

function other(color) { return color === 'w' ? 'b' : 'w'; }

/* ------------------------------------------- панели и режим «только доска» */

function applyPanels() {
  document.querySelectorAll('.panel.collapsible').forEach(panel => {
    const name = panel.dataset.panel;
    const collapsed = !!(settings.collapsed && settings.collapsed[name]);
    panel.classList.toggle('collapsed', collapsed);
    const toggle = panel.querySelector('.panel-toggle');
    if (toggle) toggle.setAttribute('aria-expanded', String(!collapsed));
  });
  updateBadges();
}

/* Подписи в свёрнутых панелях: видно, что идёт партия и какой режим выбран. */
function updateBadges() {
  const statusBadge = $('#badge-status');
  const movesBadge = $('#badge-moves');
  const settingsBadge = $('#badge-settings');
  if (statusBadge) {
    statusBadge.textContent = game.result
      ? (RESULT_TITLE[game.result.result] || 'партия окончена')
      : (live() ? 'ход: ' + (game.turn === 'w' ? 'белые' : 'чёрные') : 'просмотр истории');
  }
  if (movesBadge) {
    movesBadge.textContent = game.sans.length ? game.sans.length + ' ' + pluralMoves(game.sans.length) : 'партия не начата';
  }
  if (settingsBadge) {
    const level = { easy: 'легко', medium: 'средне', hard: 'сложно' }[settings.level] || '';
    settingsBadge.textContent = settings.mode === 'bot' ? 'бот · ' + level : 'двое на устройстве';
  }
}

function pluralMoves(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'ход';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'хода';
  return 'ходов';
}

function setFocusMode(enabled) {
  settings.focus = !!enabled;
  document.body.classList.toggle('focus-mode', settings.focus);
  document.documentElement.style.overflow = settings.focus ? 'hidden' : '';
  $('#btn-focus').textContent = settings.focus ? '⛶ Выйти' : '⛶ Доска';
  if (settings.focus) {
    ui.scrollBeforeFocus = window.scrollY;
    closeJournal();
    window.scrollTo(0, 0);
  } else {
    closeJournal();
    window.scrollTo(0, ui.scrollBeforeFocus);
  }
  updateCellSize();
  save();
}

function openJournal() {
  if (!settings.focus) return;
  ui.journalOpen = true;
  $('#journal').classList.remove('hidden');
  const active = $('#moves-overlay').querySelector('.move.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function closeJournal() {
  ui.journalOpen = false;
  const journal = $('#journal');
  if (journal) journal.classList.add('hidden');
}

/* Если партию перезагрузили из сохранения или сбросили — синхронизируем
   просматриваемый полуход с настоящим, иначе доска перестанет реагировать. */
function current() {
  if (viewPly > game.ply) viewPly = game.ply;
  if (viewPly < 0) viewPly = 0;
  return game.stateAt(viewPly);
}
function live() { return viewPly === game.ply; }

function formatTime(ms) {
  if (ms < 0) ms = 0;
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
}

let toastHandle = null;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toastHandle);
  toastHandle = setTimeout(() => el.classList.add('hidden'), 2400);
}

let audioCtx = null;
function sound(kind) {
  if (!settings.sound) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const now = audioCtx.currentTime;
    const patterns = {
      move: [[440, 0.06]],
      capture: [[230, 0.07], [170, 0.08]],
      swap: [[520, 0.05], [700, 0.07], [880, 0.07]],
      check: [[900, 0.05], [900, 0.05, 0.07]],
      win: [[523, 0.10], [659, 0.10], [784, 0.16]],
      lose: [[392, 0.12], [262, 0.20]],
      error: [[150, 0.14]],
      tick: [[1000, 0.02]],
    };
    for (const [freq, dur, delay] of (patterns[kind] || [])) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = kind === 'error' ? 'sawtooth' : 'triangle';
      osc.frequency.value = freq;
      const at = now + (delay || 0);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.11, at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(at);
      osc.stop(at + dur + 0.03);
    }
  } catch (error) { /* звук не критичен */ }
}

/* --------------------------------------------------------------- доска */

const boardEl = $('#board');
const cells = [];

function sqAt(dr, dc) {
  const rank = settings.flip ? 7 - dr : dr;
  const file = settings.flip ? 7 - dc : dc;
  return rank * 8 + file;
}

function buildBoard() {
  boardEl.innerHTML = '';
  cells.length = 0;
  for (let dr = 0; dr < 8; dr++) {
    for (let dc = 0; dc < 8; dc++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.sq = String(sqAt(dr, dc));
      boardEl.appendChild(cell);
      cells[sqAt(dr, dc)] = cell;
    }
  }
  updateCellSize();
}

function updateCellSize() {
  const size = boardEl.clientWidth / 8;
  if (size > 0) document.documentElement.style.setProperty('--cell', size + 'px');
}

function squareFromPoint(x, y) {
  const rect = boardEl.getBoundingClientRect();
  const size = rect.width / 8;
  if (!size) return -1;
  const dc = Math.floor((x - rect.left) / size);
  const dr = Math.floor((y - rect.top) / size);
  if (dr < 0 || dr > 7 || dc < 0 || dc > 7) return -1;
  return sqAt(dr, dc);
}

function canInteract() {
  if (game.result) return false;
  if (!live()) return false;
  if (ui.botBusy) return false;
  if (settings.mode === 'bot' && game.turn === botColor) return false;
  return true;
}

function legalMoves() {
  return CHESS.legalMoves(game.state);
}

function swapCandidates() {
  const out = new Set();
  if (!canInteract()) return out;
  if (current().charges[game.turn] <= 0) return out;
  for (const move of legalMoves()) {
    if (!move.swap) continue;
    out.add(move.from);
    out.add(move.to);
  }
  return out;
}

function renderBoard() {
  const state = current();
  const pos = state.pos;
  const board = pos.board;
  const turn = pos.turn;

  const marks = new Map();
  if (settings.highlights) {
    if (ui.swapMode) {
      for (const sq of swapCandidates()) marks.set(sq, 'swap');
    } else if (ui.selected !== null && live() && !game.result) {
      for (const move of ui.moves) {
        marks.set(move.to, move.captured ? 'capture' : 'target');
      }
    }
  }

  const lastMove = viewPly > 0 && game.moveObjs[viewPly - 1] ? game.moveObjs[viewPly - 1] : null;
  const checkSq = CHESS.isInCheck(pos, turn) ? CHESS.findKing(board, turn) : -1;

  for (let sq = 0; sq < 64; sq++) {
    const cell = cells[sq];
    if (!cell) continue;
    const piece = board[sq];

    let cls = 'cell ' + (((sq >> 3) + (sq & 7)) % 2 ? 'dark' : 'light');
    if (lastMove && (sq === lastMove.from || sq === lastMove.to)) cls += ' last';
    if (sq === checkSq) cls += ' check';
    if (ui.selected === sq) cls += ' sel';
    if (ui.swapFirst === sq) cls += ' swap-first';
    const mark = marks.get(sq);
    if (mark === 'swap') cls += ' swap-ok';
    else if (mark === 'capture') cls += ' target cap';
    else if (mark) cls += ' target';
    if (ui.hover === sq && ui.drag && ui.drag.moved) cls += ' over';
    cell.className = cls;

    let html = '';
    if (piece) html += pieceHtml(piece);
    if (settings.coords) {
      if (CHESS.rankOf(sq) === (settings.flip ? 7 : 0)) {
        html += '<span class="coord file">' + CHESS.FILE_CHARS[CHESS.fileOf(sq)] + '</span>';
      }
      if (CHESS.fileOf(sq) === 0) {
        html += '<span class="coord rank">' + (CHESS.rankOf(sq) + 1) + '</span>';
      }
    }
    cell.innerHTML = html;
  }
  boardEl.classList.toggle('no-coords', !settings.coords);
}

/* ------------------------------------------------------------ игроки */

function renderPlayers() {
  const state = current();
  const turn = state.pos.turn;
  const topColor = settings.flip ? 'w' : 'b';
  fillCard($('#card-top'), topColor, turn);
  fillCard($('#card-bottom'), other(topColor), turn);
}

function fillCard(el, color, turn) {
  const state = current();
  const active = !game.result && turn === color && live();
  el.className = 'player-card' + (active ? ' active' : '');

  const isBot = settings.mode === 'bot' && color === botColor;
  const charges = state.charges[color];
  const chargeHtml = [0, 1, 2]
    .map(i => '<span class="charge' + (i < charges ? ' full' : '') + '">' + BOLT_SVG + '</span>')
    .join('');

  let badge = '';
  if (game.result) {
    if (game.result.result === '1/2-1/2') badge = '<span class="pc-badge">ничья</span>';
    else badge = '<span class="pc-badge' + (winnerColor() === color ? ' on' : '') + '">' +
      (winnerColor() === color ? 'победа' : 'поражение') + '</span>';
  } else if (active) {
    if (isBot && ui.botBusy) badge = '<span class="pc-badge think">думает…</span>';
    else if (isBot) badge = '<span class="pc-badge">ход бота</span>';
    else badge = '<span class="pc-badge on">' + (settings.mode === 'pvp' ? 'ход' : 'ваш ход') + '</span>';
  }

  const clock = renderClockValue(color);

  el.innerHTML =
    '<div class="pc-avatar ' + color + '">' + glyphFor(color === 'w' ? 'K' : 'k') + '</div>' +
    '<div class="pc-info">' +
      '<div class="pc-name">' + COLOR_NAME[color] + (isBot ? ' · бот' : '') + '</div>' +
      '<div class="pc-sub">' + badge + '</div>' +
      '<div class="pc-charges" title="Заряды телекинеза">' + chargeHtml + '</div>' +
    '</div>' +
    '<div class="pc-clock ' + clock.cls + '">' + clock.text + '</div>';
}

function winnerColor() {
  if (!game.result) return null;
  if (game.result.result === '1-0') return 'w';
  if (game.result.result === '0-1') return 'b';
  return null;
}

function clocksOn() { return (TIME_CONTROLS[settings.time] || TIME_CONTROLS.off).t > 0; }

function renderClockValue(color) {
  if (!clocksOn()) return { text: '∞', cls: 'off' };
  const left = ui.clocks ? ui.clocks[color] : (TIME_CONTROLS[settings.time].t * 1000);
  return { text: formatTime(left), cls: left < 30000 ? 'low' : '' };
}

/* Обновление часов: карточка игрока содержит и время, поэтому перерисовываем её. */
function renderClocks() {
  renderPlayers();
}

/* ------------------------------------------------------- статус и кнопки */

function renderStatus() {
  const dot = $('#turn-dot');
  const text = $('#turn-text');
  const swapBtn = $('#btn-swap');
  const hint = $('#hint-text');

  let message;
  if (game.result) {
    message = RESULT_TITLE[game.result.result] || 'Партия окончена';
    dot.className = 'turn-dot';
  } else if (!live()) {
    message = 'Просмотр истории';
    dot.className = 'turn-dot';
  } else if (settings.mode === 'bot' && game.turn === botColor && ui.botBusy) {
    message = 'Бот думает…';
    dot.className = 'turn-dot ' + botColor;
  } else {
    message = 'Ход: ' + (game.turn === 'w' ? 'белых' : 'чёрных');
    dot.className = 'turn-dot ' + game.turn;
  }
  text.textContent = message;

  const charges = current().charges[game.turn];
  const canSwap = canInteract() && charges > 0;
  const swapLabel = charges > 0
    ? '<span class="bolt">' + BOLT_SVG + '</span> Обмен фигур · ' + charges + (ui.swapMode ? ' · ESC' : '')
    : 'Обмен фигур: зарядов нет';

  swapBtn.disabled = !canSwap;
  swapBtn.classList.toggle('active', ui.swapMode);
  swapBtn.innerHTML = swapLabel;

  const focusSwap = $('#btn-focus-swap');
  if (focusSwap) {
    focusSwap.disabled = !canSwap;
    focusSwap.classList.toggle('active', ui.swapMode);
    const icon = focusSwap.querySelector('.fb-ico');
    if (icon) icon.innerHTML = BOLT_SVG;
    const badge = focusSwap.querySelector('.fb-badge');
    if (badge) {
      badge.textContent = charges > 0 ? String(charges) : '';
      badge.classList.toggle('on', charges > 0);
    }
    const hint = charges > 0
      ? 'Обмен фигур · зарядов: ' + charges + (ui.swapMode ? ' · Esc' : '')
      : (game.result ? 'Обмен недоступен' : 'Обмен фигур: зарядов нет');
    focusSwap.title = hint;
    focusSwap.setAttribute('aria-label', hint);
  }

  if (ui.swapMode) {
    hint.textContent = ui.swapFirst === null
      ? 'Обмен: выберите свою фигуру — её партнёр подсветится'
      : 'Обмен: теперь нажмите вторую фигуру';
  } else if (ui.selected !== null) {
    hint.textContent = 'Показываем ходы. Нажмите клетку или перетащите фигуру.';
  } else if (!live()) {
    hint.textContent = 'Нажмите на доску, чтобы вернуться к текущей позиции.';
  } else if (game.result) {
    hint.textContent = CHESS.DRAW_REASONS[game.result.reason] || (game.result.reason === 'checkmate' ? 'Шах и мат' : '');
  } else {
    hint.textContent = canInteract() ? 'Выберите фигуру — подсветятся её ходы' : 'Ждём соперника';
  }
}

/* ---------------------------------------------------------- список ходов */

function renderMoves() {
  const html = buildMovesHtml();
  const list = $('#moves');
  const overlay = $('#moves-overlay');
  if (list) {
    list.innerHTML = html;
    list.querySelectorAll('.move').forEach(button => {
      button.addEventListener('click', () => goToPly(Number(button.dataset.ply)));
    });
    const active = list.querySelector('.move.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }
  if (overlay) {
    overlay.innerHTML = html;
    overlay.querySelectorAll('.move').forEach(button => {
      button.addEventListener('click', () => {
        goToPly(Number(button.dataset.ply));
        closeJournal();
      });
    });
  }
  updateBadges();
}

function buildMovesHtml() {
  if (!game.sans.length) return '<div class="empty">Ходов пока нет</div>';
  let html = '';
  for (let i = 0; i < game.sans.length; i += 2) {
    const white = game.sans[i];
    const black = game.sans[i + 1];
    html += '<div class="move-row">' +
      '<span class="move-no">' + (i / 2 + 1) + '.</span>' +
      moveButton(white, i + 1, game.moveObjs[i]) +
      moveButton(black, i + 2, game.moveObjs[i + 1]) +
      '</div>';
  }
  return html;
}

function moveButton(san, ply, move) {
  if (!san) return '<span class="move"></span>';
  const isSwap = move && move.swap;
  return '<button class="move' + (isSwap ? ' swap' : '') + (viewPly === ply ? ' active' : '') +
    '" data-ply="' + ply + '" type="button">' + san + '</button>';
}

/* ---------------------------------------------------------- ход игрока */

function clearSelection() {
  ui.selected = null;
  ui.moves = [];
  ui.swapMode = false;
  ui.swapFirst = null;
  ui.hover = -1;
}

function tryMove(from, to) {
  if (ui.swapMode) return trySwap(from, to);

  const candidates = ui.moves.filter(move => move.to === to);
  if (!candidates.length) {
    sound('error');
    return false;
  }
  const normal = candidates.filter(move => !move.promo);
  if (normal.length === 1) { doPlay(normal[0]); return true; }

  ui.pendingPromotion = candidates;
  openPromotion();
  return true;
}

function trySwap(a, b) {
  const move = legalMoves().find(m => m.swap && (
    (m.from === a && m.to === b) || (m.from === b && m.to === a)
  ));
  if (!move) {
    sound('error');
    toast('Такой обмен невозможен');
    ui.swapFirst = b;
    render();
    return false;
  }
  doPlay(move);
  return true;
}

function doPlay(move) {
  const mover = game.turn;
  const result = game.play(move);
  if (!result.ok) { sound('error'); return; }

  viewPly = game.ply;
  clearSelection();
  $('#promo').classList.add('hidden');
  ui.pendingPromotion = null;

  addIncrement(mover);
  onMovePlayed(move, result, mover);
}

function onMovePlayed(move, result, mover) {
  if (move.swap) sound('swap');
  else if (move.captured) sound('capture');
  else sound('move');
  if (result.status && result.status.inCheck && !game.result) sound('check');

  save();
  render();

  if (game.result) {
    ui.token++;
    ui.botBusy = false;
    sound(game.result.result === '1/2-1/2' ? 'win' : (winnerColor() === mover ? 'win' : 'lose'));
    showGameOver();
    return;
  }
  maybeBotMove();
}

/* ------------------------------------------------------------- бот */

async function maybeBotMove() {
  if (settings.mode !== 'bot' || game.result) return;
  if (game.turn !== botColor) return;

  ui.botBusy = true;
  render();
  const token = ++ui.token;
  let found = null;
  try {
    found = await BOT.findBestMove(game.state, { level: settings.level });
  } catch (error) {
    found = null;
  }
  ui.botBusy = false;

  if (token !== ui.token || game.result) { render(); return; }
  if (!found || !found.move) {
    render();
    return;
  }
  doPlay(found.move);
}

/* ------------------------------------------------------------- часы */

function startClocks(restore) {
  const control = TIME_CONTROLS[settings.time] || TIME_CONTROLS.off;
  if (restore && restore.clocks && restore.time === settings.time) {
    ui.clocks = restore.clocks;
    return;
  }
  ui.clocks = { w: control.t * 1000, b: control.t * 1000, inc: control.inc * 1000, started: false, last: 0 };
}

function addIncrement(color) {
  if (!ui.clocks || !clocksOn()) return;
  ui.clocks.started = true;
  ui.clocks[color] += ui.clocks.inc;
  ui.clocks.last = performance.now();
}

function clockTick() {
  const clocks = ui.clocks;
  if (!clocks || !clocksOn() || !clocks.started || game.result) return;
  const now = performance.now();
  const dt = now - clocks.last;
  clocks.last = now;
  const turn = game.turn;
  clocks[turn] -= dt;
  if (clocks[turn] <= 0) {
    clocks[turn] = 0;
    timeout(turn);
    return;
  }
  renderClocks();
}

function timeout(color) {
  game.result = {
    over: true,
    result: color === 'w' ? '0-1' : '1-0',
    reason: 'timeout',
    title: 'Время вышло',
    inCheck: false,
  };
  ui.token++;
  ui.botBusy = false;
  clearSelection();
  save();
  render();
  sound('lose');
  showGameOver();
}

/* ------------------------------------------------- модальные окна */

function openPromotion() {
  const el = $('#promo');
  el.classList.remove('hidden');
}

function showGameOver() {
  const result = game.result;
  if (!result) return;
  $('#over-title').textContent = RESULT_TITLE[result.result] || 'Партия окончена';
  const reason = result.reason === 'checkmate'
    ? 'Шах и мат.'
    : (CHESS.DRAW_REASONS[result.reason] || '');
  $('#over-reason').textContent = reason ? reason + ' (' + result.result + ')' : result.result;
  $('#modal-over').classList.remove('hidden');
}

/* ------------------------------------------------ перетаскивание и тапы */

/* Клик по клетке (используется и в тестах интерфейса). */
function clickSquare(sq) {
  const cell = cells[sq];
  if (!cell) return false;
  const rect = cell.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const options = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1 };
  cell.dispatchEvent(new PointerEvent('pointerdown', options));
  window.dispatchEvent(new PointerEvent('pointerup', options));
  return true;
}

boardEl.addEventListener('pointerdown', onPointerDown);
window.addEventListener('pointermove', onPointerMove);
window.addEventListener('pointerup', onPointerUp);
window.addEventListener('pointercancel', onPointerUp);

function onPointerDown(event) {
  if (event.button !== undefined && event.button !== 0) return;

  /* Просмотр истории: первое же касание возвращает к живой позиции. */
  if (!live() && !game.result) {
    viewPly = game.ply;
    render();
  }
  if (!canInteract()) return;

  const sq = squareFromPoint(event.clientX, event.clientY);
  if (sq < 0) return;

  const state = current();
  const piece = state.pos.board[sq];
  const turn = state.pos.turn;

  if (ui.swapMode) {
    if (!piece || CHESS.colorOf(piece) !== turn) {
      sound('error');
      toast('Обмен возможен только между своими фигурами');
      return;
    }
    if (ui.swapFirst === null) {
      ui.swapFirst = sq;
      render();
      return;
    }
    if (ui.swapFirst === sq) { ui.swapFirst = null; render(); return; }
    trySwap(ui.swapFirst, sq);
    return;
  }

  if (!piece || CHESS.colorOf(piece) !== turn) {
    if (ui.selected !== null) tryMove(ui.selected, sq);
    else { clearSelection(); render(); }
    return;
  }

  ui.selected = sq;
  ui.moves = legalMoves().filter(move => move.from === sq && !move.swap);
  ui.drag = { from: sq, piece, x: event.clientX, y: event.clientY, moved: false, ghost: null };
  render();
}

function onPointerMove(event) {
  const drag = ui.drag;
  if (!drag) return;
  if (!drag.moved) {
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (dx * dx + dy * dy < 36) return;
    drag.moved = true;
    const ghost = document.createElement('div');
    ghost.innerHTML = glyphFor(drag.piece);
    const node = ghost.firstElementChild;
    if (node) {
      node.classList.add('ghost');
      const color = CHESS.colorOf(drag.piece);
      node.classList.add(color);
      document.body.appendChild(node);
      drag.ghost = node;
    }
    moveGhost(event.clientX, event.clientY);
  }
  moveGhost(event.clientX, event.clientY);
  const over = squareFromPoint(event.clientX, event.clientY);
  if (over !== ui.hover) { ui.hover = over; renderBoard(); }
}

function moveGhost(x, y) {
  const drag = ui.drag;
  if (drag && drag.ghost) {
    drag.ghost.style.left = x + 'px';
    drag.ghost.style.top = y + 'px';
  }
}

function onPointerUp(event) {
  const drag = ui.drag;
  if (!drag) return;
  ui.drag = null;
  ui.hover = -1;
  if (drag.ghost) drag.ghost.remove();

  if (!drag.moved) { render(); return; }

  const to = squareFromPoint(event.clientX, event.clientY);
  if (to < 0 || to === drag.from) {
    ui.selected = to === drag.from ? drag.from : null;
    ui.moves = to === drag.from ? legalMoves().filter(m => m.from === to && !m.swap) : [];
    render();
    return;
  }
  tryMove(drag.from, to);
}

/* ------------------------------------------------------------ новая игра */

function newGame() {
  ui.token++;
  ui.botBusy = false;
  game = new CHESS.Game();
  viewPly = 0;
  clearSelection();
  botColor = settings.color === 'r'
    ? (Math.random() < 0.5 ? 'w' : 'b')
    : OPPOSITE[settings.color];   /* игрок выбрал свой цвет — бот играет за другой */
  startClocks();
  $('#modal-over').classList.add('hidden');
  $('#promo').classList.add('hidden');
  save();
  render();
  maybeBotMove();
}

function undoMove() {
  if (game.ply === 0) return;
  ui.token++;
  ui.botBusy = false;
  const count = settings.mode === 'bot' ? 2 : 1;
  game.undo(count);
  viewPly = game.ply;
  clearSelection();
  $('#modal-over').classList.add('hidden');
  $('#promo').classList.add('hidden');
  startClocks();
  save();
  render();
}

/* --------------------------------------------------- сохранение и PGN */

function save() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    localStorage.setItem(GAME_KEY, JSON.stringify({
      game: game.serialize(),
      botColor,
      settings,
      clocks: ui.clocks ? { w: ui.clocks.w, b: ui.clocks.b, inc: ui.clocks.inc, started: ui.clocks.started, last: 0 } : null,
      time: settings.time,
    }));
  } catch (error) { /* приватный режим — просто не сохраняем */ }
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    Object.assign(settings, JSON.parse(raw));
  } catch (error) { /* игнорируем */ }
}

function restoreGame() {
  try {
    const raw = localStorage.getItem(GAME_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!data || !data.game || !data.game.states || !data.game.states.length) return false;
    if (data.settings) Object.assign(settings, data.settings);
    game = CHESS.Game.deserialize(data.game);
    botColor = data.botColor || 'w';
    viewPly = game.ply;
    startClocks({ clocks: data.clocks, time: data.time });
    return true;
  } catch (error) {
    return false;
  }
}

function copyMoves() {
  const text = game.movesText() || 'Ходов пока нет';
  const done = () => toast('Нотация скопирована в буфер обмена');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

function fallbackCopy(text, done) {
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
    done();
  } catch (error) {
    toast('Не удалось скопировать');
  }
}

function downloadPgn() {
  const whiteLabel = settings.mode === 'bot'
    ? (botColor === 'w' ? 'Белые (бот)' : 'Белые')
    : 'Белые';
  const blackLabel = settings.mode === 'bot'
    ? (botColor === 'b' ? 'Чёрные (бот)' : 'Чёрные')
    : 'Чёрные';
  const pgn = game.pgn(whiteLabel, blackLabel);
  try {
    const blob = new Blob([pgn], { type: 'application/x-chess-pgn' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'telechess-' + new Date().toISOString().slice(0, 10) + '.pgn';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('Файл PGN сохранён');
  } catch (error) {
    toast('Не удалось сохранить файл');
  }
}

/* ------------------------------------------------------------ события */

function bindEvents() {
  $('#btn-new').addEventListener('click', newGame);
  $('#btn-rematch').addEventListener('click', newGame);
  $('#btn-undo').addEventListener('click', undoMove);
  $('#btn-copy').addEventListener('click', copyMoves);
  $('#btn-pgn').addEventListener('click', downloadPgn);

  /* сворачивание панелей */
  document.querySelectorAll('.panel-toggle').forEach(toggle => {
    toggle.addEventListener('click', () => {
      const panel = toggle.closest('.panel');
      const name = panel.dataset.panel;
      if (!settings.collapsed) settings.collapsed = {};
      settings.collapsed[name] = !settings.collapsed[name];
      applyPanels();
      save();
    });
  });

  /* режим «только доска» */
  $('#btn-focus').addEventListener('click', () => setFocusMode(!settings.focus));
  $('#btn-focus-exit').addEventListener('click', () => setFocusMode(false));
  $('#btn-journal').addEventListener('click', () => (ui.journalOpen ? closeJournal() : openJournal()));
  $('#btn-journal-close').addEventListener('click', closeJournal);
  $('#journal').addEventListener('click', event => {
    if (event.target.id === 'journal') closeJournal();
  });

  $('#btn-flip').addEventListener('click', () => {
    settings.flip = !settings.flip;
    buildBoard();
    save();
    render();
  });

  const swapBtn = $('#btn-swap');
  const toggleSwap = () => {
    if (!canInteract()) return;
    ui.swapMode = !ui.swapMode;
    ui.swapFirst = null;
    ui.selected = null;
    ui.moves = [];
    sound('tick');
    render();
  };
  swapBtn.addEventListener('click', toggleSwap);
  const focusSwap = $('#btn-focus-swap');
  if (focusSwap) focusSwap.addEventListener('click', toggleSwap);

  $('#btn-rules').addEventListener('click', () => $('#modal-rules').classList.remove('hidden'));
  $('#btn-close-rules').addEventListener('click', () => $('#modal-rules').classList.add('hidden'));
  $('#btn-close-over').addEventListener('click', () => $('#modal-over').classList.add('hidden'));
  $('#modal-over').addEventListener('click', event => {
    if (event.target.id === 'modal-over') $('#modal-over').classList.add('hidden');
  });

  $('#promo').addEventListener('click', event => {
    const button = event.target.closest('.promo-btn');
    if (!button || !ui.pendingPromotion) return;
    const promo = button.dataset.promo;
    const move = ui.pendingPromotion.find(m => m.promo === promo);
    if (move) doPlay(move);
  });

  /* Фигуры в окне превращения и логотип — тем же набором, что и на доске */
  document.querySelectorAll('.promo-btn').forEach(button => {
    const code = (button.dataset.promo || 'q').toUpperCase();
    const slot = button.querySelector('span');
    if (slot) slot.innerHTML = glyphFor(code);
  });
  const brandMark = $('#brand-mark');
  if (brandMark) brandMark.innerHTML = glyphFor('n');

  const modeSelect = $('#opt-mode');
  const levelSelect = $('#opt-level');
  const colorSelect = $('#opt-color');
  const timeSelect = $('#opt-time');
  const highlightToggle = $('#opt-highlights');
  const soundToggle = $('#opt-sound');
  const coordsToggle = $('#opt-coords');

  function applySettings() {
    settings.mode = modeSelect.value;
    settings.level = levelSelect.value;
    settings.color = colorSelect.value;
    settings.time = timeSelect.value;
    settings.highlights = highlightToggle.checked;
    settings.sound = soundToggle.checked;
    settings.coords = coordsToggle.checked;
    $('#field-level').classList.toggle('hidden', settings.mode !== 'bot');
    $('#field-color').classList.toggle('hidden', settings.mode !== 'bot');
    updateBadges();
    save();
  }

  modeSelect.addEventListener('change', () => { applySettings(); newGame(); });
  colorSelect.addEventListener('change', () => { applySettings(); newGame(); });
  timeSelect.addEventListener('change', () => { applySettings(); newGame(); });
  levelSelect.addEventListener('change', () => { applySettings(); });
  highlightToggle.addEventListener('change', () => { applySettings(); render(); });
  soundToggle.addEventListener('change', () => { applySettings(); sound('tick'); });
  coordsToggle.addEventListener('change', () => { applySettings(); render(); });

  document.addEventListener('keydown', event => {
    const target = event.target;
    if (target && target.matches && target.matches('input, select, textarea')) return;
    const key = String(event.key || '').toLowerCase();

    if (event.key === 'Escape') {
      /* приоритет: выйти из фокус-режима → закрыть журнал/окно → снять выделение */
      if (settings.focus) { setFocusMode(false); return; }
      if (ui.journalOpen) { closeJournal(); return; }
      if (!$('#modal-rules').classList.contains('hidden')) { $('#modal-rules').classList.add('hidden'); return; }
      if (!$('#modal-over').classList.contains('hidden')) { $('#modal-over').classList.add('hidden'); return; }
      if (!$('#promo').classList.contains('hidden')) { $('#promo').classList.add('hidden'); render(); return; }
      clearSelection();
      render();
    } else if (key === 'f' || key === 'а') {
      if (!$('#modal-rules').classList.contains('hidden')) return;
      setFocusMode(!settings.focus);
    } else if (event.key === 'ArrowLeft') {
      goToPly(viewPly - 1);
    } else if (event.key === 'ArrowRight') {
      goToPly(viewPly + 1);
    } else if (key === 'n' || key === 'т') {
      newGame();
    }
  });

  window.addEventListener('resize', updateCellSize);
  if (window.ResizeObserver) new ResizeObserver(updateCellSize).observe(boardEl);
}

function goToPly(ply) {
  const target = Math.max(0, Math.min(ply, game.ply));
  if (target === viewPly) return;
  viewPly = target;
  ui.selected = null;
  ui.moves = [];
  render();
}

function fillSettingsUi() {
  $('#opt-mode').value = settings.mode;
  $('#opt-level').value = settings.level;
  $('#opt-color').value = settings.color;
  $('#opt-time').value = settings.time;
  $('#opt-highlights').checked = settings.highlights;
  $('#opt-sound').checked = settings.sound;
  $('#opt-coords').checked = settings.coords;
  $('#field-level').classList.toggle('hidden', settings.mode !== 'bot');
  $('#field-color').classList.toggle('hidden', settings.mode !== 'bot');
  applyPanels();
  document.body.classList.toggle('focus-mode', !!settings.focus);
  $('#btn-focus').textContent = settings.focus ? '⛶ Выйти' : '⛶ Доска';
}

function render() {
  renderBoard();
  renderPlayers();
  renderMoves();
  renderStatus();
  const undoBtn = $('#btn-undo');
  undoBtn.disabled = game.ply === 0;
  updateBadges();
}

/* Небольшой хук для отладки из консоли браузера. */
window.telechess = {
  CHESS,
  ui,
  getGame: () => game,
  getState: () => current(),
  getFen: () => CHESS.toFen(game.state.pos),
  render,
  clickSquare,
  newGame,
};

/* -------------------------------------------------------------- старт */

function init() {
  loadSettings();
  fillSettingsUi();
  buildBoard();
  bindEvents();
  const restored = restoreGame();
  if (!restored) {
    botColor = settings.color === 'r'
    ? (Math.random() < 0.5 ? 'w' : 'b')
    : OPPOSITE[settings.color];   /* игрок выбрал свой цвет — бот играет за другой */
    startClocks();
  }
  render();
  setInterval(clockTick, 100);
  if (game.result) showGameOver();
  maybeBotMove();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) save();
  });
}

document.addEventListener('DOMContentLoaded', init);
})();