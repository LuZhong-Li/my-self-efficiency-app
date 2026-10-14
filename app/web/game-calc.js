/* 游戏娱乐的纯逻辑：游玩记录的形状、时长换算、按天 / 周 / 月 / 年的汇总、
 * TOP 排行、按游戏和日期范围筛选。只吃数据、吐结果，不碰 DOM、不碰 store ——
 * 所以能像记账、首页那样用 node 直接跑断言（tests/游戏计算.test.mjs）。
 *
 * 两个概念分清楚：
 *   · 游戏清单（games 表）—— 想玩 / 在玩 / 已通关 / 弃坑，一款游戏一条；
 *   · 游玩记录（gameRecords 表）—— 哪天玩了哪款、多久、什么感受，玩一次记一条。
 *
 * 累计时长不再靠手填：卡片上那个「累计 X 小时」是把这款游戏的游玩记录加起来。
 * 老数据里手填的 hours（小时）仍然认，一并算进去，这样以前记过的时长不会凭空消失。
 */

import { barRatioOf } from "./chart-calc.js";

/* 时长换算 / 显示 / 秒表搬到 time-calc.js 了（工时统计也要用同一套），这里只转出去：
   game.js、item-form.js、tests\游戏计算.test.mjs 一个字都不用改。

   注意先 import 再 export：`export { x } from "…"` 只把 x 转给外面，
   **不在本模块建一个能用的名字** —— 而下面的 recordTitle 自己也要用 durationText。
   写成「转出去」那种写法的话，recordTitle 会当场报 durationText is not defined
   （tests\游戏计算 里那条断言就是抓这个的）。 */
import {
  DURATION_UNITS, toMinutes, shownDuration, hoursOf, hoursText, durationText,
  elapsedMinutes, clockText,
} from "./time-calc.js";

export {
  DURATION_UNITS, toMinutes, shownDuration, hoursOf, hoursText, durationText,
  elapsedMinutes, clockText,
};

/** 记录里没绑定清单游戏时，用来分组的显示名 */
export const LOOSE_NAME = "（没写游戏名）";

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function text(value) {
  return String(value == null ? "" : value).trim();
}

/* ---------------- 一条记录 ---------------- */

/** 把一条游玩记录补齐成完整形状（老数据、手写数据都认） */
export function normalizeRecord(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    id: text(src.id),
    gameId: text(src.gameId),
    gameName: text(src.gameName),
    playDate: text(src.playDate),
    durationMin: Math.max(0, Math.round(num(src.durationMin))),
    remark: text(src.remark),
    createAt: text(src.createAt),
    imagePaths: Array.isArray(src.imagePaths)
      ? src.imagePaths.filter((p) => typeof p === "string" && p.trim())
      : [],
  };
}

/* ---------------- 时长怎么显示 ----------------
   这几个函数在 time-calc.js 里（工时统计也要用），上面转出来了；
   这里留个标记，免得下次有人在这一节里又写一份。 */

/* ---------------- 记录 ↔ 清单游戏 ---------------- */

/** 游戏名 → 清单里的游戏 id（下拉里选过的名字能自动绑上） */
export function linkGameId(name, map) {
  const key = text(name);
  if (!key || !map) return "";
  return text(map[key]);
}

/** 这条记录算不算「这款游戏」的：先认 id，没绑 id 的就按名字对 */
export function belongsTo(record, game) {
  if (!record || !game) return false;
  if (record.gameId && game.id) return record.gameId === game.id;
  return Boolean(record.gameName) && record.gameName === game.name;
}

/* ---------------- 取记录 ---------------- */

function stampOf(record) {
  return text(record.createAt) || text(record.playDate);
}

/** 同一天里新记的排前面 */
function byNewest(a, b) {
  const x = stampOf(a);
  const y = stampOf(b);
  if (x === y) return 0;
  return x < y ? 1 : -1;
}

/** 某一天的记录（新的在前） */
export function recordsOn(records, date) {
  return (records || []).filter((r) => r && r.playDate === date).sort(byNewest);
}

/** 某一款游戏的全部记录（日期从新到旧） */
export function recordsOfGame(records, game) {
  return (records || [])
    .filter((r) => belongsTo(r, game))
    .sort((a, b) => (a.playDate === b.playDate ? byNewest(a, b) : a.playDate < b.playDate ? 1 : -1));
}

/** 这款游戏的累计分钟：游玩记录求和 + 老数据里手填的 hours */
export function totalMinutesOfGame(records, game) {
  const fromRecords = recordsOfGame(records, game).reduce(
    (sum, r) => sum + Math.max(0, num(r.durationMin)),
    0
  );
  const legacy = Math.round(Math.max(0, num(game && game.hours)) * 60);
  return fromRecords + legacy;
}

export function sumMinutes(records) {
  return (records || []).reduce((sum, r) => sum + Math.max(0, num(r && r.durationMin)), 0);
}

/* ---------------- 日期小工具（本地时区，不走 UTC） ---------------- */

/** 那天所在周的周一（和 home-view.js / goal-calc.js 一个算法） */
export function weekStartOf(today) {
  const [y, m, d] = String(today).split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
  const p = (n) => String(n).padStart(2, "0");
  return dt.getFullYear() + "-" + p(dt.getMonth() + 1) + "-" + p(dt.getDate());
}

/* ---------------- 统计 ---------------- */

/**
 * 今日 / 本周（周一起）/ 本月 / 全年 / 累计的游玩时长，单位分钟。
 * 记录上没有日期的（老数据或手写）只算进「累计」，不掺进任何一段时间。
 */
export function statsOf(records, today) {
  const day = text(today);
  const week = weekStartOf(day);
  const month = day.slice(0, 7);
  const year = day.slice(0, 4);
  const out = { todayMin: 0, weekMin: 0, monthMin: 0, yearMin: 0, allMin: 0, count: 0, days: 0 };
  const seenDays = new Set();
  for (const r of records || []) {
    if (!r) continue;
    const minutes = Math.max(0, num(r.durationMin));
    const date = text(r.playDate);
    out.allMin += minutes;
    out.count++;
    if (!date) continue;
    seenDays.add(date);
    if (date === day) out.todayMin += minutes;
    if (date >= week && date <= day) out.weekMin += minutes;
    if (date.slice(0, 7) === month) out.monthMin += minutes;
    if (date.slice(0, 4) === year) out.yearMin += minutes;
  }
  out.days = seenDays.size;
  return out;
}

/**
 * 每个月各玩了多久（给「近 6 个月」那张柱状图用）。months 是「2026-10」这种串，
 * 顺序照传进来的排，ratio 是相对最多那个月的条长比例（和记账那张趋势图一个口径）。
 *
 * 口径：只算填了 playDate 的记录 —— 和 statsOf 一样（没日期的不算进任何一个月），
 * 所以图上当月那根柱和数字卡片的「本月」永远相等（tests\游戏计算 里有护栏盯着）。
 */
export function gameMonthTrend(records, months) {
  const list = Array.isArray(months) ? months : [];
  const sums = new Map();
  for (const r of records || []) {
    if (!r) continue;
    const date = text(r.playDate);
    if (!date) continue;
    const key = date.slice(0, 7);
    sums.set(key, (sums.get(key) || 0) + Math.max(0, num(r.durationMin)));
  }
  const minutesOf = list.map((month) => Math.max(0, sums.get(text(month)) || 0));
  const max = minutesOf.reduce((best, m) => Math.max(best, m), 0);
  return list.map((month, i) => ({
    month: text(month),
    minutes: minutesOf[i],
    ratio: barRatioOf(minutesOf[i], max),
  }));
}

/** 玩得最多的前几名：清单里每款游戏的累计，加上没绑定清单的那些临时记录 */
export function topGames(records, games, limit = 3) {
  const list = [];
  const boundIds = new Set();
  for (const game of games || []) {
    if (!game) continue;
    const minutes = totalMinutesOfGame(records, game);
    if (!minutes) continue;
    list.push({
      gameId: text(game.id),
      name: text(game.name) || LOOSE_NAME,
      minutes,
      count: recordsOfGame(records, game).length,
    });
    if (game.id) boundIds.add(text(game.id));
  }
  // 没绑清单的临时记录：按名字聚一聚（名字正好和清单里某款一样的，上面已经算过）
  const loose = new Map();
  for (const r of records || []) {
    if (!r) continue;
    if (r.gameId && boundIds.has(text(r.gameId))) continue;
    if ((games || []).some((g) => g && g.name && g.name === r.gameName)) continue;
    const key = text(r.gameName) || LOOSE_NAME;
    const cur = loose.get(key) || { gameId: "", name: key, minutes: 0, count: 0 };
    cur.minutes += Math.max(0, num(r.durationMin));
    cur.count++;
    loose.set(key, cur);
  }
  list.push(...loose.values());
  return list
    .filter((g) => g.minutes > 0)
    .sort((a, b) => b.minutes - a.minutes || (a.name < b.name ? -1 : 1))
    .slice(0, Math.max(0, Math.round(num(limit))));
}

/**
 * 本月超过「每月目标」的游戏（清单上给单款游戏设过目标时长才管）。
 * 超得越多排越前；一个都没设目标、或者都没超，就返回空数组（界面上那行整个不渲染）。
 */
export function overTargetGames(records, games, month) {
  const key = text(month).slice(0, 7);
  const out = [];
  for (const game of games || []) {
    if (!game) continue;
    const targetMinutes = Math.round(Math.max(0, num(game.targetHours)) * 60);
    if (!targetMinutes) continue;
    const minutes = (records || [])
      .filter((r) => belongsTo(r, game) && text(r.playDate).slice(0, 7) === key)
      .reduce((sum, r) => sum + Math.max(0, num(r.durationMin)), 0);
    if (minutes > targetMinutes) {
      out.push({
        gameId: text(game.id),
        name: text(game.name) || LOOSE_NAME,
        minutes,
        targetMinutes,
        overMinutes: minutes - targetMinutes,
      });
    }
  }
  return out.sort((a, b) => b.overMinutes - a.overMinutes || (a.name < b.name ? -1 : 1));
}

/* ---------------- 筛选 ---------------- */

/** 有没有在用筛选（名字 / 起止日期，任一个填了就算） */
export function hasFilter(filter) {
  const f = filter || {};
  return Boolean(text(f.name) || text(f.from) || text(f.to));
}

/** 按游戏名（模糊）+ 日期范围筛，日期从新到旧；筛选只影响显示，不动数据 */
export function filterRecords(records, filter) {
  const f = filter || {};
  const kw = text(f.name).toLowerCase();
  const from = text(f.from);
  const to = text(f.to);
  return (records || [])
    .filter((r) => {
      if (!r) return false;
      if (kw && !text(r.gameName).toLowerCase().includes(kw)) return false;
      const date = text(r.playDate);
      if (from && date < from) return false;
      if (to && date > to) return false;
      return true;
    })
    .sort((a, b) => {
      const da = text(a.playDate);
      const db = text(b.playDate);
      return da === db ? byNewest(a, b) : da < db ? 1 : -1;
    });
}

/** 记录行上显示的那句「游戏名 · 2 小时」 */
export function recordTitle(record) {
  const name = text(record && record.gameName) || LOOSE_NAME;
  return name + " · " + durationText(record && record.durationMin);
}

/* ---------------- 日期区间怎么显示（本地日期，不走 UTC） ---------------- */

/** "2026-10-08" → "2026/10/08"。给人和给框看的是两套：框的 value 必须是
 *  yyyy-mm-dd（浏览器原生日期控件只认这个），斜杠只出现在提示文字里。 */
function slashed(iso) {
  return text(iso).replace(/-/g, "/");
}

/**
 * 筛选栏上那句「筛选区间：2026/10/01 ~ 2026/10/08」。
 * 两端同一天就写一天；只填了一头就写「从…起 / 到…为止」；
 * 一天都没填给空串（界面上那边会写成「不限日期」）。
 */
export function rangeText(filter) {
  const f = filter || {};
  const from = slashed(f.from);
  const to = slashed(f.to);
  if (from && to) return from === to ? from : from + " ~ " + to;
  if (from) return "从 " + from + " 起";
  if (to) return "到 " + to + " 为止";
  return "";
}

/**
 * 这批记录实际覆盖的日期跨度（最早那天、最晚那天）。
 * 「看记录」只按游戏名筛的时候，用它把区间坐实成一个真日期范围 ——
 * 框里就不是一个跟列表对不上的「今天」，而列表里有哪些天一天也没落下。
 * 一条带日期的记录都没有，两头给空串。
 */
export function dateSpan(records) {
  const days = (records || [])
    .map((r) => text(r && r.playDate))
    .filter(Boolean)
    .sort();
  return { from: days[0] || "", to: days[days.length - 1] || "" };
}

/* ---------------- 快速计时 ----------------
   秒表那两个函数也在 time-calc.js 里（工时统计也要用），上面转出来了。 */
