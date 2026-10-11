/* ============================================================================
   ТелеШахматы — bot.js
   Оценка позиции и поиск: PVS с итеративным углублением, null-move, LMR,
   форсированный поиск с шахами, таблица transposition, killer/history.
   Бот играет по тем же правилам, что и человек (Chess.legalMoves), поэтому
   умеет и обычные ходы, и обмен фигурами (телекинез), и видит заряды.
   ============================================================================ */
'use strict';

const VALUES = { P: 100, N: 320, B: 330, R: 500, Q: 900, K: 0 };

/* Таблицы полей, индексация как у доски: rank 0 = 1-я горизонталь, file 0 = a. */
const PST = {
  P: [
      0,  0,  0,  0,  0,  0,  0,  0,
      5, 10, 10,-25,-25, 10, 10,  5,
      5, -5,-10,  0,  0,-10, -5,  5,
      0,  0,  0, 25, 25,  0,  0,  0,
      5,  5, 10, 27, 27, 10,  5,  5,
     10, 10, 20, 30, 30, 20, 10, 10,
     50, 50, 50, 50, 50, 50, 50, 50,
      0,  0,  0,  0,  0,  0,  0,  0,
  ],
  N: [
    -50,-40,-30,-30,-30,-30,-40,-50,
    -40,-20,  0,  5,  5,  0,-20,-40,
    -30,  5, 10, 15, 15, 10,  5,-30,
    -30,  0, 15, 20, 20, 15,  0,-30,
    -30,  5, 15, 20, 20, 15,  5,-30,
    -30,  0, 10, 15, 15, 10,  0,-30,
    -40,-20,  0,  0,  0,  0,-20,-40,
    -50,-40,-30,-30,-30,-30,-40,-50,
  ],
  B: [
    -20,-10,-10,-10,-10,-10,-10,-20,
    -10,  5,  0,  0,  0,  0,  5,-10,
    -10, 10, 10, 10, 10, 10, 10,-10,
    -10,  0, 10, 10, 10, 10,  0,-10,
    -10,  5,  5, 10, 10,  5,  5,-10,
    -10,  0,  5, 10, 10,  5,  0,-10,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -20,-10,-10,-10,-10,-10,-10,-20,
  ],
  R: [
      0,  0,  0,  5,  5,  0,  0,  0,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
      5, 10, 10, 10, 10, 10, 10,  5,
      0,  0,  0,  0,  0,  0,  0,  0,
  ],
  Q: [
    -20,-10,-10, -5, -5,-10,-10,-20,
    -10,  0,  5,  0,  0,  0,  0,-10,
    -10,  5,  5,  5,  5,  5,  0,-10,
      0,  0,  5,  5,  5,  5,  0, -5,
     -5,  0,  5,  5,  5,  5,  0, -5,
    -10,  0,  5,  5,  5,  5,  0,-10,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -20,-10,-10, -5, -5,-10,-10,-20,
  ],
  K: [
     20, 30, 10,  0,  0, 10, 30, 20,
     20, 20,  0,  0,  0,  0, 20, 20,
    -10,-20,-20,-20,-20,-20,-20,-10,
    -20,-30,-30,-40,-40,-30,-30,-20,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
  ],
  K_END: [
    -50,-30,-30,-30,-30,-30,-30,-50,
    -30,-30,  0,  0,  0,  0,-30,-30,
    -30,-10, 20, 30, 30, 20,-10,-30,
    -30,-10, 30, 40, 40, 30,-10,-30,
    -30,-10, 30, 40, 40, 30,-10,-30,
    -30,-10, 20, 30, 30, 20,-10,-30,
    -30,-20,-10,  0,  0,-10,-20,-30,
    -50,-40,-30,-20,-20,-30,-40,-50,
  ],
};

/* Премия проходной пешки: индекс 0 — пешка вплотную к превращению. */
const PASSED_BONUS = [90, 50, 28, 14, 6, 0];
/* Вес атаки фигуры на клетки вокруг короля (миттельшпиль). */
const KING_ATTACK = { N: 16, B: 18, R: 32, Q: 60 };
const MOBILITY_WEIGHT = { N: 3, B: 3, R: 2, Q: 1 };
const MATE = 100000;
const MATE_BOUND = MATE - 1000;
const ABORT = {};

const mirrorSq = sq => ((7 - (sq >> 3)) << 3) + (sq & 7);
const pieceType = piece => (piece ? piece.toUpperCase() : '');

function pieceSquare(piece, sq, endgame) {
  const type = pieceType(piece);
  const table = type === 'K' && endgame ? PST.K_END : PST[type];
  return table[piece === piece.toUpperCase() ? sq : mirrorSq(sq)];
}

function bestSquareValue(piece) {
  const table = PST[pieceType(piece)];
  let best = -1000;
  for (let i = 0; i < 64; i++) if (table[i] > best) best = table[i];
  return best;
}
const BEST_SQUARE = { P: 50, N: 20, B: 10, R: 10, Q: 5, K: 0 };

/* ===================================================== атакуемые клетки === */
/* Одним проходом по доске заполняем карты атак обеих сторон:
   mapW/mapB — клетку атакует белая/чёрная сторона,
   byW/byB   — тип атакующей фигуры (для определения связей).
   Массивы направлений вынесены наружу — иначе на каждую оценку
   создаются сотни мелких массивов и оценка встаёт колом. */

const KNIGHT_MOVES = new Int8Array([1, 2, 2, 1, 2, -1, 1, -2, -1, -2, -2, -1, -2, 1, -1, 2]);
const KING_MOVES = new Int8Array([0, 1, 1, 1, 1, 0, 1, -1, 0, -1, -1, -1, -1, 0, -1, 1]);
const BISHOP_DIRS = new Int8Array([1, 1, 1, -1, -1, 1, -1, -1]);
const ROOK_DIRS = new Int8Array([0, 1, 1, 0, 0, -1, -1, 0]);
const QUEEN_DIRS = new Int8Array([0, 1, 1, 0, 0, -1, -1, 0, 1, 1, 1, -1, -1, 1, -1, -1]);

/* Типы фигур по кодам символов — без строковых сравнений в горячем коде.
   У чёрных фигур коды строчных букв, поэтому у короля их два. */
const CH_P = 80, CH_N = 78, CH_B = 66, CH_R = 82, CH_Q = 81, CH_K = 75, CH_KB = 107;

const attackMaps = {
  mapW: new Uint8Array(64), byW: new Uint8Array(64), mobW: new Int8Array(64),
  mapB: new Uint8Array(64), byB: new Uint8Array(64), mobB: new Int8Array(64),
};

function markSlides(board, sq, dirs, code, map, by, mob, white) {
  const file = sq & 7, rank = sq >> 3;
  let count = 0;
  for (let d = 0; d < dirs.length; d += 2) {
    const df = dirs[d], dr = dirs[d + 1];
    let nf = file + df, nr = rank + dr;
    while (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) {
      const to = nr * 8 + nf;
      map[to] = 1;
      by[to] = code;
      const target = board[to];
      /* своя фигура ходу не мешает (за ней может быть ещё ход),
         чужая — мешает, и её можно взять */
      if (target) {
        if ((target === target.toUpperCase()) !== white) count++;
        break;
      }
      count++;
      nf += df; nr += dr;
    }
  }
  mob[sq] = count;
}

function markSteps(board, sq, steps, code, map, by, mob, white) {
  const file = sq & 7, rank = sq >> 3;
  let count = 0;
  for (let d = 0; d < steps.length; d += 2) {
    const nf = file + steps[d], nr = rank + steps[d + 1];
    if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
    const to = nr * 8 + nf;
    map[to] = 1;
    by[to] = code;
    const target = board[to];
    if (!target) count++;
    else if ((target === target.toUpperCase()) !== white) count++;
  }
  mob[sq] = count;
}

function buildAttackMaps(board) {
  const mapW = attackMaps.mapW, byW = attackMaps.byW, mobW = attackMaps.mobW;
  const mapB = attackMaps.mapB, byB = attackMaps.byB, mobB = attackMaps.mobB;
  mapW.fill(0); byW.fill(0); mobW.fill(0);
  mapB.fill(0); byB.fill(0); mobB.fill(0);

  for (let sq = 0; sq < 64; sq++) {
    const piece = board[sq];
    if (!piece) continue;
    const code = piece.charCodeAt(0);
    const white = code < 97;                    /* строчные буквы — чёрные */
    /* Нормализуем код к заглавной букве. Раньше сравнения шли только с
       CH_P/CH_N/CH_B/CH_R/CH_Q/CH_K, то есть только по белым фигурам:
       чёрные не попадали ни в одну ветку, карта атак чёрных оставалась
       пустой, и всё, что из неё берётся (подвижность, безопасность
       короля, «прибитость», висящие фигуры), работало на одну сторону. */
    const t = white ? code : code - 32;
    const map = white ? mapW : mapB;
    const by = white ? byW : byB;
    const mob = white ? mobW : mobB;

    if (t === CH_P) {
      const nr = (sq >> 3) + (white ? 1 : -1);
      if (nr >= 0 && nr < 7) {
        const file = sq & 7;
        if (file > 0) { map[nr * 8 + file - 1] = 1; by[nr * 8 + file - 1] = code; }
        if (file < 7) { map[nr * 8 + file + 1] = 1; by[nr * 8 + file + 1] = code; }
      }
    } else if (t === CH_N) {
      markSteps(board, sq, KNIGHT_MOVES, code, map, by, mob, white);
    } else if (t === CH_K) {
      markSteps(board, sq, KING_MOVES, code, map, by, mob, white);
    } else if (t === CH_B) {
      markSlides(board, sq, BISHOP_DIRS, code, map, by, mob, white);
    } else if (t === CH_R) {
      markSlides(board, sq, ROOK_DIRS, code, map, by, mob, white);
    } else if (t === CH_Q) {
      markSlides(board, sq, QUEEN_DIRS, code, map, by, mob, white);
    }
  }
  return attackMaps;
}

/* Подвижность одной фигуры (направления вынесены наружу). */
function pieceMobility(board, sq, type) {
  const piece = board[sq];
  const white = piece === piece.toUpperCase();
  const file = sq & 7, rank = sq >> 3;
  let total = 0;

  if (type === 'N' || type === 'K') {
    const steps = type === 'N' ? KNIGHT_MOVES : KING_MOVES;
    for (let d = 0; d < steps.length; d += 2) {
      const nf = file + steps[d], nr = rank + steps[d + 1];
      if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
      const target = board[nr * 8 + nf];
      total += (!target || (target === target.toUpperCase()) !== white) ? 1 : 0;
    }
    return total;
  }
  const dirs = type === 'B' ? BISHOP_DIRS : type === 'R' ? ROOK_DIRS : QUEEN_DIRS;
  for (let d = 0; d < dirs.length; d += 2) {
    const df = dirs[d], dr = dirs[d + 1];
    let nf = file + df, nr = rank + dr;
    while (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) {
      const target = board[nr * 8 + nf];
      if (!target) { total++; }
      else { total += (target === target.toUpperCase()) !== white ? 1 : 0; break; }
      nf += df; nr += dr;
    }
  }
  return total;
}

/* Зона короля: клетки вокруг него и две вперёд. */
const kingZone = [];
for (let sq = 0; sq < 64; sq++) {
  const zone = [];
  const file = sq & 7, rank = sq >> 3;
  for (let df = -1; df <= 1; df++) {
    for (let dr = -1; dr <= 2; dr++) {
      const nf = file + df, nr = rank + dr;
      if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
      zone.push(nr * 8 + nf);
    }
  }
  kingZone.push(zone);
}

/* Пешечный щит вокруг короля. */
function shieldBonus(board, kingSq, white) {
  const dir = white ? 1 : -1;
  const file = kingSq & 7, rank = kingSq >> 3;
  let bonus = 0;
  for (let df = -1; df <= 1; df++) {
    const nf = file + df;
    if (nf < 0 || nf > 7) continue;
    for (const ahead of [1, 2]) {
      const nr = rank + dir * ahead;
      if (nr < 0 || nr > 7) continue;
      const piece = board[nr * 8 + nf];
      if (piece && piece.toUpperCase() === 'P' && (piece === piece.toUpperCase()) === white) {
        bonus += ahead === 1 ? 11 : 5;
      }
    }
  }
  return Math.min(bonus, 32);
}

/* Кто и как может атаковать каждую клетку. Считается один раз при загрузке,
   потом используется и в оценке (висящие фигуры), и в SEE.

   RAYS[sq] — 8 направлений, в каждом [коды типов, df, dr]. Важно хранить
   именно направления, а не по записи на каждую клетку луча: иначе обход не
   останавливается на первом блокере и SEE втрое дороже поиска.
   STEPW/STEPB — пешки, кони, короли отдельно для каждого цвета,
                потому что у пешек направление зависит от стороны. */
const RAYS = [];
const STEPW = [];
const STEPB = [];

(function buildAttackTables() {
  const KNIGHT_STEPS = [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]];
  const KING_STEPS = [[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]];
  const DIRS = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];

  for (let sq = 0; sq < 64; sq++) {
    const rays = new Array(8);
    for (let d = 0; d < 8; d++) {
      const df = DIRS[d][0], dr = DIRS[d][1];
      /* по диагонали бьёт слон (и ферзь), по прямой — ладья (и ферзь) */
      rays[d] = df !== 0 && dr !== 0 ? [CH_B, CH_Q, df, dr] : [CH_R, CH_Q, df, dr];
    }
    RAYS.push(rays);

    const mk = pawnSteps => {
      const list = [];
      for (const [df, dr] of KNIGHT_STEPS) list.push(CH_N, df, dr);
      for (const [df, dr] of KING_STEPS) list.push(CH_K, df, dr);
      for (const [df, dr] of pawnSteps) list.push(CH_P, df, dr);
      return list;
    };
    /* белая пешка бьёт sq, стоя на sq+(±1,+1), чёрная — на sq+(±1,-1) */
    STEPW.push(mk([[1, 1], [-1, 1]]));
    STEPB.push(mk([[1, -1], [-1, -1]]));
  }
})();

/* Самая дешёвая фигура byWhite, бьющая клетку sq (королём не считаем:
   король не «разменивается», он просто защищает или уходит).
   Возвращает и квадрат — он нужен SEE, чтобы снять фигуру с доски. */
function cheapestAttacker(board, sq, byWhite) {
  let bestValue = 10000;
  let bestCode = 0;
  let bestSq = -1;

  const rays = RAYS[sq];
  const file0 = sq & 7, rank0 = sq >> 3;
  for (let d = 0; d < 8; d++) {
    const ray = rays[d];
    const codeA = ray[0], codeB = ray[1], df = ray[2], dr = ray[3];
    let nf = file0 + df, nr = rank0 + dr;
    while (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) {
      const piece = board[nr * 8 + nf];
      if (!piece) { nf += df; nr += dr; continue; }
      if ((piece === piece.toUpperCase()) === byWhite) {
        const raw = piece.charCodeAt(0);
        /* сверяем именно ТИП: конь с поля коня бьёт так же, как и ферзь,
           и без проверки типа ферзь принимался за коня */
        const norm = byWhite ? raw : raw - 32;
        if (norm === codeA || norm === codeB) {
          const v = VALUES[piece.toUpperCase()];
          if (v < bestValue) { bestValue = v; bestCode = raw; bestSq = nr * 8 + nf; }
        }
      }
      break;                                     /* дальше луча не видно */
    }
  }

  const steps = byWhite ? STEPW[sq] : STEPB[sq];
  for (let i = 0; i < steps.length; i += 3) {
    const code = steps[i];
    if (code === CH_K) continue;                 /* короля пропускаем */
    const nf = file0 + steps[i + 1], nr = rank0 + steps[i + 2];
    if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
    const piece = board[nr * 8 + nf];
    if (!piece || (piece === piece.toUpperCase()) !== byWhite) continue;
    const raw = piece.charCodeAt(0);
    if ((byWhite ? raw : raw - 32) !== code) continue;
    const v = VALUES[piece.toUpperCase()];
    if (v < bestValue) { bestValue = v; bestCode = raw; bestSq = nr * 8 + nf; }
  }

  return bestSq >= 0
    ? { value: bestValue, code: bestCode, sq: bestSq, which: board[bestSq] }
    : null;
}

/* Насколько сторона потеряет фигуру на sq, если соперник её возьмёт.
   Берут самой дешёвой, отвечаем самой дешёвой своей.
   Раньше за висящую фигуру давалось атакующему 14% стоимости, и позиция
   с ферзём под боем оценивалась почти как ничья. */
function hangingLoss(board, sq, white, value) {
  const atk = cheapestAttacker(board, sq, !white);
  if (!atk) return 0;

  let reply = 0;
  const own = cheapestAttacker(board, sq, white);
  if (own && own.value - atk.value > 0) reply = own.value - atk.value;
  /* берут пешкой, а забрать нечем — такая потеря почти невыносима */
  if (atk.code === CH_P && reply === 0) reply = Math.round(value * 0.12);

  const loss = value - reply;
  return loss > 0 ? loss : 0;
}

/* ============================================================ оценка ======= */

const evalState = {
  filesW: new Int8Array(8),
  filesB: new Int8Array(8),
  pawnsW: [],
  pawnsB: [],
  /* разбивка последней оценки — для диагностики в тестах */
  debug: null,
};

function evaluate(state) {
  const pos = state.pos;
  const board = pos.board;
  const white = pos.turn === 'w';

  /* карты атак строим первыми: из них сразу берём подвижность фигур */
  const maps = buildAttackMaps(board);
  const mapW = maps.mapW, mapB = maps.mapB;
  const mobW = maps.mobW, mobB = maps.mobB;

  let material = 0;
  let whiteScore = 0;
  let blackScore = 0;
  let bishopsW = 0, bishopsB = 0;
  let kingsW = -1, kingsB = -1;
  let swapPotentialW = 0, swapPotentialB = 0;

  evalState.filesW.fill(0);
  evalState.filesB.fill(0);
  evalState.pawnsW.length = 0;
  evalState.pawnsB.length = 0;

  /* один проход: материал, позиция на доске, подвижность, угрозы */
  for (let sq = 0; sq < 64; sq++) {
    const piece = board[sq];
    if (!piece) continue;
    const code = piece.charCodeAt(0);
    const isWhite = code < 97;
    const t = isWhite ? code : code - 32;
    const type = pieceType(piece);

    if (t === CH_K) { if (isWhite) kingsW = sq; else kingsB = sq; continue; }

    const value = VALUES[type];
    material += value;
    const psq = pieceSquare(piece, sq, false);
    const base = value + psq;
    if (isWhite) whiteScore += base; else blackScore += base;

    /* подвижность; фигура, «прибитая» к королю, её не получает */
    const weight = MOBILITY_WEIGHT[type];
    if (weight) {
      const pinned = isWhite ? mapB[sq] : mapW[sq];
      const mobile = pinned ? 0 : (isWhite ? mobW[sq] : mobB[sq]);
      if (isWhite) whiteScore += mobile * weight; else blackScore += mobile * weight;
      /* Висящая фигура: настоящая потеря, а не 14% от стоимости.
         Проверяем карту атак (дёшево), а точный пересчёт — только если
         по фигуре действительно бьют. */
      if (type !== 'P' && (isWhite ? maps.mapB[sq] : maps.mapW[sq])) {
        const loss = hangingLoss(board, sq, isWhite, value);
        if (loss > 0) {
          if (isWhite) whiteScore -= loss; else blackScore -= loss;
        }
      }
    }

    if (t === CH_P) {
      (isWhite ? evalState.pawnsW : evalState.pawnsB).push(sq);
      (isWhite ? evalState.filesW : evalState.filesB)[sq & 7]++;
    } else if (t === CH_B) { if (isWhite) bishopsW++; else bishopsB++; }

    /* потенциал телекинеза: насколько выгодно «телепортировать» фигуру */
    const gain = BEST_SQUARE[type] - (psq > 0 ? psq : 0);
    if (gain > 0) {
      if (isWhite) { if (gain > swapPotentialW) swapPotentialW = gain; }
      else if (gain > swapPotentialB) swapPotentialB = gain;
    }
  }

  const endgame = material < 2400;
  if (endgame) {
    /* в эндшпиле короли идут вперёд */
    if (kingsW >= 0) whiteScore += PST.K_END[kingsW];
    if (kingsB >= 0) blackScore += PST.K_END[mirrorSq(kingsB)];
  }

  /* пара слонов */
  if (bishopsW >= 2) whiteScore += 32;
  if (bishopsB >= 2) blackScore += 32;

  /* безопасность королей */
  if (!endgame) {
    if (kingsW >= 0) {
      let attack = 0;
      for (const sq of kingZone[kingsW]) {
        if (!mapB.map[sq]) continue;
        attack += KING_ATTACK[pieceType(board[sq])] || 6;
      }
      whiteScore -= Math.min(attack, 120) + shieldBonus(board, kingsW, true);
    }
    if (kingsB >= 0) {
      let attack = 0;
      for (const sq of kingZone[kingsB]) {
        if (!mapW.map[sq]) continue;
        attack += KING_ATTACK[pieceType(board[sq])] || 6;
      }
      blackScore -= Math.min(attack, 120) + shieldBonus(board, kingsB, false);
    }
  }

  /* пешки: сдвоенные, изолированные, проходные */
  for (const color of ['w', 'b']) {
    const mine = color === 'w' ? evalState.filesW : evalState.filesB;
    const squares = color === 'w' ? evalState.pawnsW : evalState.pawnsB;
    let delta = 0;
    for (let file = 0; file < 8; file++) if (mine[file] > 1) delta -= 15 * (mine[file] - 1);
    for (const sq of squares) {
      const file = sq & 7, rank = sq >> 3;
      const left = file > 0 ? mine[file - 1] : 0;
      const right = file < 7 ? mine[file + 1] : 0;
      if (left === 0 && right === 0) delta -= 17;
      let passed = true;
      for (let f = Math.max(0, file - 1); f <= Math.min(7, file + 1) && passed; f++) {
        for (const esq of (color === 'w' ? evalState.pawnsB : evalState.pawnsW)) {
          if ((esq & 7) !== f) continue;
          const erank = esq >> 3;
          if (color === 'w' ? erank > rank : erank < rank) { passed = false; break; }
        }
      }
      if (passed) {
        const steps = color === 'w' ? 6 - rank : rank - 1;
        delta += PASSED_BONUS[Math.max(0, Math.min(5, steps))];
        /* ладья за проходной пешкой */
        for (let r = 0; r < 8; r++) {
          const sq2 = r * 8 + file;
          const occupant = board[sq2];
          if (!occupant || occupant.toUpperCase() !== 'R') continue;
          const behind = color === 'w' ? r > rank : r < rank;
          if (behind) { if (color === 'w') whiteScore += 12; else blackScore += 12; }
        }
      }
    }
    if (color === 'w') whiteScore += delta; else blackScore += delta;
  }

  /* ладьи: открытая и полуоткрытая линия, 7-я горизонталь */
  for (let sq = 0; sq < 64; sq++) {
    const piece = board[sq];
    if (!piece || pieceType(piece) !== 'R') continue;
    const isWhite = piece === piece.toUpperCase();
    const file = sq & 7, rank = sq >> 3;
    const mine = isWhite ? evalState.filesW : evalState.filesB;
    const theirs = isWhite ? evalState.filesB : evalState.filesW;
    let bonus = 0;
    if (mine[file] === 0 && theirs[file] === 0) bonus += 24;
    else if (theirs[file] === 0) bonus += 11;
    if (rank === (isWhite ? 6 : 1)) bonus += 20;
    if (isWhite) whiteScore += bonus; else blackScore += bonus;
  }

  /* телекинез: незапасённый заряд + выгода от возможного обмена */
  whiteScore += state.charges.w * 12 + (state.charges.w ? Math.min(40, swapPotentialW * 0.6) : 0);
  blackScore += state.charges.b * 12 + (state.charges.b ? Math.min(40, swapPotentialB * 0.6) : 0);

  /* темп */
  whiteScore += white ? 10 : -10;

  const total = whiteScore - blackScore;
  evalState.debug = { whiteScore, blackScore, material, endgame, kingsW, kingsB };
  return white ? total : -total;
}

/* ======================================================== дебютная база ==== */
/* Небольшой набор популярных начал: индекс — позиция, значение — приоритетный
   ход и SAN. Бот играет из базы, пока позиция в ней встречается. */

const OPENING_LINES = [
  ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6'],                       /* Испанский */
  ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5'],                      /* Итальянский */
  ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6'],                      /* Конь и слон */
  ['e4', 'e5', 'Nf3', 'Nc6', 'd4', 'exd4'],                      /* Шотландский */
  ['e4', 'e5', 'Nf3', 'Nc6', 'd4', 'd5'],                       /* Scotch/центр */
  ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6'], /* Сицилианская */
  ['e4', 'c5', 'Nf3', 'Nc6', 'Bb5', 'g6'],                       /* Рози */
  ['e4', 'c5', 'Nf3', 'e7', 'd4', 'cxd4'],                      /* Анти-Сицилианская */
  ['e4', 'd5', 'exd5', 'Qxd5', 'Nc3', 'Qa5'],                    /* Скандинавский */
  ['e4', 'Nf6', 'e5', 'Nd5', 'd4', 'd6', 'Nf3'],                 /* Петров */
  ['e4', 'e6', 'd4', 'd5', 'Nc3'],                               /* Французский */
  ['e4', 'e6', 'd4', 'd5', 'e5'],                               /* Французский, вперёд */
  ['e4', 'c6', 'd4', 'd5', 'Nc3'],                               /* Каро-Канн */
  ['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6'],                        /* Ферзь-пешка */
  ['d4', 'd5', 'c4', 'dxc4', 'e3', 'e5'],                       /* защита Славы */
  ['d4', 'd5', 'c4', 'c6', 'Nf3'],                               /* Славянская */
  ['d4', 'Nf6', 'c4', 'e6', 'Nf3', 'd5', 'Nc3', 'Be7'],          /* Нимцо-индийский */
  ['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'd5'],                        /* Королевский индийский */
  ['d4', 'Nf6', 'c4', 'g6', 'e4', 'd5'],                         /* Кремер */
  ['d4', 'f5', 'g3', 'Nf6', 'Bg2'],                             /* Барцингольц */
  ['c4', 'e5', 'Nc3', 'Nc6'],                                    /* Английская */
  ['d4', 'd5', 'Nf3', 'Nf6', 'e3'],                              /* Мерный */
  ['d4', 'Nf6', 'c4', 'g6', 'Nf3', 'Bg7'],                       /* Алехин (Nf3) */
  ['d4', 'd5', 'Bf4'],                                           /* 1. d4 2. Bf4 */
  ['Nf3', 'd5', 'c4', 'e6', 'Nc3'],                              /* Рети */
];

/* Небольшой генератор случайных чисел: база и выбор из близких ходов
   должны повторяться по зерну, иначе замеры силы нельзя сравнивать. */
function makeRandom(seed) {
  let s = (seed >>> 0) || 0x2f6e2b1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

let openingBook = null;
let randomFor = makeRandom(1);
let randomSeed = 1;

/* Книга хранит несколько вариантов на позицию: так партии не начинаются
   одинаково и сопернику не выучить один ответ. */
function buildOpeningBook() {
  if (openingBook) return openingBook;
  const book = new Map();
  const add = (state, san, weight) => {
    const key = Chess.posKey(state);
    let list = book.get(key);
    if (!list) { list = []; book.set(key, list); }
    list.push({ san, weight });
  };
  for (const line of OPENING_LINES) {
    const game = new Chess.Game();
    add(game.state, line[0], 10);
    for (let i = 0; i < line.length; i++) {
      const san = line[i];
      const moves = Chess.legalMoves(game.state);
      const move = moves.find(m => Chess.toSan(game.state, m, Chess.applyMove(game.state, m)) === san);
      if (!move) break;
      game.play(move);
      /* вариант тем весом больше, чем позже он появляется в списке:
         база хранит варианты в порядке предпочтения */
      if (i + 1 < line.length) add(game.state, line[i + 1], 10 - i);
    }
  }
  openingBook = book;
  return book;
}

function bookMove(state) {
  const book = buildOpeningBook();
  const list = book.get(Chess.posKey(state));
  if (!list || !list.length) return null;
  if (list.length === 1) return list[0].san;
  const total = list.reduce((sum, item) => sum + item.weight, 0);
  let pick = randomFor() * total;
  for (const item of list) {
    pick -= item.weight;
    if (pick <= 0) return item.san;
  }
  return list[0].san;
}

/* ============================================== статическая оценка разменов = */

/* SEE: сколько принесёт взятие, если соперник ответит лучшим образом.
   Считаем на черновике доски. Черновик один на весь движок и каждый раз
   заполняется заново: отдельная копия массива на каждое взятие давала
   заметную просадку скорости поиска. */
const seeBoard = new Array(64);

function seeCapture(board, from, to) {
  const piece = board[from];
  if (!piece) return 0;
  const target = board[to];
  if (!target) return 0;

  const b = seeBoard;
  for (let i = 0; i < 64; i++) b[i] = board[i];
  b[from] = null;

  const value = p => (p ? VALUES[pieceType(p)] : 0);
  const gain = [value(target)];
  const taken = [piece];
  b[to] = piece;                     /* наша фигура встаёт на to */

  let sideIsWhite = piece === piece.toUpperCase();
  let d = 1;
  for (; d < 16; d++) {
    const atk = cheapestAttacker(b, to, !sideIsWhite);
    if (!atk) break;
    gain[d] = value(taken[d - 1]) - atk.value;
    if (gain[d] < 0) break;          /* дальше раунд не имеет смысла */
    b[atk.sq] = null;
    b[to] = atk.which;
    taken[d] = atk.which;
    sideIsWhite = !sideIsWhite;
  }

  while (--d > 0) gain[d - 1] = -gain[d];
  return gain[0];
}

/* ====================================================== упорядочивание ==== */

const moveKey = move => move.from * 64 + move.to;

function scoreMove(move, ttMove, killers, history, board) {
  if (ttMove && move.from === ttMove.from && move.to === ttMove.to && move.promo === ttMove.promo) return 5000000;
  /* обмены сортируем по эвристике движка, а не единым весом: их бывает
     до 32 штук на узел, и порядок здесь реально влияет на скорость */
  if (move.swap) return 900000 + (move.swapWeight || 0);
  if (move.promo) return 800000 + (VALUES[move.promo.toUpperCase()] || 0);
  if (move.captured) {
    /* SEE вместо MVV/LVA: MVV/LVA считает выигрыш по номиналу и в первую
       очередь пробует отдачные взятия, на которые потом тратятся узлы */
    const see = seeCapture(board, move.from, move.to);
    return 700000 + see * 8 + VALUES[pieceType(move.captured)] * 4 -
      VALUES[pieceType(move.piece)];
  }
  if (killers && killers[0] === moveKey(move)) return 600000;
  if (killers && killers[1] === moveKey(move)) return 590000;
  return (history && history.get(moveKey(move))) || 0;
}

function orderMoves(moves, ttMove, ctx, ply, board) {
  const killers = ctx.killers[ply] || null;
  const scored = new Array(moves.length);
  for (let i = 0; i < moves.length; i++) {
    scored[i] = { move: moves[i], s: scoreMove(moves[i], ttMove, killers, ctx.history, board) };
  }
  scored.sort((a, b) => b.s - a.s);
  const out = new Array(moves.length);
  for (let i = 0; i < moves.length; i++) out[i] = scored[i].move;
  return out;
}

/* ================================================== форсированный поиск === */

function quiesce(state, alpha, beta, ply, ctx, canSwap, qply) {
  ctx.nodes++;
  if ((ctx.nodes & 1023) === 0 && Date.now() > ctx.deadline) throw ABORT;

  const inCheck = Chess.isInCheck(state.pos, state.pos.turn);
  let stand = -Infinity;
  if (!inCheck) {
    stand = evaluate(state);
    if (stand >= beta) return stand;
    if (stand > alpha) alpha = stand;
  }

  let moves;
  if (inCheck) {
    moves = Chess.legalMoves(state, { allowSwaps: false });
  } else {
    moves = Chess.legalMoves(state, {
      capturesOnly: true,
      allowSwaps: !!canSwap,
      maxSwaps: canSwap ? ctx.quiesceSwaps : 0,
    });
  }

  let replies = 0;
  const board = state.pos.board;
  const ordered = orderMoves(moves, null, ctx, ply, board);
  for (let i = 0; i < ordered.length; i++) {
    const move = ordered[i];
    /* Отсечение по разнице: берём только то, что в принципе может
       дотянуть до alpha. Раньше здесь перебирались все взятия подряд,
       включая заведомо отдачные. */
    if (!inCheck && move.captured && !move.swap && !move.promo) {
      const gain = seeCapture(board, move.from, move.to);
      if (gain <= 0) continue;
      if (stand + gain + 200 < alpha) continue;
    }
    const next = Chess.applyMove(state, move);
    if (!next) continue;
    replies++;
    const key = Chess.posKey(next);
    if (ctx.path.has(key)) continue;
    ctx.path.add(key);
    const score = -quiesce(next, -beta, -alpha, ply + 1, ctx, canSwap && !move.swap, qply + 1);
    ctx.path.delete(key);
    if (score >= beta) return score;
    if (score > alpha) alpha = score;
  }
  if (inCheck && replies === 0) return -MATE + ply;
  return alpha;
}

/* ============================================================= поиск ===== */

function negamax(state, depth, alpha, beta, ply, ctx, canSwap, isPv) {
  ctx.nodes++;
  if ((ctx.nodes & 1023) === 0 && Date.now() > ctx.deadline) throw ABORT;
  if (ply > ctx.seldepth) ctx.seldepth = ply;

  /* повторения отсекает вызывающий (он проверяет ключ до добавления в путь) */
  if (state.pos.half >= 100 || Chess.insufficientMaterial(state.pos.board)) return 0;
  if (ply >= 64) return evaluate(state);               /* страховка от бесконечной глубины */

  const inCheck = Chess.isInCheck(state.pos, state.pos.turn);
  /* продление только при положительной глубине, иначе форсированный поиск
     никогда не наступит и дерево разрастётся */
  if (inCheck && depth > 0) depth++;

  if (depth <= 0) return quiesce(state, alpha, beta, ply, ctx, canSwap, 0);

  const key = Chess.posKey(state);
  const alphaOrig = alpha;
  const entry = ctx.tt.get(key);
  let ttMove = null;
  if (entry) {
    ttMove = entry.move;
    if (entry.depth >= depth && !isPv) {
      if (entry.flag === 'exact') return entry.score;
      if (entry.flag === 'lower' && entry.score > alpha) alpha = entry.score;
      else if (entry.flag === 'upper' && entry.score < beta) beta = entry.score;
      if (alpha >= beta) return entry.score;
    }
  }

  /* Обмены перебираем только в верхних слоях. На каждой глубине их бывает до
   ctx.maxSwaps штук, и раньше они размножали дерево: бюджет уходил на
   варианты телекинеза вместо шахматной тактики. В глубине их учитывает
   оценка (заряды и потенциал обмена). */
const swapsHere = canSwap !== false && ply <= ctx.swapDepth;
  const moves = Chess.legalMoves(state, {
    allowSwaps: swapsHere,
    maxSwaps: swapsHere ? ctx.maxSwaps : 0,
  });

  /* null-move: пропуск хода соперника — плохой, значит позиция перспективна */
  if (!isPv && !inCheck && depth >= 3 && ctx.allowNull && ctx.heavyMaterial) {
    const reduction = depth > 6 ? 3 : 2;
    ctx.path.add('nm:' + key);
    const score = -negamax(state, depth - 1 - reduction, -beta, -beta + 1, ply + 1, ctx, canSwap, false);
    ctx.path.delete('nm:' + key);
    if (score >= beta) return score > MATE_BOUND ? beta : score;
  }

  let best = -Infinity;
  let bestMove = null;
  let legal = 0;
  const board = state.pos.board;
  const ordered = orderMoves(moves, ttMove, ctx, ply, board);

  for (let i = 0; i < ordered.length; i++) {
    const move = ordered[i];
    const next = Chess.applyMove(state, move);
    if (!next) continue;
    legal++;
    const nextKey = Chess.posKey(next);
    if (ctx.path.has(nextKey)) continue;

    const givesCheck = Chess.isInCheck(next.pos, next.pos.turn);
    const isQuiet = !move.captured && !move.promo && !givesCheck && !move.swap;

    /* futility: при низкой глубине и плохом счёте тихий ход не нужен */
    if (!isPv && !inCheck && depth <= 2 && isQuiet && legal > 1) {
      const stand = evaluate(state);
      if (stand + 120 * depth < alpha) continue;
    }

    ctx.path.add(nextKey);
    let score;
    try {
      /* позднее сокращение тихих ходов */
      let newDepth = depth - 1;
      if (isQuiet && depth >= 3 && legal > 3 && !inCheck && !isPv) {
        newDepth -= legal > 8 ? 2 : 1;
        if (newDepth < 1) newDepth = 1;
      }
      if (legal === 1) {
        score = -negamax(next, newDepth, -beta, -alpha, ply + 1, ctx, canSwap && !move.swap, isPv);
      } else {
        /* PVS: первый ход — полное окно, остальные — узкое с пересчётом */
        score = -negamax(next, newDepth, -alpha - 1, -alpha, ply + 1, ctx, canSwap && !move.swap, false);
        if (score > alpha && score < beta) {
          score = -negamax(next, newDepth, -beta, -alpha, ply + 1, ctx, canSwap && !move.swap, isPv);
        }
      }
      /* пересчёт после сокращения глубины */
      if (score > alpha && newDepth < depth - 1) {
        score = -negamax(next, depth - 1, -beta, -alpha, ply + 1, ctx, canSwap && !move.swap, isPv);
      }
    } catch (error) {
      ctx.path.delete(nextKey);
      if (error === ABORT) throw ABORT;
      throw error;
    }
    ctx.path.delete(nextKey);

    if (score > best) { best = score; bestMove = move; }
    if (score > alpha) {
      alpha = score;
      if (alpha >= beta) {
        if (isQuiet) {
          const list = ctx.killers[ply] || (ctx.killers[ply] = []);
          if (list[0] !== moveKey(move)) { list[1] = list[0]; list[0] = moveKey(move); }
          ctx.history.set(moveKey(move), (ctx.history.get(moveKey(move)) || 0) + depth * depth);
        }
        break;
      }
    }
  }

  if (legal === 0) return inCheck ? -MATE + ply : 0;

  if (ctx.tt.size > 200000) ctx.tt.clear();
  const stored = Math.abs(best) > MATE_BOUND ? best + ply : best;
  ctx.tt.set(key, {
    depth, score: stored, move: bestMove,
    flag: best <= alphaOrig ? 'upper' : best >= beta ? 'lower' : 'exact',
  });
  return best;
}

/* ============================================================ уровни ====== */

const LEVELS = {
  easy:   { depth: 2, timeMs: 450,  tolerance: 160, maxSwaps: 16, noise: 26, swapDepth: 1 },
  medium: { depth: 8, timeMs: 1300, tolerance: 12,  maxSwaps: 20, noise: 8,  swapDepth: 2 },
  hard:   { depth: 14, timeMs: 4500, tolerance: 0,  maxSwaps: 24, noise: 0,  swapDepth: 2 },
};

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function makeContext(cfg) {
  return {
    nodes: 0,
    seldepth: 0,
    deadline: Date.now() + cfg.timeMs,
    tt: new Map(),
    killers: [],
    history: new Map(),
    maxSwaps: cfg.maxSwaps,
    /* обмены перебираем только у корня и ближайших слоёв */
    swapDepth: cfg.swapDepth === undefined ? 2 : cfg.swapDepth,
    /* в форсированном поиске обмены не нужны: там проверяются взятия,
       а обмен по отношению к материалу — тихий ход */
    quiesceSwaps: 0,
    path: new Set(),
    allowNull: true,
    heavyMaterial: true,
  };
}

function heavyEnough(state) {
  let material = 0;
  for (const piece of state.pos.board) if (piece && piece.toUpperCase() !== 'K') material += VALUES[piece.toUpperCase()];
  return material >= 2200;
}

/* Главный вход: возвращает { move, score, depth, nodes } */
async function findBestMove(state, options = {}) {
  const cfg = Object.assign({}, LEVELS[options.level || 'medium'], options);

  /* зерно: без него замеры силы неповторяемы из-за случайного выбора */
  if (options.seed !== undefined && options.seed !== randomSeed) {
    randomSeed = options.seed;
    randomFor = makeRandom(options.seed);
  }

  /* 1) дебютная база.
        Книжный ход берём, только если он не подставляет фигуру и не
        отдаёт материал: раньше база игралась вслепую. */
  if (options.useBook !== false) {
    const san = bookMove(state);
    if (san) {
      const move = Chess.legalMoves(state).find(m =>
        Chess.toSan(state, m, Chess.applyMove(state, m)) === san);
      if (move) {
        const sane = !move.captured ||
          seeCapture(state.pos.board, move.from, move.to) >= 0;
        if (sane) return { move, score: 0, depth: 0, nodes: 0, book: true };
      }
    }
  }

  /* 2) «живость» лёгкого уровня.
       Раньше бот просто шёл случайным ходом в 28% случаев — это выглядело
       как отключённый противник. Теперь он играет осмысленно, но иногда
       берёт второй из близких вариантов: ошибки остаются, но выглядят
       как человеческие, а не как отказ от игры. */
  const jitter = cfg.noise || 0;

  const rootMoves = Chess.legalMoves(state, { maxSwaps: cfg.maxSwaps });
  if (rootMoves.length === 0) return null;
  if (rootMoves.length === 1) return { move: rootMoves[0], score: 0, depth: 1, nodes: 0 };

  const ctx = makeContext(cfg);
  ctx.heavyMaterial = heavyEnough(state);

  let best = rootMoves[0];
  let bestScore = 0;
  let scored = [];
  let reached = 0;

  for (let depth = 1; depth <= cfg.depth; depth++) {
    ctx.killers = [];
    ctx.path = new Set();
    let alpha = -MATE - 1;
    let iterBest = null;
    let iterScore = -Infinity;
    let complete = true;
    const current = [];
    const ordered = orderMoves(rootMoves, best, ctx, 0, state.pos.board);

    for (let i = 0; i < ordered.length; i++) {
      const move = ordered[i];
      const next = Chess.applyMove(state, move);
      if (!next) continue;
      const nextKey = Chess.posKey(next);
      ctx.path.add(nextKey);

      let score;
      try {
        /* PVS: первый ход — полное окно, остальные — узкое; при улучшении
           обязательно пересчитываем в полном окне, иначе получим границу,
           а не истинную оценку хода (так был сломан старый вариант) */
        if (i === 0) {
          score = -negamax(next, depth - 1, -MATE - 1, MATE + 1, 1, ctx, true, true);
        } else {
          score = -negamax(next, depth - 1, -MATE - 1, -alpha - 1, 1, ctx, true, false);
          if (score > alpha) {
            score = -negamax(next, depth - 1, -MATE - 1, MATE + 1, 1, ctx, true, true);
          }
        }
      } catch (error) {
        if (error !== ABORT) { ctx.path.delete(nextKey); throw error; }
        complete = false;
      }
      ctx.path.delete(nextKey);
      if (!complete) break;

      current.push({ move, score });
      if (score > iterScore) { iterScore = score; iterBest = move; }
      if (score > alpha) alpha = score;

      await tick();                                    /* отдаём поток интерфейсу */
      if (Date.now() >= ctx.deadline) { complete = false; break; }
    }

    if (complete && iterBest) {
      best = iterBest;
      bestScore = iterScore;
      scored = current;
      reached = depth;
      if (Math.abs(iterScore) > MATE_BOUND) break;      /* найден мат */
    }
    if (!complete || Date.now() >= ctx.deadline) break;
  }

  /* Среди близких ходов выбираем с шумом. Шум тем больше, чем меньше фигур
     на доске: в эндшпиле слабый бот обязан доигрывать осмысленно, иначе
     он «зависал» на ничьей из-за случайных зевков. */
  if (scored.length > 1 && (cfg.tolerance > 0 || jitter > 0)) {
    let pool = scored.filter(item => item.score >= bestScore - cfg.tolerance);
    if (jitter > 0) {
      const byMaterial = scored.filter(item => item.score >= bestScore - jitter * 2);
      if (byMaterial.length) pool = pool.length ? pool : byMaterial;
    }
    if (pool.length > 1) {
      /* чем меньше материал, тем ближе должны быть варианты */
      const piecesLeft = state.pos.board.reduce((n, p) => n + (p ? 1 : 0), 0);
      const slack = Math.max(6, Math.round(jitter * (piecesLeft / 14 + 0.35)));
      const close = pool.filter(item => item.score >= bestScore - slack);
      const finalPool = close.length ? close : pool;
      const pick = finalPool[Math.floor(randomFor() * finalPool.length)];
      best = pick.move;
      bestScore = pick.score;
    }
  }

  return { move: best, score: bestScore, depth: reached, nodes: ctx.nodes, seldepth: ctx.seldepth };
}

/* Синхронный помощник для тестов (полное окно на каждом корневом ходе) */
function quick(state, level = 'easy', options = {}) {
  const cfg = Object.assign({}, LEVELS[level], options);
  const ctx = makeContext(cfg);
  ctx.heavyMaterial = heavyEnough(state);
  const moves = Chess.legalMoves(state, { maxSwaps: cfg.maxSwaps });
  let best = moves[0] || null;
  let bestScore = null;
  for (const move of moves) {
    const next = Chess.applyMove(state, move);
    if (!next) continue;
    let score;
    try {
      score = -negamax(next, cfg.depth - 1, -MATE - 1, MATE + 1, 1, ctx, true, true);
    } catch (error) {
      if (error !== ABORT) throw error;
      break;                          /* время вышло — берём лучшее из найденного */
    }
    if (bestScore === null || score > bestScore) { bestScore = score; best = move; }
  }
  return { move: best, score: bestScore === null ? 0 : bestScore, nodes: ctx.nodes };
}

const Bot = {
  VALUES, PST, LEVELS, OPENING_LINES,
  evaluate, findBestMove, quick,
  bookMove, buildOpeningBook,
  _negamax: negamax,
  _quiesce: quiesce,
  _attackMap: buildAttackMaps,
  _mobility: pieceMobility,
  _cheapestAttacker: cheapestAttacker,
  _debugEval: state => { evaluate(state); return evalState.debug; },
};

if (typeof window !== 'undefined') window.Bot = Bot;