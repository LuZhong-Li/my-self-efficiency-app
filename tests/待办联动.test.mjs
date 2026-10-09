/* 待办跨模块联动的纯逻辑测试：只测 app/web/task-calc.js。
 * 跑法：node tests\待办联动.test.mjs   （本机 Node v24，不需要 package.json）
 * 说明：和别的 .test.mjs 一样，不进「自检.cmd」——自检是给用户一键跑的，保持纯 Python。 */

import {
  PRIORITY_CLASS, priorityClass, taskArchived, taskOwnerOf, devProjectOf,
  inTodayPlan, taskSourceLabel, sortPlanTasks, planTasksOf, planStatsOf,
  PLAN_GROUPS, moduleKeyOf, groupPlanTasks,
  DAILY_DEFAULTS, dailyTargetsOf, valueOf,
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

console.log("\n【按模块分组（各模块今日进度）】");
eq(moduleKeyOf({ belong: "goal", sourceModule: "fitness" }), "fitness", "目标生成的算健身");
eq(moduleKeyOf({ belong: "plan", sourceModule: "game" }), "game", "游戏顺手加的算游戏娱乐");
eq(moduleKeyOf({ belong: "dev:p1" }), "dev", "开发待办算开发工作（看 belong）");
eq(moduleKeyOf({ belong: "plan" }), "", "今日计划自己加的没有模块");
eq(moduleKeyOf({ belong: "plan", sourceModule: "记账" }), "", "认不出的来源也算没模块");
eq(moduleKeyOf(null), "", "空记录不抛错");
eqDeep(PLAN_GROUPS.map((g) => g.key), ["fitness", "study", "diet", "dev", "game"],
  "五个模块的顺序就这个（首页行和今日计划分组都照它排）");

const grouped = groupPlanTasks([
  { id: "s1", belong: "goal", sourceModule: "study", done: true },
  { id: "s2", belong: "goal", sourceModule: "study", done: false },
  { id: "f1", belong: "goal", sourceModule: "fitness", done: false },
  { id: "d1", belong: "dev:p1", done: true },
  { id: "d2", belong: "dev:p1", done: false },
  { id: "p1", belong: "plan", done: false },
]);
eq(grouped.groups.map((g) => g.key).join(","), "fitness,study,dev",
  "只出有内容的组，且按固定顺序排");
eqDeep(grouped.loose.map((t) => t.id), ["p1"], "没有模块的待办进 loose（今日计划自己加的）");
const study = grouped.groups.find((g) => g.key === "study");
eq(study.total, 2, "学习这组 2 条");
eq(study.done, 1, "学习完成 1 条");
eq(study.percent, 50, "学习 50%");
eq(study.level, "blue", "50% 蓝档");
eq(study.name, "学习", "组名");
eq(study.icon, "study", "组图标名");
eq(grouped.groups.find((g) => g.key === "fitness").percent, 0, "健身 0/1 → 0%");
eq(grouped.groups.find((g) => g.key === "dev").percent, 50, "开发 1/2 → 50%");
const doneAll = groupPlanTasks([
  { id: "x", belong: "goal", sourceModule: "diet", done: true },
  { id: "y", belong: "goal", sourceModule: "diet", done: true },
]);
eq(doneAll.groups[0].percent, 100, "全做完 100%");
eq(doneAll.groups[0].level, "green", "100% 绿档");
eq(groupPlanTasks([]).groups.length, 0, "空数据不出组");
eq(groupPlanTasks([]).loose.length, 0, "空数据 loose 也是空");

console.log("\n【今日目标配置：类型 / 目标值 / 单位 / 步长】");
eqDeep(dailyTargetsOf({}).study, { type: "count", targetValue: 0, unit: "项", step: 1 },
  "没配过的模块走默认（数量 / 按计划数 / 项 / 步长 1）");
const cfgs = dailyTargetsOf({
  settings: { dailyTargets: { study: { type: "time", targetValue: 120, unit: "分钟", step: 30 } } },
});
eq(cfgs.study.type, "time", "学习配成时长型");
eq(cfgs.study.targetValue, 120, "目标 120");
eq(cfgs.study.unit, "分钟", "单位换成分钟");
eq(cfgs.study.step, 30, "步长 30");
eq(cfgs.fitness.targetValue, 0, "没配的模块目标值还是 0");
eqDeep(
  dailyTargetsOf({ settings: { dailyTargets: { study: { type: "x", targetValue: -5, unit: "", step: 0 } } } }).study,
  { type: "count", targetValue: 0, unit: "项", step: 1 },
  "脏配置兜回默认（认不出的类型 / 负数 / 空单位 / 0 步长）"
);

console.log("\n【按 value 汇总 + 超额】");
eq(valueOf({ done: true }, { type: "count" }), 1, "没写 value 的数量条目算 1");
eq(valueOf({ value: 120 }, { type: "time", step: 30 }), 120, "写了 value 就用它");
eq(valueOf({}, { type: "time", step: 30 }), 30, "没写 value 的时长条目算一个步长");
eq(valueOf({ value: 45 }, { type: "time", step: 30 }), 45, "时长支持小数 / 零头（45 分钟）");

const timedRows = [
  { id: "s1", belong: "goal", sourceModule: "study", done: true },
  { id: "s2", belong: "goal", sourceModule: "study", done: false },
];
const st = groupPlanTasks(timedRows, cfgs).groups.find((g) => g.key === "study");
eq(st.type, "time", "学习组按时长算");
eq(st.unit, "分钟", "单位是分钟");
eq(st.target, 120, "目标用配置值 120");
eq(st.current, 30, "完成 1 条 = 30 分钟（没写 value 就记一个步长）");
eq(st.percent, 25, "30 / 120 = 25%");
eq(st.over, false, "没超额");
eq(st.level, "blue", "25% 蓝档");

const over = groupPlanTasks(
  [
    { id: "a", belong: "goal", sourceModule: "study", done: true, value: 120 },
    { id: "b", belong: "plan", sourceModule: "study", done: true, value: 30 },
  ],
  cfgs
).groups.find((g) => g.key === "study");
eq(over.current, 150, "完成值相加 120 + 30 = 150");
eq(over.target, 120, "目标仍是 120");
eq(over.percent, 125, "150 / 120 = 125%");
eq(over.over, true, "超额了");
eq(over.level, "green", "超额 → 满格绿色");

const emptyConfigured = groupPlanTasks([], cfgs);
eq(emptyConfigured.groups.length, 1, "配了目标值的模块，哪怕今天没条目也出一组");
eq(emptyConfigured.groups[0].key, "study", "出的就是学习这组");
eq(emptyConfigured.groups[0].current, 0, "还没完成，current 0");
eq(emptyConfigured.groups[0].target, 120, "目标 120");
eq(emptyConfigured.groups[0].percent, 0, "进度 0（不显示 NaN）");

console.log("\n【超额时 target 不会被 100% 截断】");
eq(groupPlanTasks([{ id: "x", belong: "goal", sourceModule: "fitness", done: true }], {})
  .groups[0].percent, 100, "没配目标时，全部做完就是 100%");

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
