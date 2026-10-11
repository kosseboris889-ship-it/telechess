/* ============================================================================
   ТелеШахматы — engine.js
   Движок шахмат + механика «Телекинез» (обмен двух своих фигур за заряд).

   Представление доски: массив из 64 клеток, индекс = rank * 8 + file,
   где rank 0 — первая (белая) горизонталь, file 0 — файл «a».
   Фигура — символ: 'PNBRQK' белые, 'pnbrqk' чёрные, null — пустая клетка.

   Всё чистый JS без зависимостей: работает и на сервере, и через file://.
   ============================================================================ */
'use strict';

/* ------------------------------------------------------------------ утилиты */

const FILE_CHARS = 'abcdefgh';
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const MAX_CHARGES = 3;

/* Права на рокировку храним битовой маской: K=1, Q=2, k=4, q=8 */
const CASTLE_K = 1, CASTLE_Q = 2, CASTLE_KK = 4, CASTLE_QQ = 8;

const sqName = sq => FILE_CHARS[sq & 7] + ((sq >> 3) + 1);

function nameToSq(name) {
  const f = FILE_CHARS.indexOf(String(name)[0]);
  const r = parseInt(String(name)[1], 10) - 1;
  if (f < 0 || r < 0 || r > 7) return -1;
  return r * 8 + f;
}

const fileOf = sq => sq & 7;
const rankOf = sq => sq >> 3;
const squareOf = (file, rank) => rank * 8 + file;
const onBoard = (file, rank) => file >= 0 && file < 8 && rank >= 0 && rank < 8;
const isPromoRank = sq => rankOf(sq) === 0 || rankOf(sq) === 7;

function colorOf(piece) {
  if (!piece) return null;
  return piece === piece.toUpperCase() ? 'w' : 'b';
}
const typeOf = piece => (piece ? piece.toUpperCase() : null);
const isWhitePiece = piece => !!piece && piece === piece.toUpperCase();
const other = color => (color === 'w' ? 'b' : 'w');

/* --------------------------------------------------------- направления ходов */

const KNIGHT_STEPS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KING_STEPS = [[0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1]];
const DIAG_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ORTH_DIRS = [[0, 1], [1, 0], [0, -1], [-1, 0]];

/* --------------------------------------------------------------------- FEN */

function fromFen(fen) {
  const parts = String(fen).trim().split(/\s+/);
  const rows = parts[0].split('/');
  const board = new Array(64).fill(null);
  for (let i = 0; i < 8; i++) {
    let file = 0;
    for (const ch of rows[i] || '8') {
      if (ch >= '1' && ch <= '8') file += Number(ch);
      else if (file < 8) { board[(7 - i) * 8 + file] = ch; file++; }
    }
  }
  let castling = 0;
  for (const ch of parts[2] || '-') {
    if (ch === 'K') castling |= CASTLE_K;
    else if (ch === 'Q') castling |= CASTLE_Q;
    else if (ch === 'k') castling |= CASTLE_KK;
    else if (ch === 'q') castling |= CASTLE_QQ;
  }
  return {
    board,
    turn: parts[1] === 'b' ? 'b' : 'w',
    castling,
    ep: parts[3] && parts[3] !== '-' ? nameToSq(parts[3]) : -1,
    half: Number(parts[4] || 0) || 0,
    full: Number(parts[5] || 1) || 1,
  };
}

function toFen(pos) {
  let out = '';
  for (let rank = 7; rank >= 0; rank--) {
    let empty = 0;
    for (let file = 0; file < 8; file++) {
      const piece = pos.board[rank * 8 + file];
      if (!piece) { empty++; continue; }
      if (empty) { out += empty; empty = 0; }
      out += piece;
    }
    if (empty) out += empty;
    if (rank > 0) out += '/';
  }
  let castle = '';
  if (pos.castling & CASTLE_K) castle += 'K';
  if (pos.castling & CASTLE_Q) castle += 'Q';
  if (pos.castling & CASTLE_KK) castle += 'k';
  if (pos.castling & CASTLE_QQ) castle += 'q';
  return [
    out,
    pos.turn,
    castle || '-',
    pos.ep >= 0 ? sqName(pos.ep) : '-',
    pos.half,
    pos.full,
  ].join(' ');
}

const clonePos = pos => {
  const copy = {
    board: pos.board.slice(),
    turn: pos.turn,
    castling: pos.castling,
    ep: pos.ep,
    half: pos.half,
    full: pos.full,
  };
  if (pos.kings) copy.kings = pos.kings.slice();
  return copy;
};

/* ------------------------------------------------------- состояние партии */
/* state = { pos: Position, charges: { w: 0..3, b: 0..3 } } */

function newState(fen = START_FEN) {
  return { pos: fromFen(fen), charges: { w: 0, b: 0 } };
}

const cloneState = state => ({
  pos: clonePos(state.pos),
  charges: { w: state.charges.w, b: state.charges.b },
});

/* Ключ позиции для повторений (включаем заряды — это часть варианта). */
function posKey(state) {
  const f = toFen(state.pos).split(' ');
  return f[0] + ' ' + f[1] + ' ' + f[2] + ' ' + f[3] + '|' + state.charges.w + state.charges.b;
}

/* ------------------------------------------------------------- атака клетки */
/* Атакована ли клетка sq стороной by? */

function isAttacked(board, sq, by) {
  const byWhite = by === 'w';
  const file = sq & 7, rank = sq >> 3;

  /* пешки */
  const pawnRank = rank + (byWhite ? -1 : 1);
  if (pawnRank >= 0 && pawnRank < 8) {
    const pawn = byWhite ? 'P' : 'p';
    if (file > 0 && board[pawnRank * 8 + file - 1] === pawn) return true;
    if (file < 7 && board[pawnRank * 8 + file + 1] === pawn) return true;
  }

  /* кони */
  const knight = byWhite ? 'N' : 'n';
  for (let i = 0; i < 8; i++) {
    const nf = file + KNIGHT_STEPS[i][0], nr = rank + KNIGHT_STEPS[i][1];
    if (onBoard(nf, nr) && board[nr * 8 + nf] === knight) return true;
  }

  /* король */
  const king = byWhite ? 'K' : 'k';
  for (let i = 0; i < 8; i++) {
    const nf = file + KING_STEPS[i][0], nr = rank + KING_STEPS[i][1];
    if (onBoard(nf, nr) && board[nr * 8 + nf] === king) return true;
  }

  /* ладьи и ферзь — по прямым */
  const rook = byWhite ? 'R' : 'r', queen = byWhite ? 'Q' : 'q';
  for (let i = 0; i < 4; i++) {
    let nf = file + ORTH_DIRS[i][0], nr = rank + ORTH_DIRS[i][1];
    while (onBoard(nf, nr)) {
      const piece = board[nr * 8 + nf];
      if (piece) { if (piece === rook || piece === queen) return true; break; }
      nf += ORTH_DIRS[i][0]; nr += ORTH_DIRS[i][1];
    }
  }

  /* слоны и ферзь — по диагоналям */
  const bishop = byWhite ? 'B' : 'b';
  for (let i = 0; i < 4; i++) {
    let nf = file + DIAG_DIRS[i][0], nr = rank + DIAG_DIRS[i][1];
    while (onBoard(nf, nr)) {
      const piece = board[nr * 8 + nf];
      if (piece) { if (piece === bishop || piece === queen) return true; break; }
      nf += DIAG_DIRS[i][0]; nr += DIAG_DIRS[i][1];
    }
  }

  return false;
}

function findKing(board, color) {
  const king = color === 'w' ? 'K' : 'k';
  for (let sq = 0; sq < 64; sq++) if (board[sq] === king) return sq;
  return -1;
}

/* Под шахом ли сторона color (по умолчанию — тот, кто ходит)? */
function isInCheck(pos, color = pos.turn) {
  const king = findKing(pos.board, color);
  if (king < 0) return false;
  return isAttacked(pos.board, king, other(color));
}

/* ------------------------------------------------- генерация обычных ходов */
/* Псевдолегальные ходы. Ход: { from, to, piece, captured, promo, flags, swap }
   flags: 'c' — взятие, 'e' — взятие на проходе, 'k'/'q' — рокировка,
          'd' — двойной ход пешки */

function generatePseudoMoves(pos, capturesOnly = false) {
  const moves = [];
  const us = pos.turn, them = other(us);
  const board = pos.board;

  const push = (from, to, piece, captured, flags) => {
    moves.push({ from, to, piece, captured: captured || null, promo: null, flags: flags || '', swap: false });
  };
  const pushPromotions = (from, to, piece, captured) => {
    for (const promo of ['q', 'r', 'b', 'n']) {
      moves.push({ from, to, piece, captured: captured || null, promo, flags: captured ? 'c' : '', swap: false });
    }
  };

  for (let sq = 0; sq < 64; sq++) {
    const piece = board[sq];
    if (!piece || colorOf(piece) !== us) continue;
    const type = typeOf(piece);
    const file = sq & 7, rank = sq >> 3;

    switch (type) {
      case 'P': {
        const dir = us === 'w' ? 1 : -1;
        const startRank = us === 'w' ? 1 : 6;
        const promoRank = us === 'w' ? 7 : 0;
        const oneRank = rank + dir;
        if (oneRank < 0 || oneRank > 7) break;
        const one = oneRank * 8 + file;

        if (!board[one]) {
          if (oneRank === promoRank) pushPromotions(sq, one, piece, null);
          else if (!capturesOnly) {
            push(sq, one, piece, null, '');
            if (rank === startRank) {
              const two = (rank + 2 * dir) * 8 + file;
              if (!board[two]) push(sq, two, piece, null, 'd');
            }
          }
        }

        for (const df of [-1, 1]) {
          const nf = file + df;
          if (nf < 0 || nf > 7) continue;
          const to = oneRank * 8 + nf;
          const target = board[to];
          if (target && colorOf(target) === them) {
            if (oneRank === promoRank) pushPromotions(sq, to, piece, target);
            else push(sq, to, piece, target, 'c');
          } else if (!target && pos.ep >= 0 && to === pos.ep) {
            const victim = us === 'w' ? 'p' : 'P';
            push(sq, to, piece, victim, 'e');
          }
        }
        break;
      }

      case 'N':
      case 'K': {
        const steps = type === 'N' ? KNIGHT_STEPS : KING_STEPS;
        for (let i = 0; i < steps.length; i++) {
          const nf = file + steps[i][0], nr = rank + steps[i][1];
          if (!onBoard(nf, nr)) continue;
          const to = nr * 8 + nf;
          const target = board[to];
          if (!target) { if (!capturesOnly) push(sq, to, piece, null, ''); }
          else if (colorOf(target) === them) push(sq, to, piece, target, 'c');
        }

        if (type === 'K' && !capturesOnly && sq === (us === 'w' ? 4 : 60)) {
          const home = us === 'w' ? 0 : 56;
          const enemy = them;
          const safe = (...squares) => !squares.some(s => isAttacked(board, s, enemy));
          if (
            (pos.castling & (us === 'w' ? CASTLE_K : CASTLE_KK)) &&
            !board[home + 5] && !board[home + 6] &&
            board[home + 7] === (us === 'w' ? 'R' : 'r') &&
            safe(home + 4, home + 5, home + 6)
          ) push(sq, home + 6, piece, null, 'k');

          if (
            (pos.castling & (us === 'w' ? CASTLE_Q : CASTLE_QQ)) &&
            !board[home + 1] && !board[home + 2] && !board[home + 3] &&
            board[home + 0] === (us === 'w' ? 'R' : 'r') &&
            safe(home + 4, home + 3, home + 2)
          ) push(sq, home + 2, piece, null, 'q');
        }
        break;
      }

      case 'B':
      case 'R':
      case 'Q': {
        const dirs = type === 'B' ? DIAG_DIRS : type === 'R' ? ORTH_DIRS : DIAG_DIRS.concat(ORTH_DIRS);
        for (let i = 0; i < dirs.length; i++) {
          let nf = file + dirs[i][0], nr = rank + dirs[i][1];
          while (onBoard(nf, nr)) {
            const to = nr * 8 + nf;
            const target = board[to];
            if (!target) { if (!capturesOnly) push(sq, to, piece, null, ''); }
            else {
              if (colorOf(target) === them) push(sq, to, piece, target, 'c');
              break;
            }
            nf += dirs[i][0]; nr += dirs[i][1];
          }
        }
        break;
      }
    }
  }

  return moves;
}

/* ---------------------------------------------------------- права на рокировку */
/* Любая фигура, покидающая «свой» угловой или королевской квадрат, гасит права. */

function updateCastlingRights(castling, touched) {
  let result = castling;
  for (const sq of touched) {
    if (sq === 0) result &= ~CASTLE_Q;          // a1 — белые, ферзевая сторона
    else if (sq === 7) result &= ~CASTLE_K;      // h1
    else if (sq === 56) result &= ~CASTLE_QQ;    // a8
    else if (sq === 63) result &= ~CASTLE_KK;    // h8
    else if (sq === 4) { result &= ~CASTLE_K; result &= ~CASTLE_Q; }   // e1
    else if (sq === 60) { result &= ~CASTLE_KK; result &= ~CASTLE_QQ; } // e8
  }
  return result & 15;
}

/* ------------------------------------------------------- генерация обменов */
/* Обмен (телекинез): меняем местами две свои фигуры, тратим 1 заряд.

   Оптимизация: копировать доску для проверки не нужно. Обе меняемые клетки
   заняты своими фигурами, поэтому для скользящих лучей важен только факт
   «своя фигура закрывает», а он одинаков и до, и после обмена. Меняется
   лишь положение короля. */

function swapMoves(state, maxSwaps = Infinity) {
  const pos = state.pos;
  if (state.charges[pos.turn] <= 0) return [];

  const own = [];
  for (let sq = 0; sq < 64; sq++) {
    const piece = pos.board[sq];
    if (piece && colorOf(piece) === pos.turn) own.push(sq);
  }
  if (own.length < 2) return [];

  const kingSq = findKing(pos.board, pos.turn);
  const them = other(pos.turn);

  /* Дешёвая эвристика отбора: насколько обмен улучшает обе фигуры. */
  const candidates = [];
  for (let i = 0; i < own.length; i++) {
    for (let j = i + 1; j < own.length; j++) {
      const a = own[i], b = own[j];
      const pa = pos.board[a], pb = pos.board[b];
      /* пешка не может обменом попасть на крайнюю линию */
      if ((typeOf(pa) === 'P' && isPromoRank(b)) || (typeOf(pb) === 'P' && isPromoRank(a))) continue;
      candidates.push({ a, b, weight: swapHeuristic(pa, a, pb, b) });
    }
  }
  candidates.sort((x, y) => y.weight - x.weight);

  const out = [];
  for (const cand of candidates) {
    if (out.length >= maxSwaps) break;
    const { a, b } = cand;
    const newKingSq = a === kingSq ? b : b === kingSq ? a : kingSq;
    if (newKingSq >= 0 && isAttacked(pos.board, newKingSq, them)) continue;
    out.push({
      from: a, to: b,
      piece: pos.board[a],
      captured: null, promo: null, flags: 's', swap: true,
      /* вес отбора: движок сортирует им обмены, чтобы не пробовать
         первыми заведомо бесполезные пары */
      swapWeight: cand.weight,
    });
  }
  return out;
}

/* Оценка «насколько удачно встанут фигуры после обмена» (только для отбора). */
function swapHeuristic(pa, a, pb, b) {
  const value = { P: 0, N: 40, B: 45, R: 20, Q: 5, K: 0 };
  return (value[typeOf(pa)] || 0) + (value[typeOf(pb)] || 0)
    + squarePreference(pa, b) + squarePreference(pb, a)
    - squarePreference(pa, a) - squarePreference(pb, b);
}

/* Грубая «привлекательность» клетки — зеркалится для чёрных. */
function squarePreference(piece, sq) {
  const table = {
    P: [[0, 4, 8, 14, 20, 26, 40, 60]],
    N: [[-10, -6, 4, 8, 12, 4, -6, -10]],
    B: [[-8, -4, 2, 6, 6, 2, -4, -8]],
    R: [[0, 2, 4, 4, 6, 6, 8, 10]],
    Q: [[0, 0, 2, 4, 4, 2, 0, 0]],
    K: [[-12, -8, -4, 0, 2, 2, 4, 6]],
  };
  const rank = isWhitePiece(piece) ? rankOf(sq) : 7 - rankOf(sq);
  const file = fileOf(sq);
  return table[typeOf(piece)][0][rank * 8 + file];
}

/* ------------------------------------------------------------- применение хода */
/* applyMove возвращает НОВОЕ состояние или null, если ход невозможен. */

function applyMove(state, move) {
  if (!move) return null;
  const pos = state.pos;
  const us = pos.turn, them = other(us);

  if (move.swap) return applySwap(state, move);

  const piece = pos.board[move.from];
  if (!piece || colorOf(piece) !== us) return null;
  const target = pos.board[move.to];
  if (target && colorOf(target) === us) return null;
  /* Короля не берут. В честной партии такая позиция невозможна (сторона,
     чей король под боем, не может ходить), поэтому это лишь защита от
     некорректных позиций, загруженных вручную. */
  if (target && typeOf(target) === 'K') return null;
  if (move.flags === 'e' && pos.ep !== move.to) return null;

  const board = pos.board.slice();
  const flags = move.flags;

  /* взятие на проходе: снимаем пешку с промежуточной клетки */
  if (flags === 'e') {
    const victimSq = move.to + (us === 'w' ? -8 : 8);
    board[victimSq] = null;
  }

  board[move.to] = move.promo ? (us === 'w' ? move.promo.toUpperCase() : move.promo) : piece;
  board[move.from] = null;

  /* рокировка: переносим ладью */
  const touched = [move.from, move.to];
  if (flags === 'k') { board[move.to - 1] = board[move.to + 1]; board[move.to + 1] = null; touched.push(move.to + 1); }
  if (flags === 'q') { board[move.to + 1] = board[move.to - 2]; board[move.to - 2] = null; touched.push(move.to - 2); }
  if (flags === 'e') touched.push(move.to + (us === 'w' ? -8 : 8));

  /* новый король и безопасность */
  const kingSq = typeOf(piece) === 'K' ? move.to : kingsOf(pos)[us === 'w' ? 0 : 1];
  if (kingSq < 0 || isAttacked(board, kingSq, them)) return null;

  const isPawnMove = typeOf(piece) === 'P';
  const isCapture = !!target || flags === 'e';

  let ep = -1;
  if (flags === 'd') ep = (rankOf(move.from) + (us === 'w' ? 1 : -1)) * 8 + fileOf(move.from);

  const nextPos = {
    board,
    turn: them,
    castling: updateCastlingRights(pos.castling, touched),
    ep,
    half: isPawnMove || isCapture ? 0 : pos.half + 1,
    full: us === 'b' ? pos.full + 1 : pos.full,
  };
  const kings = kingsOf(pos).slice();
  kings[us === 'w' ? 0 : 1] = kingSq;
  nextPos.kings = kings;

  /* Взятие копит заряд (максимум 3). */
  const charges = { w: state.charges.w, b: state.charges.b };
  if (isCapture) charges[us] = Math.min(MAX_CHARGES, charges[us] + 1);

  return { pos: nextPos, charges };
}

function applySwap(state, move) {
  const pos = state.pos;
  const us = pos.turn;
  const pa = pos.board[move.from], pb = pos.board[move.to];
  if (!pa || !pb) return null;
  if (colorOf(pa) !== us || colorOf(pb) !== us) return null;
  if ((typeOf(pa) === 'P' && isPromoRank(move.to)) || (typeOf(pb) === 'P' && isPromoRank(move.from))) return null;
  if (state.charges[us] <= 0) return null;

  const board = pos.board.slice();
  board[move.to] = pa;
  board[move.from] = pb;

  /* Король после обмена и проверка безопасности. */
  const oldKingSq = kingsOf(pos)[us === 'w' ? 0 : 1];
  const newKingSq = move.from === oldKingSq ? move.to
    : move.to === oldKingSq ? move.from
      : oldKingSq;
  if (newKingSq < 0 || isAttacked(board, newKingSq, other(us))) return null;

  const nextPos = {
    board,
    turn: other(us),
    castling: updateCastlingRights(pos.castling, [move.from, move.to]),
    ep: -1,
    half: pos.half + 1,
    full: us === 'b' ? pos.full + 1 : pos.full,
  };
  const swapKings = kingsOf(pos).slice();
  swapKings[us === 'w' ? 0 : 1] = newKingSq;
  nextPos.kings = swapKings;

  return {
    pos: nextPos,
    /* Обмен тратит ровно один заряд стороны, которая его делает. */
    charges: { w: us === 'w' ? state.charges.w - 1 : state.charges.w, b: us === 'b' ? state.charges.b - 1 : state.charges.b },
  };
}

/* ---------------------------------------------------------- легальные ходы */

/* Положение королей кэшируем прямо на позиции: иначе поиск бота сканирует
   доску по 64 клетки на каждый проверяемый ход. */
function kingsOf(pos) {
  if (!pos.kings) pos.kings = [findKing(pos.board, 'w'), findKing(pos.board, 'b')];
  return pos.kings;
}

/* Быстрая проверка легальности: делаем ход по месту, проверяем короля
   и откатываем. Не создаём ни доски, ни объектов состояния — это в разы
   быстрее applyMove и заметно ускоряет перебор ходов в поиске. */
function isLegalMove(pos, move) {
  const board = pos.board;
  const us = pos.turn, them = other(us);
  const piece = board[move.from];
  if (!piece || colorOf(piece) !== us) return false;
  const target = board[move.to];
  if (target && colorOf(target) === us) return false;
  if (target && typeOf(target) === 'K') return false;      /* короля не берут */
  if (move.flags === 'e' && pos.ep !== move.to) return false;

  const savedVictimSq = move.flags === 'e' ? move.to + (us === 'w' ? -8 : 8) : -1;
  const savedVictim = savedVictimSq >= 0 ? board[savedVictimSq] : null;

  if (savedVictimSq >= 0) board[savedVictimSq] = null;
  board[move.from] = null;
  board[move.to] = move.promo ? (us === 'w' ? move.promo.toUpperCase() : move.promo) : piece;

  let rookFrom = -1, rookTo = -1;
  if (move.flags === 'k') { rookFrom = move.to + 1; rookTo = move.to - 1; }
  else if (move.flags === 'q') { rookFrom = move.to - 2; rookTo = move.to + 1; }
  if (rookFrom >= 0) { board[rookTo] = board[rookFrom]; board[rookFrom] = null; }

  const kingSq = typeOf(piece) === 'K' ? move.to : kingsOf(pos)[us === 'w' ? 0 : 1];
  const ok = kingSq >= 0 && !isAttacked(board, kingSq, them);

  /* откат */
  if (rookFrom >= 0) { board[rookFrom] = board[rookTo]; board[rookTo] = null; }
  board[move.to] = target;
  board[move.from] = piece;
  if (savedVictimSq >= 0) board[savedVictimSq] = savedVictim;

  return ok;
}

function legalMoves(state, opts = {}) {
  const out = [];
  const pseudo = generatePseudoMoves(state.pos, !!opts.capturesOnly);
  for (let i = 0; i < pseudo.length; i++) {
    if (isLegalMove(state.pos, pseudo[i])) out.push(pseudo[i]);
  }
  if (opts.allowSwaps !== false && !opts.capturesOnly) {
    const swaps = swapMoves(state, opts.maxSwaps === undefined ? Infinity : opts.maxSwaps);
    for (let i = 0; i < swaps.length; i++) out.push(swaps[i]);
  }
  return out;
}

/* -------------------------------------------------------------- статус игры */

function insufficientMaterial(board) {
  const pieces = [];
  for (let sq = 0; sq < 64; sq++) {
    const piece = board[sq];
    if (!piece) continue;
    const type = typeOf(piece);
    if (type === 'K') continue;
    if (type === 'P' || type === 'R' || type === 'Q') return false;
    pieces.push({ type, sq });
  }
  if (pieces.length === 0) return true;                       // K vs K
  if (pieces.length === 1) return true;                       // K+ minor vs K
  if (pieces.length === 2 && pieces.every(p => p.type === 'B')) {
    /* два слона одного цвета — мат поставить нельзя */
    const light = s => ((s >> 3) + (s & 7)) & 1;
    return light(pieces[0].sq) === light(pieces[1].sq);
  }
  return false;
}

const DRAW_REASONS = {
  stalemate: 'Пат — ходов нет, шаха нет',
  fifty: 'Ничья: правило 50 ходов',
  material: 'Ничья: недостаточно материала',
  repetition: 'Ничья: трижды повторившаяся позиция',
  timeout: 'Истекло время',
  resign: 'Сдача',
};

function getStatus(state, keys) {
  const moves = legalMoves(state);
  const check = isInCheck(state.pos, state.pos.turn);
  if (moves.length === 0) {
    return check
      ? { over: true, result: state.pos.turn === 'w' ? '0-1' : '1-0', reason: 'checkmate', inCheck: true, title: 'Мат' }
      : { over: true, result: '1/2-1/2', reason: 'stalemate', inCheck: false, title: 'Пат' };
  }
  if (state.pos.half >= 100) {
    return { over: true, result: '1/2-1/2', reason: 'fifty', inCheck: check, title: 'Ничья' };
  }
  if (insufficientMaterial(state.pos.board)) {
    return { over: true, result: '1/2-1/2', reason: 'material', inCheck: check, title: 'Ничья' };
  }
  if (keys && keys.length) {
    const key = posKey(state);
    let seen = 0;
    for (const k of keys) if (k === key) seen++;
    if (seen >= 3) {
      return { over: true, result: '1/2-1/2', reason: 'repetition', inCheck: check, title: 'Ничья' };
    }
  }
  return { over: false, inCheck: check };
}

function statusOfPosition(state) {
  const check = isInCheck(state.pos, state.pos.turn);
  const moves = legalMoves(state);
  return { check, mate: check && moves.length === 0, moves: moves.length };
}

/* ------------------------------------------------------------------- SAN */

function toSan(state, move, after) {
  const file = FILE_CHARS[fileOf(move.from)];

  if (move.swap) {
    const a = move.piece;
    const b = state.pos.board[move.to];
    return `${a}${sqName(move.from)}↔${b}${sqName(move.to)}`;
  }
  if (move.flags === 'k' || move.flags === 'q') {
    return withCheck(move.flags === 'k' ? 'O-O' : 'O-O-O', after);
  }

  const type = typeOf(move.piece);
  let san = '';

  if (type === 'P') {
    if (move.captured) san += file + 'x';
  } else {
    san += type;
    /* Различение фигур: ищем ДРУГИЕ легальные ходы той же фигуры на ту же клетку. */
    const rivals = legalMoves(state, { allowSwaps: false })
      .filter(m => m.from !== move.from && m.to === move.to && m.piece === move.piece);
    if (rivals.length) {
      const sameFile = rivals.some(m => fileOf(m.from) === fileOf(move.from));
      const sameRank = rivals.some(m => rankOf(m.from) === rankOf(move.from));
      if (!sameFile) san += file;
      else if (!sameRank) san += String(rankOf(move.from) + 1);
      else san += sqName(move.from);
    }
    if (move.captured) san += 'x';
  }

  san += sqName(move.to);
  if (move.promo) san += '=' + move.promo.toUpperCase();

  const info = statusOfPosition(after);
  if (info.check) san += info.mate ? '#' : '+';
  else if (move.flags === 'e') san += ' e.p.';
  return san;
}

function withCheck(san, after) {
  const info = statusOfPosition(after);
  if (info.check) return san + (info.mate ? '#' : '+');
  return san;
}

/* ----------------------------------------------------------------- perft */
/* Проверка генератора ходов по классическим значениям. */

function perft(state, depth) {
  if (depth === 0) return 1;
  const moves = legalMoves(state, { allowSwaps: false });
  if (depth === 1) return moves.length;
  let nodes = 0;
  for (const move of moves) {
    const next = applyMove(state, move);
    if (next) nodes += perft(next, depth - 1);
  }
  return nodes;
}

const PERFT_SUITES = [
  { name: 'startpos', fen: START_FEN, expect: [20, 400, 8902, 197281, 4865609] },
  { name: 'kiwipete', fen: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', expect: [48, 2039, 97862] },
  { name: 'position3', fen: '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', expect: [14, 191, 2812] },
  { name: 'position4', fen: 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', expect: [6, 264, 9467] },
  { name: 'position5', fen: 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', expect: [44, 1486, 62379] },
];

/* ------------------------------------------------------------------ класс */

class Game {
  constructor() { this.reset(); }

  reset(fen = START_FEN) {
    this.past = [newState(fen)];   /* past[i] — состояние после i полуходов */
    this.sans = [];
    this.moveObjs = [];             /* сами ходы — нужны для подсветки на доске */
    this.keys = [posKey(this.past[0])];
    this.result = null;
    return this;
  }

  get state() { return this.past[this.past.length - 1]; }
  get pos() { return this.state.pos; }
  get turn() { return this.state.pos.turn; }
  get ply() { return this.past.length - 1; }

  /* состояние после n полуходов (для просмотра истории) */
  stateAt(ply) { return this.past[Math.max(0, Math.min(ply, this.past.length - 1))]; }

  moves() { return legalMoves(this.state); }

  movesFrom(sq) { return legalMoves(this.state).filter(m => m.from === sq); }

  hasSwapAt(sq) { return legalMoves(this.state).some(m => m.swap && m.from === sq); }

  status() { return getStatus(this.state, this.keys); }

  /* Ход: применение, нотация, обновление результата. */
  play(move) {
    const before = this.state;
    const after = applyMove(before, move);
    if (!after) return { ok: false };

    const san = toSan(before, move, after);
    const key = posKey(after);
    const keys = this.keys.concat([key]);
    const status = getStatus(after, keys);

    this.past.push(after);
    this.sans.push(san);
    this.moveObjs.push(move);
    this.keys.push(key);
    if (status.over) this.result = status;
    return { ok: true, san, status };
  }

  /* Отмена последнего полухода (или нескольких подряд). */
  undo(count = 1) {
    let undone = 0;
    for (let i = 0; i < count; i++) {
      if (this.past.length <= 1) break;
      this.past.pop();
      this.sans.pop();
      this.moveObjs.pop();
      this.keys.pop();
      undone++;
    }
    this.result = getStatus(this.state, this.keys);
    if (!this.result.over) this.result = null;
    return undone;
  }

  /* Сериализация для localStorage */
  serialize() {
    return {
      v: 1,
      sans: this.sans,
      moves: this.moveObjs.map(m => [m.from, m.to, m.promo || '', m.swap ? 1 : 0]),
      states: this.past.map(s => ({ fen: toFen(s.pos), charges: [s.charges.w, s.charges.b] })),
    };
  }

  static deserialize(data) {
    const game = new Game();
    if (!data || !Array.isArray(data.states) || !data.states.length) return game;
    game.past = data.states.map(s => {
      const state = newState(s.fen);
      state.charges.w = (s.charges && s.charges[0]) || 0;
      state.charges.b = (s.charges && s.charges[1]) || 0;
      return state;
    });
    game.sans = data.sans || [];
    game.moveObjs = (data.moves || []).map(m => ({
      from: m[0], to: m[1], promo: m[2] || null, swap: !!m[3],
    }));
    game.keys = game.past.map(posKey);
    const status = getStatus(game.state, game.keys);
    if (status.over) game.result = status;
    return game;
  }

  fen() { return toFen(this.state.pos); }
  movesText() { return this.sans.join(' '); }

  pgn(whiteName, blackName) {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '.');
    const pairs = [];
    for (let i = 0; i < this.sans.length; i += 2) {
      const num = Math.floor(i / 2) + 1;
      const white = this.sans[i];
      const black = this.sans[i + 1];
      pairs.push(`${num}. ${white || ''}${black ? ' ' + black : ''}`);
    }
    const result = this.result ? this.result.result : '*';
    return [
      '[Event "ТелеШахматы"]',
      '[Site "TeleChess"]',
      `[Date "${date}"]`,
      '[Round "1"]',
      `[White "${whiteName || 'Белые'}"]`,
      `[Black "${blackName || 'Чёрные'}"]`,
      '[Variant "TeleChess"]',
      `[Result "${result}"]`,
      '',
      pairs.join(' '),
      result,
    ].join('\n');
  }
}

/* ------------------------------------------------------------------ экспорт */

const Chess = {
  FILE_CHARS, START_FEN, MAX_CHARGES,
  CASTLE_K, CASTLE_Q, CASTLE_KK, CASTLE_QQ,
  sqName, nameToSq, fileOf, rankOf, squareOf, onBoard, isPromoRank,
  colorOf, typeOf, isWhitePiece, other,
  fromFen, toFen, clonePos, cloneState, posKey,
  isAttacked, findKing, isInCheck,
  generatePseudoMoves, legalMoves, applyMove, swapMoves,
  insufficientMaterial, getStatus, statusOfPosition, toSan, perft, PERFT_SUITES,
  DRAW_REASONS, newState, Game,
};

if (typeof window !== 'undefined') window.Chess = Chess;