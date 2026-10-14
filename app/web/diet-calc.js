/* 饮食的纯逻辑：菜谱长什么样、一条「吃了什么」长什么样、按份数换算营养、
 * 一天的合计、近几天的热量趋势、每日目标的档位。
 *
 * 原来的饮食页只有「四餐文字 + 水杯数」，那几个小函数散在页面里；2026-10-14 加营养计算，
 * 顺手收成一个纯逻辑模块 —— 热量这块最容易算错，`node tests\饮食计算.test.mjs`
 * 能一条条断言（和记账、工时那几个计算模块一个路数）。
 *
 * 两个形状分清楚：
 *   · 菜谱（foods 表）——「一样东西每份多少热量 / 蛋白 / 脂肪 / 碳水」；
 *   · 条目（meals[].items）——「这一餐吃了哪样、几份」，营养是**每 1 份的快照**。
 *     存快照的理由：份数改了营养跟着走，而改菜谱不会动摇历史账。
 */

import { barRatioOf } from "./chart-calc.js";

/** 四餐：键（存数据用）与页面上的名字 */
export const DIET_SLOTS = [
  ["breakfast", "早餐"],
  ["lunch", "午餐"],
  ["dinner", "晚餐"],
  ["snack", "加餐"],
];

const SLOT_KEYS = DIET_SLOTS.map((s) => s[0]);

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function text(value) {
  return String(value == null ? "" : value).trim();
}

/** 认不出的餐次一律算加餐（老数据、手改过的都不丢） */
function slotOf(value) {
  const key = text(value);
  return SLOT_KEYS.includes(key) ? key : "snack";
}

/** 把一条菜谱补齐成完整形状 */
export function normalizeFood(row) {
  const r = row && typeof row === "object" ? row : {};
  return {
    id: text(r.id),
    name: text(r.name),
    unit: text(r.unit),
    kcal: Math.max(0, num(r.kcal)),
    protein: Math.max(0, num(r.protein)),
    fat: Math.max(0, num(r.fat)),
    carb: Math.max(0, num(r.carb)),
    tags: Array.isArray(r.tags) ? r.tags.map((t) => text(t)).filter(Boolean) : [],
    note: text(r.note),
  };
}

/** 把一条「吃了什么」补齐成完整形状。份数没填按 1 份算；写成 0 / 负数就按 0。 */
export function normalizeMealItem(row) {
  const r = row && typeof row === "object" ? row : {};
  const rawAmount = r.amount;
  const blank = rawAmount === undefined || rawAmount === null || rawAmount === "";
  return {
    id: text(r.id),
    slot: slotOf(r.slot),
    foodId: text(r.foodId),
    name: text(r.name),
    unit: text(r.unit),
    amount: blank ? 1 : Math.max(0, num(rawAmount)),
    kcal: Math.max(0, num(r.kcal)),
    protein: Math.max(0, num(r.protein)),
    fat: Math.max(0, num(r.fat)),
    carb: Math.max(0, num(r.carb)),
    // 标签和别处一个规矩：只认数组（清洗与去重是 tag-calc.js 的事）
    tags: Array.isArray(r.tags) ? r.tags.map((t) => text(t)).filter(Boolean) : [],
  };
}

/** 这一餐的条目（meal 可能是 null / 老数据没有 items） */
export function itemsOfSlot(meal, slot) {
  const want = slotOf(slot);
  const list = meal && Array.isArray(meal.items) ? meal.items : [];
  return list.map((r) => normalizeMealItem(r)).filter((i) => i.slot === want);
}

/**
 * 按份数换算求和。**先按原值相加、最后再四舍五入**到整数 ——
 * 一条条先取整再加，误差会攒起来。
 */
export function nutritionOf(items) {
  const sum = { kcal: 0, protein: 0, fat: 0, carb: 0 };
  for (const raw of items || []) {
    const it = normalizeMealItem(raw);
    sum.kcal += it.kcal * it.amount;
    sum.protein += it.protein * it.amount;
    sum.fat += it.fat * it.amount;
    sum.carb += it.carb * it.amount;
  }
  return {
    kcal: Math.round(sum.kcal),
    protein: Math.round(sum.protein),
    fat: Math.round(sum.fat),
    carb: Math.round(sum.carb),
  };
}

/** 那一天的记录（meals 里 date 对上的那条） */
function mealOf(meals, date) {
  const day = text(date);
  return (meals || []).find((m) => m && text(m.date) === day) || null;
}

/** 那一天四餐加起来（没记过那天就全是 0） */
export function dayNutritionOf(meals, date) {
  const meal = mealOf(meals, date);
  return nutritionOf(meal && Array.isArray(meal.items) ? meal.items : []);
}

/** 这几天每天的热量 + ratio（给柱状图；和 gameMonthTrend 一个形状） */
export function dayKcalSeries(meals, dates) {
  const list = Array.isArray(dates) ? dates : [];
  const values = list.map((d) => dayNutritionOf(meals, d).kcal);
  const max = values.reduce((best, v) => Math.max(best, v), 0);
  return list.map((date, i) => ({
    date: text(date),
    kcal: values[i],
    ratio: barRatioOf(values[i], max),
  }));
}

/** 每日目标（存 settings.nutritionTarget）：读数补成完整形状，缺的当 0（= 不设） */
export function nutritionTargetOf(data) {
  const raw = (data && data.settings && data.settings.nutritionTarget) || {};
  return {
    kcal: Math.max(0, num(raw.kcal)),
    protein: Math.max(0, num(raw.protein)),
    fat: Math.max(0, num(raw.fat)),
    carb: Math.max(0, num(raw.carb)),
  };
}

/**
 * 热量档位：没设目标 → none（只报数、不画进度条）；不到 80% → low；
 * 80% 到 100% → good；超了 → over（页面标红）。
 * percent 不封顶（超了多少要有数可查），diff 正数是「还差多少」、负数是「超了多少」。
 */
export function kcalStateOf(total, target) {
  const eaten = Math.max(0, num(total));
  const goal = Math.max(0, num(target));
  if (!goal) return { level: "none", percent: 0, diff: 0, over: false };
  const percent = Math.round((eaten / goal) * 100);
  const over = eaten > goal;
  return {
    level: over ? "over" : percent >= 80 ? "good" : "low",
    percent,
    diff: goal - eaten,
    over,
  };
}
