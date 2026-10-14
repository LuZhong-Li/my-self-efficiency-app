/* 图表的纯逻辑与拼装 —— 只吃数据、吐数字和字符串，不碰 DOM、不碰 store。
 *
 * 为什么单独开一个：记账那两张图（环形、柱状）当初是各写各的，这轮游戏要补两张、
 * 记账再补一张，条长比例 / 柱状几何 / 分档那点东西抄三遍就该出岔子了。
 * 放进纯模块之后 `node tests\图表计算.test.mjs` 能一条条断言。
 *
 * 拼 HTML / SVG 的活也在这儿（页面只管把结果塞进 DOM）—— 所以它自带一份本地 esc，
 * 理由和 item-form.js 那份一样：store.js 的 esc 会碰 window，纯模块 import 不了。
 */

import { weekStartOf } from "./goal-calc.js";
import { addDays } from "./task-calc.js";

function esc(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ---------------- 月份序列（2026-10-14 从 finance-calc.js 搬来） ---------------- */

/** "2026-10" 往回数 → ["2026-05" … "2026-10"]（升序、含当月；跨年接得上） */
export function lastMonths(month, count = 6) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month == null ? "" : month).trim());
  if (!m) return [];
  const n = Math.max(1, Math.floor(Number(count) || 1));
  const end = Number(m[1]) * 12 + (Number(m[2]) - 1);   // 以「0 年 1 月」为 0 的月序号
  const out = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const at = end - i;
    out.push(`${Math.floor(at / 12)}-${String((at % 12) + 1).padStart(2, "0")}`);
  }
  return out;
}

/* ---------------- 条长比例 ---------------- */

/** 条长比例 0..1。最大值是 0 或值本身不是正数时一律给 0（不除零、不出负） */
export function barRatioOf(value, max) {
  const v = Number(value) || 0;
  const m = Number(max) || 0;
  if (v <= 0 || m <= 0) return 0;
  return Math.min(1, v / m);
}

/** 给一组记录各补一个 ratio（条长用）。key 是取哪个字段当数值。 */
export function barRowsOf(rows, key) {
  const list = Array.isArray(rows) ? rows.filter((r) => r && typeof r === "object") : [];
  const max = list.reduce((best, row) => Math.max(best, Number(row[key]) || 0), 0);
  return list.map((row) => ({ ...row, ratio: barRatioOf(row[key], max) }));
}

/* ---------------- 柱状图的几何 ---------------- */

/**
 * 柱状图的坐标：给几行数据和画布尺寸，算出每根柱的 x / 宽 / 高 / 顶。
 * 上下各留一行：下面写月份、上面写数值（和记账那张图一个排法）。
 * box = { width, height, gap, value(row) }，value 省了就认行上的 value 字段。
 */
export function trendBars(rows, box = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const width = Number(box.width) || 600;
  const height = Number(box.height) || 180;
  const gap = Number(box.gap) || 14;
  const pick =
    typeof box.value === "function" ? box.value : (row) => Number(row && row.value) || 0;
  const baseY = height - 24;      // 柱子底线（下面留一行写月份）
  const chartH = baseY - 30;      // 柱子最高到哪儿（上面留一行写数值）
  if (!list.length) return { baseY, chartH, bars: [] };
  const max = list.reduce((best, row) => Math.max(best, Number(pick(row)) || 0), 0);
  const w = (width - gap * (list.length - 1)) / list.length;
  const bars = list.map((row, i) => {
    const value = Number(pick(row)) || 0;
    const ratio = barRatioOf(value, max);
    // 有数值就至少画 3 高（不然鼠标都找不到那根柱），零值就老实给 0
    const h = value ? Math.max(3, Math.round(chartH * ratio)) : 0;
    const x = i * (w + gap);
    return { x, w, h, y: baseY - h, ratio, value, row };
  });
  return { baseY, chartH, bars };
}

/* ---------------- 热力图的格子与分档 ---------------- */

/**
 * 近 N 周的格子，**按列**返回（一周一列，周一 → 周日；最后一列是 endDate 那一周）。
 * 按列是因为 CSS grid 可以 `grid-auto-flow: column` + 7 行一路排下来。
 * 本周还没到的日子照样给格子（网格才方），只是标成 inRange: false。
 */
export function heatGrid(endDate, weeks = 26) {
  const n = Math.max(1, Math.floor(Number(weeks) || 1));
  const lastMonday = weekStartOf(endDate);
  const first = addDays(lastMonday, -7 * (n - 1));
  const cells = [];
  for (let column = 0; column < n; column += 1) {
    for (let row = 0; row < 7; row += 1) {
      const date = addDays(first, column * 7 + row);
      cells.push({ date, inRange: date <= endDate, column, row });
    }
  }
  return cells;
}

/**
 * 金额（分）分档：0 元固定 0 档，最大值落最高档，中间单调不回头。
 * levels 是总档数（含 0 档那一档），默认 5 档。
 */
export function heatLevelOf(value, max, levels = 5) {
  const lv = Math.max(2, Math.floor(Number(levels) || 5));
  const v = Number(value) || 0;
  const m = Number(max) || 0;
  if (v <= 0 || m <= 0) return 0;
  if (v >= m) return lv - 1;
  return Math.max(1, Math.min(lv - 1, 1 + Math.floor((v / m) * (lv - 1))));
}

/* ---------------- 拼装：横条（铺在行背景上） ---------------- */

/**
 * 一条横条：宽度按比例，铺在整行背景上（父元素记得 position: relative）。
 * 为什么铺背景、不另起一行：榜单一行本来就矮，另起一行会把三行变六行高，
 * 而「谁比谁长」这件事铺成背景一眼就出来了。空 span，纯装饰。
 */
export function barFillHtml(ratio, opts = {}) {
  const pct = Math.round(barRatioOf(ratio, 1) * 100);
  const title = opts.title ? ` title="${esc(opts.title)}"` : "";
  return `<span class="bar-fill" aria-hidden="true" style="width:${pct}%"${title}></span>`;
}

/* ---------------- 拼装：柱状图（手写 SVG，不引库） ---------------- */

/**
 * 柱状图整段 SVG。上下各留一行（上面数值、下面标签），最后一根（当月）标 now。
 * opts = { width, height, gap, value(row), label(row), valueText(value, row),
 *          title(row), ariaLabel, className }
 */
export function trendChartHtml(rows, opts = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const width = Number(opts.width) || 600;
  const height = Number(opts.height) || 180;
  const className = opts.className || "chart-trend";
  const labelOf =
    typeof opts.label === "function" ? opts.label : (row) => String((row && row.month) || "");
  const valueTextOf =
    typeof opts.valueText === "function" ? opts.valueText : (v) => String(Number(v) || 0);
  const titleOf = typeof opts.title === "function" ? opts.title : () => "";
  const { baseY, bars } = trendBars(list, { width, height, gap: opts.gap, value: opts.value });
  const body = bars
    .map((b, i) => {
      const mid = (b.x + b.w / 2).toFixed(1);
      const now = i === bars.length - 1 ? " now" : "";   // 最后一根就是当月（序列来自 lastMonths）
      return (
        `<g class="${className}-bar${now}">` +
        `<title>${esc(titleOf(b.row))}</title>` +
        `<rect x="${b.x.toFixed(1)}" y="${b.y}" width="${b.w.toFixed(1)}" height="${b.h}" rx="5"></rect>` +
        (b.value
          ? `<text class="${className}-num" x="${mid}" y="${Math.max(13, b.y - 7)}" ` +
            `text-anchor="middle">${esc(valueTextOf(b.value, b.row))}</text>`
          : "") +
        `<text class="${className}-label" x="${mid}" y="${baseY + 17}" ` +
        `text-anchor="middle">${esc(labelOf(b.row))}</text>` +
        `</g>`
      );
    })
    .join("");
  return (
    `<svg class="${className}" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" ` +
    `role="img" aria-label="${esc(opts.ariaLabel || "柱状图")}">` +
    `<line class="chart-base" x1="0" y1="${baseY}" x2="${width}" y2="${baseY}"></line>` +
    `${body}</svg>`
  );
}

/* ---------------- 拼装：热力网格（CSS grid，一周一列） ---------------- */

/**
 * 热力图的格子。一周一列、七天一行，所以网格要配
 * `grid-auto-flow: column; grid-template-rows: repeat(7, …)`。
 * 每格一个 span：档位是 hm-l0（最浅）… hm-l4，今天多一个 today 描边，
 * 本周还没到的日子多一个 out（画淡一点）。
 * opts = { amount(cell), today, title(cell, amount), levels, ariaLabel }
 */
export function heatmapHtml(cells, opts = {}) {
  const list = Array.isArray(cells) ? cells : [];
  const amountOf = typeof opts.amount === "function" ? opts.amount : () => 0;
  const titleOf = typeof opts.title === "function" ? opts.title : () => "";
  const levels = Math.max(2, Math.floor(Number(opts.levels) || 5));
  const max = list.reduce((best, c) => Math.max(best, Number(amountOf(c)) || 0), 0);
  const today = String(opts.today || "");
  const body = list
    .map((c) => {
      const amount = Number(amountOf(c)) || 0;
      const level = heatLevelOf(amount, max, levels);
      const cls =
        `hm-cell hm-l${level}` +
        (c.inRange === false ? " out" : "") +
        (today && c.date === today ? " today" : "");
      return (
        `<span class="${cls}" data-date="${esc(c.date)}" ` +
        `title="${esc(titleOf(c, amount))}"></span>`
      );
    })
    .join("");
  return (
    `<div class="hm-grid" role="img" aria-label="${esc(opts.ariaLabel || "支出日历")}">` +
    `${body}</div>`
  );
}
