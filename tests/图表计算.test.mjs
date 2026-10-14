/* 图表的纯逻辑测试：只测 app/web/chart-calc.js 里不碰 DOM 的那部分
 * （月份序列、条长比例、柱状几何、热力分档）。
 * 跑法：node tests\图表计算.test.mjs   （本机 Node v24，不需要 package.json）
 * 说明：和别的 .test.mjs 一样，不进「自检.cmd」——自检是给用户一键跑的，保持纯 Python。 */

import {
  lastMonths, barRatioOf, barRowsOf, trendBars, heatGrid, heatLevelOf,
} from "../app/web/chart-calc.js";
import { lastMonths as lastMonthsFromFinance } from "../app/web/finance-calc.js";

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

console.log("\n【月份序列：从哪个月往回数】");
eqDeep(lastMonths("2026-10", 6),
  ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"],
  "近 6 个月，含当月、升序");
eqDeep(lastMonths("2026-02", 3), ["2025-12", "2026-01", "2026-02"], "跨年接得上");
eqDeep(lastMonths("2026-01", 1), ["2026-01"], "只要一个月就一个月");
eqDeep(lastMonths("", 6), [], "月份写不出来给空数组，不炸");
eq(lastMonthsFromFinance, lastMonths, "finance-calc.js 那边只是把它转出来（同一个函数）");

console.log("\n【条长比例：不除零、不出负】");
eq(barRatioOf(50, 100), 0.5, "一半");
eq(barRatioOf(100, 100), 1, "满格");
eq(barRatioOf(0, 100), 0, "零就是零（不是 NaN）");
eq(barRatioOf(50, 0), 0, "最大值是 0 时不除零");
eq(barRatioOf(-5, 100), 0, "负数当 0");
eq(barRatioOf(200, 100), 1, "超了也封顶 1");
eq(barRatioOf(undefined, undefined), 0, "缺字段不炸");

const bars = barRowsOf(
  [{ name: "甲", minutes: 120 }, { name: "乙", minutes: 60 }, { name: "丙", minutes: 0 }],
  "minutes");
eqDeep(bars.map((r) => r.ratio), [1, 0.5, 0], "第一名满格、其余按比例、零记录是 0");
eq(bars[0].name, "甲", "原来的字段一个没丢（只是补了个 ratio）");
eqDeep(barRowsOf(null, "minutes"), [], "传 null 给空数组");
eqDeep(barRowsOf([{ a: 5 }, { a: 5 }], "a").map((r) => r.ratio), [1, 1], "并列第一名都满格");

console.log("\n【柱状图的几何：间距、坐标、零高柱】");
const geo = trendBars(
  [{ month: "m1", v: 100 }, { month: "m2", v: 50 }, { month: "m3", v: 0 }],
  { width: 600, height: 180, gap: 14, value: (r) => r.v });
eq(geo.bars.length, 3, "几行数据就几根柱");
eq(geo.baseY, 156, "柱子底线在下面留一行写月份（180 - 24）");
eq(geo.chartH, 126, "柱子最高到 baseY - 30");
eq(geo.bars[0].h, 126, "最大的那根占满 chartH");
eq(geo.bars[1].h, 63, "一半的柱高一半");
eq(geo.bars[2].h, 0, "零值就是零高柱（不画一小截假的）");
eq(geo.bars[0].x, 0, "第一根贴左边");
eq(Math.round(geo.bars[1].x), 205, "第二根 = 柱宽 + 间距（柱宽 = (600 - 14*2)/3）");
eq(geo.bars[0].y, geo.baseY - 126, "柱顶 = 底线 - 柱高");
eq(Math.round(geo.bars[0].w), 191, "柱宽按根数平分（(600 - 28) / 3）");
eqDeep(trendBars([], { width: 600, height: 180 }).bars, [], "没数据给空柱数组");
eq(trendBars(null, {}).bars.length, 0, "传 null 不炸");
const geoDefault = trendBars([{ month: "m", value: 7 }], {});
eq(geoDefault.bars[0].value, 7, "没给 value 取值函数时认行上的 value 字段");

console.log("\n【热力图的格子：一周一列、最后一列是本周】");
// 2026-10-14 是周三 → 那一周的周一是 2026-10-12
const cells = heatGrid("2026-10-14", 3);
eq(cells.length, 21, "3 周 × 7 天 = 21 格");
eq(cells[0].date, "2026-09-28", "第一格是两周前的周一（10-12 往前 14 天）");
eq(cells[0].row, 0, "第一格在第一行（周一）");
eq(cells[6].date, "2026-10-04", "第一列最后一格是那一周的周日");
eq(cells[7].date, "2026-10-05", "第二列从下一周周一开始（按列返回）");
eq(cells[20].date, "2026-10-18", "最后一格是本周的周日（今天是周三，周日还没到）");
eq(cells.find((c) => c.date === "2026-10-14").inRange, true, "今天算在范围内");
eq(cells.find((c) => c.date === "2026-10-18").inRange, false, "本周还没到的日子标成 out");
eq(cells.filter((c) => c.inRange).length, 17, "3 周里到今天就 17 天（前两周 14 天 + 本周 3 天）");
eq(heatGrid("2026-10-14", 26).length, 182, "26 周 = 182 格");
eq(heatGrid("2026-10-14", 0).length, 7, "周数写 0 也至少给一周（不画空网格）");

console.log("\n【热力分档：0 元最浅、最贵的最高档、中间单调】");
eq(heatLevelOf(0, 10000), 0, "零支出停在最浅那一档");
eq(heatLevelOf(100, 10000), 1, "有一点就是第 1 档");
eq(heatLevelOf(10000, 10000), 4, "最贵的那天落到最高档（默认 5 档）");
eq(heatLevelOf(20000, 10000), 4, "超过最大值也封顶");
eq(heatLevelOf(5000, 0), 0, "最大值是 0 时全给 0 档（不除零）");
eq(heatLevelOf(30, 100, 3) <= 2 && heatLevelOf(30, 100, 3) >= 1, true,
  "档数能指定（3 档时落在 1~2 里）");
const ladder = [0, 1, 100, 1000, 5000, 10000].map((v) => heatLevelOf(v, 10000));
eqDeep(ladder, [...ladder].sort((a, b) => a - b), "金额越大档位不会更低（单调）");
eqDeep(ladder, [0, 1, 1, 1, 3, 4], "具体档位：0 → 0，几百 → 1，一半 → 3，满 → 4");

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
