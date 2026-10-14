/* 待办跨模块联动的纯逻辑测试：只测 app/web/task-calc.js。
 * 跑法：node tests\待办联动.test.mjs   （本机 Node v24，不需要 package.json）
 * 说明：和别的 .test.mjs 一样，不进「自检.cmd」——自检是给用户一键跑的，保持纯 Python。 */

import {
  PRIORITY_CLASS, priorityClass, taskArchived, taskOwnerOf, devProjectOf,
  inTodayPlan, taskSourceLabel, sortPlanTasks, planTasksOf, planStatsOf,
  overdueTasksOf,
  PLAN_GROUPS, moduleKeyOf, groupPlanTasks,
  DAILY_DEFAULTS, dailyTargetsOf, valueOf,
  subTasksOf, subtaskProgress, setSubtasksDone, subtaskTextOf,
  isRepeatRule, repeatRulesOf, repeatDueOn, genKeyOf, addDays, nextRepeatDay,
  planRepeatTasks,
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
eq(taskSourceLabel({ repeatId: "t-rule-1", belong: "plan" }), "重复任务",
  "重复规则生成的待办挂「重复任务」标签");
eq(taskSourceLabel({ sourceModule: "fitness", repeatId: "x" }), "重复任务",
  "重复任务优先于模块标签（规则是更直接的那个来源）");

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

console.log("\n【逾期那一列：归档的不算，也不该被「全部挪到今天」带走】");
const overdueInput = [
  { id: "o1", belong: "plan", date: "2026-10-05", time: "09:00", done: false },
  { id: "o2", belong: "plan", date: "2026-10-06", time: "", done: false },
  { id: "o3", belong: "plan", date: "2026-10-04", time: "08:00", done: false, isArchived: true },
  { id: "o4", belong: "plan", date: "2026-10-07", time: "", done: true },
  { id: "o5", belong: "plan", date: TODAY, time: "", done: false },
];
const overdue = overdueTasksOf(overdueInput, TODAY);
eqDeep(overdue.map((t) => t.id), ["o1", "o2"],
  "只留「过去 + 没做完 + 没归档」，按日期早晚排");
eq(overdueTasksOf(overdueInput, TODAY).some((t) => t.isArchived), false,
  "归档的旧待办不在逾期列里（以前「全部挪到今天」会把它一起改到今天）");
eq(overdueTasksOf([], TODAY).length, 0, "一条都没有时不抛错");
eq(overdueTasksOf(null, TODAY).length, 0, "传 null 也不抛错");

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

console.log("\n【子任务：清单、进度、整体勾选（2026-10-14 加的）】");
const withSubs = { id: "t-s", text: "把工作台改版做完", subtasks: [
  { id: "st-1", text: "改侧栏", done: true },
  { id: "st-2", text: "改首页卡片", done: false },
] };
eq(subTasksOf(withSubs).length, 2, "两条子任务都读得到");
eqDeep(subTasksOf({ id: "t", subtasks: "不是数组" }), [], "subtasks 不是数组就当空的、不抛错");
eqDeep(subTasksOf(null), [], "空记录不抛错");
eqDeep(subtaskProgress(withSubs), { done: 1, total: 2, percent: 50 }, "1 / 2 → 50%");
eqDeep(subtaskProgress({ id: "t" }), { done: 0, total: 0, percent: 0 },
  "没清单时分母是 0、百分比 0（不是 NaN）");
eqDeep(setSubtasksDone(withSubs, true), [
  { id: "st-1", text: "改侧栏", done: true },
  { id: "st-2", text: "改首页卡片", done: true },
], "整体勾上：返回一份新的、两条都 done");
eqDeep(setSubtasksDone(withSubs, false).map((s) => s.done), [false, false], "整体取消：两条都 false");
eq(withSubs.subtasks[1].done, false, "setSubtasksDone 不改传进去的那条（纯函数）");
eq(subtaskTextOf(withSubs), "改侧栏 改首页卡片", "子任务的文字拼成一段（进搜索池用）");
eq(subtaskTextOf({ id: "t" }), "", "没子任务给空串");

console.log("\n【重复任务：认规则、算日子（2026-10-14 加的）】");
const RULE = { id: "t-rule-1", text: "跑步 5 公里", date: "", repeat: "每周一、三、五" };
eq(isRepeatRule(RULE), true, "repeat 有内容 + 不占日期 = 规则");
eq(isRepeatRule({ id: "t1", text: "普通待办", date: "2026-10-14" }), false, "有日期的普通待办不是规则");
eq(isRepeatRule({ id: "t2", date: "", repeat: "" }), false, "repeat 空着不是规则");
eq(isRepeatRule({ id: "t3", date: "", repeat: "每天", isArchived: true }), false, "归档了的规则不算数");
eq(isRepeatRule(null), false, "空记录不抛错");
eq(repeatRulesOf([RULE, { id: "t1", date: "2026-10-14" }, null]).length, 1,
  "从一堆待办里只挑得出规则那一条");
eq(repeatDueOn(RULE, "2026-10-14"), true, "2026-10-14 是周三 → 该做");
eq(repeatDueOn(RULE, "2026-10-15"), false, "周四不在规则里");
eq(repeatDueOn({ ...RULE, repeatUntil: "2026-10-13" }, "2026-10-14"), false, "过了 repeatUntil 就停");
eq(genKeyOf(RULE, "2026-10-14"), "repeat:t-rule-1:2026-10-14", "防重键的拼法固定");

eq(addDays("2026-10-14", 1), "2026-10-15", "跨日");
eq(addDays("2026-10-31", 1), "2026-11-01", "跨月");
eq(addDays("2026-12-31", 1), "2027-01-01", "跨年");
eq(nextRepeatDay(RULE, "2026-10-14"), "2026-10-16", "周三之后的下一天是周五");
eq(nextRepeatDay({ id: "r", repeat: "每天" }, "2026-10-14"), "2026-10-15", "每天 → 明天");
eq(nextRepeatDay({ id: "r", repeat: "每月 1 号" }, "2026-10-14"), "2026-11-01", "每月 1 号 → 下个月 1 号");
eq(nextRepeatDay({ id: "r", repeat: "每月 1 号" }, "2026-12-05"), "2027-01-01", "跨年找得到");
eq(nextRepeatDay({ id: "r", repeat: "每周一" }, "2026-10-15"), "2026-10-19", "周四 → 下周一");
eq(nextRepeatDay({ id: "r", repeat: "每周一", repeatUntil: "2026-10-16" }, "2026-10-15"), "",
  "后面没有了就是空串（卡片上不画「下次」）");
eq(nextRepeatDay({ id: "r", repeat: "" }, "2026-10-14"), "", "不是规则给空串");

console.log("\n【重复任务：今天该补哪几条（2026-10-14 加的）】");
const plan1 = planRepeatTasks([RULE], [{ ...RULE }], "2026-10-14");
eq(plan1.newTasks.length, 1, "周三该生成一条");
eq(plan1.newTasks[0].date, "2026-10-14", "生成的那条日期就是今天");
eq(plan1.newTasks[0].text, "跑步 5 公里", "正文照抄规则");
eq(plan1.newTasks[0].genKey, "repeat:t-rule-1:2026-10-14", "带着防重键");
eq(plan1.newTasks[0].repeatId, "t-rule-1", "带着来源规则 id");
eq(plan1.newTasks[0].belong, "plan", "落进今日计划");
eq(Boolean(plan1.newTasks[0].repeat), false, "实例身上不带 repeat（不然它自己也成了规则）");
eqDeep(plan1.markRun, ["t-rule-1"], "这条规则今天对过表了，要记 lastRun");

const again = planRepeatTasks([RULE], [{ ...RULE, genKey: "repeat:t-rule-1:2026-10-14" }], "2026-10-14");
eq(again.newTasks.length, 0, "今天已经有了就不再加一条");
eqDeep(again.markRun, ["t-rule-1"], "已经生成过也算对过表");

const afterRun = planRepeatTasks([{ ...RULE, lastRun: "2026-10-14" }], [{ ...RULE }], "2026-10-14");
eq(afterRun.newTasks.length, 0, "lastRun 是今天就一条都不补（你自己删掉的那条不回来）");
eqDeep(afterRun.markRun, [], "也不用再记一遍");

const notDue = planRepeatTasks([RULE], [{ ...RULE }], "2026-10-15");
eq(notDue.newTasks.length, 0, "周四不该生成");
eqDeep(notDue.markRun, [], "不是它的日子就不记 lastRun");

const inherit = planRepeatTasks(
  [{ ...RULE, priority: "中", category: "运动", note: "穿跑鞋", tags: ["运动"],
     subtasks: [{ id: "st-9", text: "换跑鞋", done: true }] }],
  [],
  "2026-10-14"
);
eq(inherit.newTasks[0].priority, "中", "优先级继承");
eq(inherit.newTasks[0].category, "运动", "分类继承");
eq(inherit.newTasks[0].note, "穿跑鞋", "备注继承");
eqDeep(inherit.newTasks[0].tags, ["运动"], "标签继承");
eqDeep(inherit.newTasks[0].subtasks, [{ id: "", text: "换跑鞋", done: false }],
  "子任务抄一份过来、勾选从零开始（id 留给上屏那边补）");
eqDeep(inherit.newTasks[0].imagePaths, [], "图片不继承（共用一个路径会误删规则那张图）");
eq(RULE.id, "t-rule-1", "planRepeatTasks 不改传进来的规则");
eq(planRepeatTasks(null, null, "2026-10-14").newTasks.length, 0, "传 null 不炸");

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
