/* 时长与计时：分钟 ↔ 小时的换算、时长的显示、秒表这几件小事。
 *
 * 为什么单开一个：这些函数本来是游戏娱乐的（游玩记录要记「多久」），
 * 2026-10-14 做「工时统计」时发现两边要的是**一模一样**的一套 ——
 * 「记一条有时长的记录」这件小事（换算、显示、跑表）。与其让工时去 import 游戏，
 * 不如收在这里：游戏的 game-calc.js 只保留一行转出，那边的页面和测试一个字都不用改。
 * 以后再有什么「学了多久 / 练了多久」，直接接这个模块。
 *
 * 纯函数：只吃数字和时间戳，不碰 DOM、不碰 store —— `node tests\工时计算.test.mjs`
 * 能一条条断言。
 */

/** 时长统一按分钟存（120 = 2 小时），界面上可以按分钟或者小时填 */
export const DURATION_UNITS = ["分钟", "小时"];

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/* ---------------- 时长怎么显示 ---------------- */

/** 120 → 2 小时；90 → 1 小时 30 分钟；45 → 45 分钟；0 → — */
export function durationText(minutes) {
  const m = Math.max(0, Math.round(num(minutes)));
  if (!m) return "—";
  if (m < 60) return m + " 分钟";
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} 小时 ${rest} 分钟` : `${h} 小时`;
}

/** 120 → 2；90 → 1.5（列表里那行「累计」用） */
export function hoursOf(minutes) {
  return Math.round((Math.max(0, num(minutes)) / 60) * 10) / 10;
}

/** 120 → "2 小时"；90 → "1.5 小时"（比 durationText 短，卡片上够用） */
export function hoursText(minutes) {
  const h = hoursOf(minutes);
  if (!h) return "0 小时";
  return (Number.isInteger(h) ? h : h.toFixed(1)) + " 小时";
}

/** 表单里填的「数字 + 单位」换算成分钟 */
export function toMinutes(amount, unit) {
  const n = Math.max(0, num(amount));
  return Math.round(n * (unit === "小时" ? 60 : 1));
}

/** 反过来：编辑时默认怎么填。整小时就按小时填（2 小时），否则按分钟填（90） */
export function shownDuration(minutes) {
  const m = Math.max(0, Math.round(num(minutes)));
  if (m && m % 60 === 0) return { amount: m / 60, unit: "小时" };
  return { amount: m, unit: "分钟" };
}

/* ---------------- 快速计时 ---------------- */

/** 开始计时的那一刻到现在过了多少分钟（至少 1 分钟） */
export function elapsedMinutes(startedAt, now) {
  const from = num(startedAt);
  const to = num(now);
  if (!from || to <= from) return 0;
  return Math.max(1, Math.round((to - from) / 60000));
}

/** 计时器上那串「00:12:34」 */
export function clockText(startedAt, now) {
  const from = num(startedAt);
  const to = num(now);
  let seconds = from && to > from ? Math.floor((to - from) / 1000) : 0;
  const h = Math.floor(seconds / 3600);
  seconds -= h * 3600;
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  const p = (n) => String(n).padStart(2, "0");
  return `${p(h)}:${p(m)}:${p(s)}`;
}
