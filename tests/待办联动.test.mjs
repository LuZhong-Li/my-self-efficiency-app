/* 待办跨模块联动的纯逻辑测试：只测 app/web/task-calc.js。
 * 跑法：node tests\待办联动.test.mjs   （本机 Node v24，不需要 package.json）
 * 说明：和别的 .test.mjs 一样，不进「自检.cmd」——自检是给用户一键跑的，保持纯 Python。 */

import {
  PRIORITY_CLASS, priorityClass, taskArchived, taskOwnerOf, devProjectOf,
  inTodayPlan, taskSourceLabel, sortPlanTasks, planTasksOf, planStatsOf,
} from "../app/web/task-calc.js";

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

const TODAY = "2026-10-08";

console.log("\n【优先级胶囊】");
eq(priorityClass("高"), "pri-high", "高 → 红");
eq(priorityClass("中"), "pri-mid", "中 → 橙");
eq(priorityClass("低"), "pri-low", "低 → 绿");
eq(priorityClass(""), "", "没标优先级就不画那个胶囊");
eq(priorityClass(undefined), "", "字段都没有也不画（老数据不会出错）");
eqDeep(PRIORITY_CLASS, { 高: "pri-high", 中: "pri-mid", 低: "pri-low" }, "三档的样式名就这三个");

console.log("\n【归档与归属】");
eq(taskArchived({ isArchived: true }), true, "标了 isArchived 就是归档了");
eq(taskArchived({}), false, "老数据缺这个字段当没归档");
eq(taskArchived(null), false, "空记录不抛错");
eq(taskOwnerOf({ belong: "plan" }), "plan", "今日计划自己的任务");
eq(taskOwnerOf({}), "plan", "缺 belong 的老任务算今日计划自己的");
eq(taskOwnerOf({ belong: "goal" }), "plan", "模块目标生成的任务也能在今日计划里直接删");
eq(taskOwnerOf({ belong: "dev:p1" }), "dev", "挂在项目上的待办是外来的");
eq(devProjectOf({ belong: "dev:p1" }), "p1", "能算出它挂在哪个项目上");
eq(devProjectOf({ belong: "plan" }), "", "不是开发待办就没有项目 id");

console.log("\n【今天要不要出现在今日计划】");
eq(inTodayPlan({ date: TODAY }, TODAY), true, "日期是今天的任务在今日计划里");
eq(inTodayPlan({ date: "2026-10-07" }, TODAY), false, "昨天的任务不在今天这一列");
eq(inTodayPlan({ date: "2026-10-09" }, TODAY), false, "明天的也不在");
eq(inTodayPlan({ date: TODAY, isArchived: true }, TODAY), false, "归档的不占今日计划");
eq(inTodayPlan({ belong: "dev:p1", date: TODAY }, TODAY), true,
  "开发待办勾了「加入今日计划」（日期盖成今天）就出现在今日计划里");
eq(inTodayPlan({ belong: "dev:p1", isTodayPlan: true, date: "" }, TODAY), true,
  "标了开关但还没日期，也认（兜底）");
eq(inTodayPlan({ belong: "dev:p1", isTodayPlan: true, date: "2026-10-07" }, TODAY), false,
  "日期是昨天的（没做完挪过来那种）不重复出现在今天这一列");
eq(inTodayPlan({ belong: "dev:p1", date: "" }, TODAY), false, "没加入今日计划的开发待办不越界");
eq(inTodayPlan(null, TODAY), false, "空记录不抛错");

console.log("\n【来源标签】");
eq(taskSourceLabel({ belong: "dev:p1" }), "开发待办", "开发待办挂「开发待办」");
eq(taskSourceLabel({ belong: "goal", sourceModule: "fitness" }), "健身目标任务",
  "模块目标生成的还按老样子挂「健身目标任务」");
eq(taskSourceLabel({ belong: "plan", sourceModule: "game" }), "游戏娱乐",
  "游戏娱乐顺手加的那条挂「游戏娱乐」");
eq(taskSourceLabel({ belong: "goal" }), "模块目标", "只有 belong 没 sourceModule 时的兜底");
eq(taskSourceLabel({ belong: "plan" }), "", "今日计划自己的任务不挂来源标签");

console.log("\n【排序】");
const rows = [
  { id: "a", date: TODAY, time: "", done: false, createdAt: "2026-10-08T09:00:00" },
  { id: "b", date: TODAY, time: "08:00", done: false, createdAt: "2026-10-08T09:00:00" },
  { id: "c", date: TODAY, time: "", done: true, createdAt: "2026-10-08T09:00:00" },
  { id: "d", date: TODAY, time: "07:00", done: true, createdAt: "2026-10-08T09:00:00" },
];
eqDeep(rows.slice().sort(sortPlanTasks).map((r) => r.id), ["b", "a", "d", "c"],
  "没做完的在前；各自的按时间点，没填的排后面；做完的一律垫底");

console.log("\n【今日计划那一列 + 统计】");
const all = [
  { id: "t1", belong: "plan", date: TODAY, time: "09:00", done: true },
  { id: "t2", belong: "plan", date: TODAY, time: "", done: false },
  { id: "t3", belong: "dev:p1", date: TODAY, time: "10:00", done: false },
  { id: "t4", belong: "dev:p1", date: "", done: false },
  { id: "t5", belong: "plan", date: "2026-10-07", done: false },
  { id: "t6", belong: "plan", date: TODAY, done: false, isArchived: true },
];
const mine = planTasksOf(all, TODAY);
eqDeep(mine.map((t) => t.id), ["t3", "t2", "t1"],
  "跨模块加进来的和今日计划自己的排在一起（没做完的按时间点，做完的垫底）");
eqDeep(planStatsOf(mine), { total: 3, done: 1, open: 2, untimed: 1, percent: 33 },
  "顶部那几个数：未完成 2 / 已完成 1 / 待安排 1 / 33%");
eqDeep(planStatsOf([]), { total: 0, done: 0, open: 0, untimed: 0, percent: 0 },
  "一条都没有时是 0，不会算出 NaN");

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
