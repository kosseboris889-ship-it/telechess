/* ============================================================================
   ТелеШахматы — pieces.js
   Собственный набор фигур: шесть типов, нарисованных вручную в системе
   координат 100 x 100. Все фигуры стоят на одинаковом основании-подставке и
   различаются силуэтом сверху, поэтому набор читается как единый и остаётся
   понятным даже в клетке 40 px на телефоне.

   Оформление: белые — светлые с синими деталями, чёрные — тёмно-синие
   с красными. Только inline-SVG: ни шрифтов, ни внешних файлов.
   ============================================================================ */
'use strict';

const Pieces = (function () {
  'use strict';

  /* Общее основание: подставка, на которой стоит любая фигура */
  const BASE = '<rect x="22" y="85" width="56" height="9" rx="4.5"/>';
  const ACCENT_BASE = '<rect x="27" y="87.5" width="46" height="4" rx="2" class="pc-accent"/>';

  const SHAPES = {
    /* Пешка: круглая голова на раструбе */
    p:
      '<circle cx="50" cy="27" r="13"/>' +
      '<path d="M38 42h24c1 16 4 28 9 43H29c5-15 8-27 9-43z"/>',

    /* Ладья: башня с высоким зубцом */
    r:
      '<path d="M28 12h11v11h7V12h8v11h7V12h11v20H28z"/>' +
      '<path d="M35 32h30c0 18 4 34 8 53H27c4-19 8-35 8-53z"/>',

    /* Слон: митра с хоботом */
    b:
      '<path d="M50 12c14 11 19 23 19 34 0 12-9 21-19 21s-19-9-19-21c0-11 5-23 19-34z"/>' +
      '<path d="M41 56c-4 10-6 20-5 29" fill="none" stroke-width="8" stroke-linecap="round"/>' +
      '<circle cx="50" cy="10" r="4.5"/>',

    /* Конь: голова с мордой и гривой */
    n:
      '<path d="M26 85c0-16 8-26 20-32-8-1-14-5-16-10-1-4 2-7 6-6l10 3c4-6 6-13 8-19l6-9 4 11c5 7 6 17 3 25-3 8-1 17 5 24 4 5 6 9 6 13z"/>' +
      '<path d="M31 55c-6 4-11 10-14 18 4-8 9-13 16-16z"/>',

    /* Ферзь: корона и широкая юбка */
    q:
      '<path d="M26 18l10 15 9-17 5 15 5-15 9 17 10-15-5 21H31z"/>' +
      '<path d="M33 39h34c1 17 4 31 8 46H25c4-15 7-29 8-46z"/>',

    /* Король: корона с крестом */
    k:
      '<path d="M29 24l9 13 8-15 4 13 4-13 8 15 9-13-4 19H33z"/>' +
      '<path d="M46.5 6h7v5h5v7h-5v5h-7v-5h-5v-7h5z"/>' +
      '<path d="M31 43h38c1 16 4 29 8 42H23c4-13 7-26 8-42z"/>',
  };

  /* Цветные детали (акцент стороны) */
  const ACCENTS = {
    p: ACCENT_BASE + '<circle cx="50" cy="24" r="4" class="pc-accent"/>',
    r: ACCENT_BASE + '<rect x="32" y="17" width="36" height="5" rx="2" class="pc-accent"/>',
    b: ACCENT_BASE + '<circle cx="50" cy="10" r="2.6" class="pc-accent"/>',
    n: ACCENT_BASE + '<circle cx="58" cy="34" r="3.2" class="pc-accent"/>',
    q: ACCENT_BASE + '<circle cx="50" cy="12" r="3.4" class="pc-accent"/><rect x="33" y="36" width="34" height="4" rx="2" class="pc-accent"/>',
    k: ACCENT_BASE + '<rect x="33" y="40" width="34" height="4" rx="2" class="pc-accent"/>',
  };

  const SIDES = {
    w: { fill: '#f8faff', stroke: '#131d38', accent: '#2f6dff' },
    b: { fill: '#1d2745', stroke: '#070a14', accent: '#ff3f5f' },
  };

  const cache = new Map();

  /* Соберёт SVG-разметку фигуры по её коду ('P','n','b'…) */
  function svg(piece) {
    if (!piece) return '';
    const type = piece.toLowerCase();                 /* ключи фигур строчные */
    const side = piece === piece.toUpperCase() ? 'w' : 'b';
    if (cache.has(piece)) return cache.get(piece);

    const colors = SIDES[side];
    const shape = SHAPES[type];
    if (!shape) return '';

    const markup =
      '<svg class="piece-svg ' + side + '" viewBox="0 0 100 100" ' +
      'xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">' +
        '<g class="pc-body" fill="' + colors.fill + '" stroke="' + colors.stroke + '" ' +
           'stroke-width="3.2" stroke-linejoin="round" stroke-linecap="round">' +
          shape + BASE +
        '</g>' +
        '<g class="pc-accents" fill="' + colors.accent + '" stroke="none">' + (ACCENTS[type] || '') + '</g>' +
      '</svg>';
    cache.set(piece, markup);
    return markup;
  }

  /* Удобная обёртка: <span class="piece w" data-piece="N">…</span> */
  function html(piece) {
    if (!piece) return '';
    const color = piece === piece.toUpperCase() ? 'w' : 'b';
    return '<span class="piece ' + color + '" data-piece="' + piece + '">' + svg(piece) + '</span>';
  }

  /* Для перетаскиваемой «тени» фигуры */
  function ghostHtml(piece) {
    if (!piece) return '';
    const color = piece === piece.toUpperCase() ? 'w' : 'b';
    return '<div class="ghost ' + color + '" data-piece="' + piece + '">' + svg(piece) + '</div>';
  }

  return { svg, html, ghostHtml };
})();

if (typeof window !== 'undefined') window.Pieces = Pieces;