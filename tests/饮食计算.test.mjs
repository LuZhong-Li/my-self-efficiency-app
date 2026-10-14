/* 饮食的纯逻辑测试：只测 app/web/diet-calc.js。
 * 跑法：node tests\饮食计算.test.mjs   （本机 Node v24，不需要 package.json）
 * 说明：和别的 .test.mjs 一样，不进「自检.cmd」——自检是给用户一键跑的，保持纯 Python。 */

import {
  DIET_SLOTS, normalizeFood, normalizeMealItem, itemsOfSlot, nutritionOf,
  dayNutritionOf, dayKcalSeries, nutritionTargetOf, kcalStateOf,
} from "../app/web/diet-calc.js";

let pass = 0;
let fail = 0;

function eq(actual, expected, label) {
  if (actual === expected) {
    pass++;
    console.log("  ok   " + label);
  } else {
    fail++;
    console.log("  FAIL " + label + "：期望 " + JSON.stringify(expected) +
      "，实际 " + JSON.stringify(actual));
  }
}

function ok(cond, label) {
  eq(Boolean(cond), true, label);
}

function deep(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deep(a[k], b[k]));
}

function eqDeep(actual, expected, label) {
  if (deep(actual, expected)) {
    pass++;
    console.log("  ok   " + label);
  } else {
    fail++;
    console.log("  FAIL " + label + "：期望 " + JSON.stringify(expected) +
      "，实际 " + JSON.stringify(actual));
  }
}

console.log("\n【四餐的键】");
eqDeep(DIET_SLOTS.map((s) => s[0]), ["breakfast", "lunch", "dinner", "snack"], "四餐的键固定");
eqDeep(DIET_SLOTS.map((s) => s[1]), ["早餐", "午餐", "晚餐", "加餐"], "四餐的中文名");

console.log("\n【一条菜谱的形状】");
eqDeep(normalizeFood({ id: "f1", name: "米饭", unit: "碗", kcal: "200", protein: 4,
  fat: 0.5, carb: 44, tags: ["主食"], note: "一小碗" }),
{ id: "f1", name: "米饭", unit: "碗", kcal: 200, protein: 4, fat: 0.5, carb: 44,
  tags: ["主食"], note: "一小碗" }, "字符串进来的数字认得出");
eqDeep(normalizeFood({}), { id: "", name: "", unit: "", kcal: 0, protein: 0, fat: 0, carb: 0,
  tags: [], note: "" }, "缺字段一律补默认值");
eq(normalizeFood({ kcal: -5 }).kcal, 0, "负数当 0");
eq(normalizeFood({ kcal: 230.5 }).kcal, 230.5, "小数热量留着（半个包子也常吃）");
eqDeep(normalizeFood({ tags: "主食" }).tags, [], "标签写得不是数组就当空的（不清洗、不猜）");
eqDeep(normalizeFood(null), normalizeFood({}), "传 null 和空对象一个样");

console.log("\n【一条「吃了什么」的形状】");
eqDeep(normalizeMealItem({ id: "i1", slot: "breakfast", foodId: "f1", name: "米饭",
  unit: "碗", amount: "1.5", kcal: 200, protein: 4, fat: 0.5, carb: 44 }),
{ id: "i1", slot: "breakfast", foodId: "f1", name: "米饭", unit: "碗", amount: 1.5,
  kcal: 200, protein: 4, fat: 0.5, carb: 44, tags: [] }, "份数能是小数");
eqDeep(normalizeMealItem({}), { id: "", slot: "snack", foodId: "", name: "", unit: "",
  amount: 1, kcal: 0, protein: 0, fat: 0, carb: 0, tags: [] }, "缺字段补默认值（份数默认 1）");
eqDeep(normalizeMealItem({ tags: ["外卖"] }).tags, ["外卖"], "条目也能贴标签");
eq(normalizeMealItem({ slot: "dinner" }).slot, "dinner", "认得出的餐次留着");
eq(normalizeMealItem({ slot: "夜宵" }).slot, "snack", "认不出的餐次归加餐（不丢数据）");
eq(normalizeMealItem({ amount: 0 }).amount, 0, "写了 0 份就是 0 份");
eq(normalizeMealItem({ amount: -3 }).amount, 0, "负份数当 0");
eq(normalizeMealItem({ amount: "" }).amount, 1, "空着按 1 份算");
eqDeep(normalizeMealItem(null), normalizeMealItem({}), "传 null 不炸");

console.log("\n【按份数换算】");
const ITEMS = [
  { id: "i1", slot: "breakfast", name: "米饭", unit: "碗", amount: 1.5,
    kcal: 200, protein: 4, fat: 0.5, carb: 44 },
  { id: "i2", slot: "lunch", name: "鸡胸肉", unit: "100 克", amount: 2,
    kcal: 150, protein: 30, fat: 3, carb: 0 },
];
eqDeep(nutritionOf(ITEMS), { kcal: 600, protein: 66, fat: 7, carb: 66 },
  "1.5 份米饭 + 2 份鸡胸肉（0.75 克脂肪跟别的脂肪一起进位）");
eqDeep(nutritionOf([]), { kcal: 0, protein: 0, fat: 0, carb: 0 }, "没条目全是 0");
eqDeep(nutritionOf(null), { kcal: 0, protein: 0, fat: 0, carb: 0 }, "传 null 不炸");
eq(nutritionOf([{ amount: 0, kcal: 500 }]).kcal, 0, "0 份不贡献热量");
eq(nutritionOf([{ amount: 2, kcal: 100.4 }]).kcal, 201, "先乘再进位");

console.log("\n【按餐取条目】");
const MEAL = {
  id: "m1", date: "2026-10-07", breakfast: "米饭 + 鸡蛋", lunch: "", dinner: "", snack: "",
  items: [
    { id: "i1", slot: "breakfast", name: "米饭", amount: 1.5, kcal: 200, protein: 4,
      fat: 0.5, carb: 44 },
    { id: "i2", slot: "lunch", name: "鸡胸肉", amount: 2, kcal: 150, protein: 30, fat: 3, carb: 0 },
    { id: "i3", slot: "夜宵", name: "烧烤", amount: 1, kcal: 900, protein: 0, fat: 0, carb: 0 },
  ],
};
eqDeep(itemsOfSlot(MEAL, "breakfast").map((i) => i.id), ["i1"], "早餐就那一条");
eqDeep(itemsOfSlot(MEAL, "dinner"), [], "晚餐没有就是空数组");
eqDeep(itemsOfSlot(MEAL, "snack").map((i) => i.id), ["i3"], "认不出餐次的那条算加餐");
eqDeep(itemsOfSlot(null, "lunch"), [], "meal 是 null 时给空数组");

console.log("\n【一天的合计与趋势】");
const MEALS = [
  MEAL,
  { id: "m2", date: "2026-10-06", breakfast: "", lunch: "", dinner: "", snack: "",
    items: [{ id: "i4", slot: "dinner", name: "外卖炒饭", amount: 1,
      kcal: 800, protein: 20, fat: 25, carb: 90 }] },
];
eq(dayNutritionOf(MEALS, "2026-10-07").kcal, 1500, "热量 = 米饭 300 + 鸡胸肉 300 + 加餐 900");
eq(dayNutritionOf(MEALS, "2026-10-07").protein, 66, "蛋白质 = 6 + 60（加餐那条没写蛋白）");
eq(dayNutritionOf(MEALS, "2026-10-07").fat, 7, "脂肪 = 0.75 + 6 → 先加后进位成 7");
eq(dayNutritionOf(MEALS, "2026-10-07").carb, 66, "碳水 = 66");
eq(dayNutritionOf(MEALS, "2026-10-06").kcal, 800, "前一天只有那条外卖");
eq(dayNutritionOf(MEALS, "2026-01-01").kcal, 0, "没记过的那天是 0");
eqDeep(dayNutritionOf(null, "2026-10-07"), { kcal: 0, protein: 0, fat: 0, carb: 0 },
  "传 null 不炸");

const SERIES = dayKcalSeries(MEALS, ["2026-10-05", "2026-10-06", "2026-10-07"]);
eqDeep(SERIES.map((r) => r.date), ["2026-10-05", "2026-10-06", "2026-10-07"], "几天几个点");
eqDeep(SERIES.map((r) => r.kcal), [0, 800, 1500], "每天的热量");
eqDeep(SERIES.map((r) => r.ratio), [0, 800 / 1500, 1], "最高的那天满格");
eqDeep(dayKcalSeries(null, null), [], "传 null 给空数组");

console.log("\n【每日目标与档位】");
eqDeep(nutritionTargetOf({ settings: { nutritionTarget: { kcal: "2000", protein: 120,
  fat: 60, carb: 250 } } }), { kcal: 2000, protein: 120, fat: 60, carb: 250 },
  "目标从 settings 里读，字符串也认");
eqDeep(nutritionTargetOf({}), { kcal: 0, protein: 0, fat: 0, carb: 0 }, "没设过就是全 0");
eqDeep(nutritionTargetOf(null), { kcal: 0, protein: 0, fat: 0, carb: 0 }, "传 null 不炸");

eqDeep(kcalStateOf(0, 0), { level: "none", percent: 0, diff: 0, over: false },
  "没设目标 → 不画进度条");
eqDeep(kcalStateOf(600, 2000), { level: "low", percent: 30, diff: 1400, over: false },
  "吃了三成 → 还差得多");
eqDeep(kcalStateOf(1700, 2000), { level: "good", percent: 85, diff: 300, over: false },
  "八成到一百之间 → 差不多");
eqDeep(kcalStateOf(2000, 2000), { level: "good", percent: 100, diff: 0, over: false },
  "刚好到目标不算超");
eqDeep(kcalStateOf(2150, 2000), { level: "over", percent: 108, diff: -150, over: true },
  "超了 → 标红，percent 不封顶（好知道超了多少）");
eqDeep(kcalStateOf(-5, 2000), { level: "low", percent: 0, diff: 2000, over: false },
  "负数当 0");

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
