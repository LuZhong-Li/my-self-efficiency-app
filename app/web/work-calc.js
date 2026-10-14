/* 工时统计的纯逻辑：一条工时长什么样、四档汇总、按月、按项目。
 * 只吃数据、吐结果，不碰 DOM、不碰 store —— `node tests\工时计算.test.mjs` 能一条条断言。
 *
 * 一条工时 = 「哪天在哪个项目上花了多久」（minutes 统一按分钟存，换算和显示在 time-calc.js）。
 * 口径和游戏、首页那套对齐：本周从周一算起；没填日期的只进「累计」，
 * 不进任何一段时间、也不进按月的图。
 */

import { weekStartOf } from "./goal-calc.js";
import { barRatioOf } from "./chart-calc.js";

/** projectId 空的：就是没挑项目 */
export const LOOSE_NAME = "没记项目";
/** projectId 指着一个已经不在 projects 里的 id */
export const GONE_NAME = "（项目已删）";

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function text(value) {
  return String(value == null ? "" : value).trim();
}

/** 项目 id → 显示名：空 id 是「没记项目」，id 找不着是「（项目已删）」。
 *  统计那一块和记录列表都用它，两处的名字才是同一个口径。 */
export function projectLabelOf(projectId, projects) {
  const id = text(projectId);
  if (!id) return LOOSE_NAME;
  const found = (projects || []).find((p) => p && text(p.id) === id);
  return found ? text(found.name) || "（没写名字）" : GONE_NAME;
}

/** 把一条工时补齐成完整形状（老数据、手写数据都认） */
export function normalizeWorkLog(row) {
  const r = row && typeof row === "object" ? row : {};
  return {
    id: text(r.id),
    date: text(r.date),
    projectId: text(r.projectId),
    minutes: Math.max(0, Math.round(num(r.minutes))),
    note: text(r.note),
    // 标签和别处一个规矩：只认数组（清洗与去重是 tag-calc.js 的事，这里不猜、不拆字符串）
    tags: Array.isArray(r.tags) ? r.tags.map((t) => text(t)).filter(Boolean) : [],
    createdAt: text(r.createdAt),
  };
}

/** 今日 / 本周（周一起）/ 本月 / 累计：分钟数 + 条数 + 记过几天（同一天多条算一天） */
export function workStatsOf(logs, today) {
  const day = text(today);
  const week = weekStartOf(day);
  const month = day.slice(0, 7);
  const out = { todayMin: 0, weekMin: 0, monthMin: 0, allMin: 0, count: 0, days: 0 };
  const seen = new Set();
  for (const raw of logs || []) {
    const row = normalizeWorkLog(raw);
    out.allMin += row.minutes;
    out.count += 1;
    if (!row.date) continue;
    seen.add(row.date);
    if (row.date === day) out.todayMin += row.minutes;
    if (row.date >= week && row.date <= day) out.weekMin += row.minutes;
    if (row.date.slice(0, 7) === month) out.monthMin += row.minutes;
  }
  out.days = seen.size;
  return out;
}

/** 每个月各花了多久（给柱状图）。months 是「2026-10」这种串，顺序照传进来的排。 */
export function monthMinutesOf(logs, months) {
  const list = Array.isArray(months) ? months : [];
  const sums = new Map();
  for (const raw of logs || []) {
    const row = normalizeWorkLog(raw);
    if (!row.date) continue;
    const key = row.date.slice(0, 7);
    sums.set(key, (sums.get(key) || 0) + row.minutes);
  }
  const minutesOf = list.map((month) => Math.max(0, sums.get(text(month)) || 0));
  const max = minutesOf.reduce((best, m) => Math.max(best, m), 0);
  return list.map((month, i) => ({
    month: text(month),
    minutes: minutesOf[i],
    ratio: barRatioOf(minutesOf[i], max),
  }));
}

/**
 * 按项目汇总，按工时降序。项目名走 projectLabelOf。
 * 「没记项目」（projectId 空）和「（项目已删）」（id 找不着了）各留一行 ——
 * 数据在，就不该在图里凭空消失。
 */
export function byProjectOf(logs, projects) {
  const buckets = new Map();
  let total = 0;
  for (const raw of logs || []) {
    const row = normalizeWorkLog(raw);
    const cur = buckets.get(row.projectId) || { projectId: row.projectId, minutes: 0, count: 0 };
    cur.minutes += row.minutes;
    cur.count += 1;
    buckets.set(row.projectId, cur);
    total += row.minutes;
  }
  const rows = [...buckets.values()].map((b) => ({
    ...b,
    name: projectLabelOf(b.projectId, projects),
  }));
  const max = rows.reduce((best, r) => Math.max(best, r.minutes), 0);
  return rows
    .map((r) => ({
      ...r,
      ratio: barRatioOf(r.minutes, max),
      share: total ? Math.round((r.minutes / total) * 1000) / 1000 : 0,
    }))
    .sort((a, b) => b.minutes - a.minutes || (a.name < b.name ? -1 : 1));
}

/** 分布太长时只画前 top 名，剩下的收成一行「还有 N 个 · 合计多少」 */
export function collapseRows(rows, top = 6) {
  const list = Array.isArray(rows) ? rows : [];
  const n = Math.max(1, Math.floor(num(top) || 1));
  const rest = list.slice(n);
  return {
    shown: list.slice(0, n),
    rest: rest.length,
    restMinutes: rest.reduce((sum, r) => sum + Math.max(0, num(r && r.minutes)), 0),
  };
}
