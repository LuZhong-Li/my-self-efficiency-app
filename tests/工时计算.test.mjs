/* 工时统计的纯逻辑测试：时长换算与显示、秒表（app/web/time-calc.js），
 * 以及工时自己的那套（app/web/work-calc.js）。
 * 跑法：node tests\工时计算.test.mjs   （本机 Node v24，不需要 package.json）
 * 说明：和别的 .test.mjs 一样，不进「自检.cmd」——自检是给用户一键跑的，保持纯 Python。 */

import {
  DURATION_UNITS, toMinutes, shownDuration, hoursOf, hoursText, durationText,
  elapsedMinutes, clockText,
} from "../app/web/time-calc.js";
import { durationText as durationTextFromGame } from "../app/web/game-calc.js";
import {
  normalizeWorkLog, workStatsOf, monthMinutesOf, byProjectOf, collapseRows, projectLabelOf,
} from "../app/web/work-calc.js";

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

console.log("\n【单位与换算】");
eqDeep(DURATION_UNITS, ["分钟", "小时"], "单位就两个：分钟 / 小时");
eq(toMinutes(90, "分钟"), 90, "按分钟填就是原样");
eq(toMinutes(2, "小时"), 120, "2 小时 → 120 分钟");
eq(toMinutes(1.5, "小时"), 90, "1.5 小时 → 90 分钟");
eq(toMinutes("2", "小时"), 120, "字符串数字也认（手填的数据）");
eq(toMinutes(-5, "小时"), 0, "负数当 0");
eq(toMinutes("", "小时"), 0, "空着当 0");
eq(toMinutes(2, "没见过的单位"), 2, "认不出的单位按分钟算");

console.log("\n【显示】");
eq(durationText(120), "2 小时", "整小时不啰嗦");
eq(durationText(90), "1 小时 30 分钟", "有零头就说全");
eq(durationText(45), "45 分钟", "不满一小时按分钟说");
eq(durationText(0), "—", "没填时长给一个占位");
eq(hoursText(0), "0 小时", "统计格里 0 也写出来（0 小时本身是有用的信息）");
eq(hoursText(120), "2 小时", "整点数不带小数点");
eq(hoursText(90), "1.5 小时", "零头保留一位");
eq(hoursOf(150), 2.5, "150 分钟 = 2.5 小时");
eqDeep(shownDuration(120), { amount: 2, unit: "小时" }, "整小时回填成「2 小时」");
eqDeep(shownDuration(90), { amount: 90, unit: "分钟" }, "零头按分钟回填");
eqDeep(shownDuration(0), { amount: 0, unit: "分钟" }, "0 按分钟回填");
eq(durationTextFromGame(90), "1 小时 30 分钟", "game-calc.js 那边只是转出（同一个函数）");

console.log("\n【秒表】");
eq(elapsedMinutes(0, Date.now()), 0, "没在计时就是 0");
eq(elapsedMinutes(1000, 1000), 0, "同一刻就是 0");
eq(elapsedMinutes(1000, 999), 0, "时间倒着走也当 0，不出负数");
eq(elapsedMinutes(1000, 1000 + 30 * 1000), 1, "半分钟也算至少 1 分钟");
eq(elapsedMinutes(1000, 1000 + 60 * 1000), 1, "整 1 分钟");
eq(elapsedMinutes(1000, 1000 + 90 * 1000), 2, "1 分 30 秒四舍五入成 2 分钟");
eq(clockText(1000000, 1000000 + (3600 + 754) * 1000), "01:12:34", "秒表上的 时:分:秒");
eq(clockText(0, 0), "00:00:00", "没在计时给一串零");
eq(clockText(1000000, 1000000 + 59 * 1000), "00:00:59", "没到一分钟只有秒在走");

console.log("\n【一条工时的形状】");
eqDeep(normalizeWorkLog({ id: "w1", date: "2026-10-14", projectId: "p1", minutes: "90",
  note: "写文档", tags: ["开发"], createdAt: "2026-10-14T10:00:00.000Z" }),
{ id: "w1", date: "2026-10-14", projectId: "p1", minutes: 90, note: "写文档",
  tags: ["开发"], createdAt: "2026-10-14T10:00:00.000Z" }, "字符串进来的分钟认得出");
eqDeep(normalizeWorkLog({}), { id: "", date: "", projectId: "", minutes: 0, note: "",
  tags: [], createdAt: "" }, "缺字段一律补默认值");
eq(normalizeWorkLog({ minutes: -5 }).minutes, 0, "负数当 0");
eq(normalizeWorkLog({ minutes: 90.4 }).minutes, 90, "分钟取整");
eqDeep(normalizeWorkLog({ tags: "开发, 本周" }).tags, [], "标签写得不是数组就当空的（不清洗、不猜）");
eqDeep(normalizeWorkLog(null), normalizeWorkLog({}), "传 null 和空对象一个样");

console.log("\n【四档汇总（周一起算）】");
const LOGS = [
  { id: "w1", date: "2026-10-07", projectId: "p1", minutes: 60 },   // 周三（今天）
  { id: "w2", date: "2026-10-07", projectId: "p1", minutes: 30 },   // 同一天第二条
  { id: "w3", date: "2026-10-05", projectId: "p2", minutes: 120 },  // 本周一
  { id: "w4", date: "2026-10-04", projectId: "p2", minutes: 45 },   // 上周日（不算本周）
  { id: "w5", date: "2026-09-30", projectId: "p1", minutes: 200 },  // 上个月
  { id: "w6", date: "", projectId: "p1", minutes: 999 },            // 没日期：只进累计
];
const ws = workStatsOf(LOGS, "2026-10-07");
eq(ws.todayMin, 90, "今日 = 10-07 那两条");
eq(ws.weekMin, 210, "本周（10-05 起）= 60 + 30 + 120");
eq(ws.monthMin, 255, "本月 = 10 月那四条");
eq(ws.allMin, 1454, "累计 = 全部（含没日期那条）");
eq(ws.count, 6, "条数");
eq(ws.days, 4, "天数（同一天两条只算一天；没日期的不算任何一天）");
eqDeep(workStatsOf([], "2026-10-07"), { todayMin: 0, weekMin: 0, monthMin: 0, allMin: 0,
  count: 0, days: 0 }, "一条都没有时全是 0");
eq(workStatsOf(null, "2026-10-07").count, 0, "传 null 不炸");

console.log("\n【按月的工时（给柱状图）】");
const MT = monthMinutesOf(LOGS, ["2026-08", "2026-09", "2026-10"]);
eqDeep(MT.map((r) => r.month), ["2026-08", "2026-09", "2026-10"], "几个月就几个点");
eqDeep(MT.map((r) => r.minutes), [0, 200, 255], "每个月加一加（没日期那条不进任何一个月）");
eqDeep(MT.map((r) => r.ratio), [0, 200 / 255, 1], "最高的那个月满格");
eqDeep(monthMinutesOf([], ["2026-10"]).map((r) => r.minutes), [0], "一条都没有时给零");
eqDeep(monthMinutesOf(null, null), [], "传 null 给空数组");

console.log("\n【按项目分布】");
const PROJECTS = [{ id: "p1", name: "小李（个人工作台）" }, { id: "p2", name: "木子工作台" }];
const by = byProjectOf(LOGS, PROJECTS);
eqDeep(by.map((r) => r.name), ["小李（个人工作台）", "木子工作台"], "按工时降序（1289 > 165）");
eq(by[0].minutes, 1289, "p1 是 60 + 30 + 200 + 999");
eq(by[0].count, 4, "p1 四条");
eq(by[0].ratio, 1, "第一名满格");
eq(by[1].ratio, 165 / 1289, "第二名按比例（不取整，条长直接用这个数）");
eq(by[1].share, Math.round((165 / 1454) * 1000) / 1000, "占比是相对总计的");
eqDeep(byProjectOf([{ id: "x", date: "2026-10-07", projectId: "", minutes: 30 },
  { id: "y", date: "2026-10-07", projectId: "p9", minutes: 60 }], PROJECTS)
  .map((r) => r.name), ["（项目已删）", "没记项目"], "项目没了 / 没记项目的都留一行，不凭空消失");
eqDeep(byProjectOf(null, null), [], "传 null 给空数组");
eqDeep(byProjectOf([{ id: "z", date: "", minutes: 5 }], []).map((r) => r.name), ["没记项目"],
  "没项目表的记录也在");

console.log("\n【分布太长时收一收】");
const manyRows = [
  { name: "a", minutes: 100 }, { name: "b", minutes: 90 }, { name: "c", minutes: 80 },
  { name: "d", minutes: 70 }, { name: "e", minutes: 60 }, { name: "f", minutes: 50 },
  { name: "g", minutes: 40 }, { name: "h", minutes: 30 },
];
const col = collapseRows(manyRows, 6);
eqDeep(col.shown.map((r) => r.name), ["a", "b", "c", "d", "e", "f"], "只画前 6 名");
eq(col.rest, 2, "剩下 2 个收成一行");
eq(col.restMinutes, 70, "剩下的合计 40 + 30");
eqDeep(collapseRows(manyRows.slice(0, 3), 6).shown.length, 3, "不够 6 个就都画出来");
eq(collapseRows(manyRows.slice(0, 3), 6).rest, 0, "没有剩下的");
eqDeep(collapseRows(null, 6), { shown: [], rest: 0, restMinutes: 0 }, "传 null 给空的");

console.log("\n【项目名怎么叫】");
eq(projectLabelOf("p1", PROJECTS), "小李（个人工作台）", "找得到就用真名");
eq(projectLabelOf("", PROJECTS), "没记项目", "没挑项目的");
eq(projectLabelOf("p9", PROJECTS), "（项目已删）", "项目没了");
eq(projectLabelOf(null, null), "没记项目", "传 null 不炸");

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
