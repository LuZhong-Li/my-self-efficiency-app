/* 模块目标的纯逻辑测试：目标结构 / 规则解析 / 自动生成 / 进度。
 * 跑法：node tests\目标计算.test.mjs   （本机 Node v24，不需要 package.json）
 * 说明：这个测试不进「自检.cmd」——自检是给用户一键跑的，保持纯 Python。 */

import {
  GOAL_MODULES, GOAL_CYCLES, WEEKDAY_NAMES, goalModuleOf, sourceLabelOf, categoryOf,
  weekdayOf, dayOfMonth, weekStartOf, weekRangeOf,
  normalizeGoal, rawGoals, allGoals, ensureBucket,
  parseRule, clauseMatches, previewDays, rulePreview, ruleSummary,
  isActiveOn, tasksForDate, planGoalTasks, progressOf, cycleText,
} from "../app/web/goal-calc.js";

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

function ok(cond, label) {
  eq(Boolean(cond), true, label);
}

/* ---------------- 词表与模块 ---------------- */

eqDeep(GOAL_MODULES.map((m) => m.id), ["fitness", "study", "diet"], "三个能用目标的模块");
eqDeep(GOAL_CYCLES, ["每日", "每周", "月度", "自定义起止日期"], "四个周期选项");
eq(goalModuleOf("fitness").name, "健身计划", "fitness 的显示名");
eq(goalModuleOf("nope"), null, "认不出的模块给 null");
eq(sourceLabelOf("fitness"), "健身目标任务", "健身的待办来源标签");
eq(sourceLabelOf("study"), "学习目标任务", "学习的来源标签");
eq(sourceLabelOf("diet"), "饮食目标任务", "饮食的来源标签");
eq(sourceLabelOf("nope"), "模块目标任务", "认不出的模块也有个兜底标签");
eq(categoryOf("fitness"), "运动", "健身的待办归到「运动」");
eq(categoryOf("study"), "学习", "学习的待办归到「学习」");
eq(categoryOf("diet"), "生活", "饮食的待办归到「生活」");
eq(categoryOf("nope"), "其他", "认不出的模块归「其他」");

/* ---------------- 日期小工具 ---------------- */

eq(weekdayOf("2026-10-07"), 3, "2026-10-07 是周三");
eq(weekdayOf("2026-10-11"), 0, "2026-10-11 是周日");
eq(dayOfMonth("2026-10-07"), 7, "取号数");
eq(weekStartOf("2026-10-07"), "2026-10-05", "周三所在周的周一是 10-05");
eq(weekStartOf("2026-10-11"), "2026-10-05", "周日也算上一周（周一起算）");
eqDeep(weekRangeOf("2026-10-07"), { start: "2026-10-05", end: "2026-10-11" }, "这一周的起止");
eq(WEEKDAY_NAMES[3], "周三", "星期名字表");

/* ---------------- 补齐一条目标 ---------------- */

const filled = normalizeGoal({ mainTarget: "减重 8kg" }, "fitness");
eq(filled.moduleId, "fitness", "缺 moduleId 时按传进来的模块补");
eq(filled.moduleName, "健身计划", "模块名也补齐");
eq(filled.cycle, "每日", "认不出的周期按每日算");
eq(filled.isActive, true, "开关缺省是开");
eq(filled.autoTask, true, "自动生成缺省也是开");
eqDeep(Object.keys(filled), [
  "id", "moduleId", "moduleName", "mainTarget", "cycle", "startDate", "endDate",
  "dailyRule", "remark", "isActive", "autoTask", "lastRun",
], "字段一个都不少，顺序固定");
eq(normalizeGoal({ isActive: false, autoTask: false }, "study").isActive, false, "明确关掉就是关");
eq(normalizeGoal({ cycle: "年度" }, "study").cycle, "每日", "四个周期以外的值按每日兜底");
eq(normalizeGoal(null, "diet").moduleId, "diet", "传 null 也能兜出一份空的");
eq(normalizeGoal({}, "diet").moduleName, "饮食计划", "空对象按模块补名字");

/* ---------------- 从数据里取目标 ---------------- */

const data = {
  moduleGoals: {
    fitness: [{ id: "g1", mainTarget: "减脂" }],
    study: [{ id: "g2", mainTarget: "每天两小时" }],
  },
};
eq(rawGoals(data, "fitness").length, 1, "取 fitness 那一桶");
eq(rawGoals(data, "study")[0].id, "g2", "取 study 那一桶");
eqDeep(rawGoals(data, "diet"), [], "diet 还没设目标就是空数组");
eq(allGoals(data).length, 2, "三个模块的目标合起来数");
eqDeep(rawGoals({}, "fitness"), [], "没有 moduleGoals 这个键也不报错");
eqDeep(rawGoals({ moduleGoals: null }, "fitness"), [], "moduleGoals 是 null 也不报错");
eq(rawGoals({ moduleGoals: [{ id: "g9", moduleId: "fitness" }] }, "fitness").length, 1,
  "moduleGoals 整个写成数组也认得出来");

// 老形状：一个模块直接放一个对象（不是数组）
const oldShape = { moduleGoals: { fitness: { id: "g1", mainTarget: "减脂" } } };
eq(ensureBucket(oldShape, "fitness").length, 1, "一个模块放单个对象时，读的时候包成数组");
ok(Array.isArray(oldShape.moduleGoals.fitness), "包完之后那一桶就变成数组了");

// 老形状：整个 moduleGoals 写成数组，按 moduleId 归桶
const arrayShape = {
  moduleGoals: [
    { id: "a", moduleId: "fitness", mainTarget: "x" },
    { id: "b", moduleId: "study", mainTarget: "y" },
  ],
};
eq(ensureBucket(arrayShape, "study").length, 1, "数组形状按 moduleId 归到对应的桶");
eq(arrayShape.moduleGoals.fitness.length, 1, "另一桶也留住了");
eqDeep(Object.keys(arrayShape.moduleGoals).sort(), ["fitness", "study"], "两条都不丢");

const blank = {};
eqDeep(ensureBucket(blank, "fitness"), [], "空数据：第一读就建好一个空桶");
eqDeep(blank.moduleGoals, { fitness: [] }, "桶的形状写进数据里了");

/* ---------------- 规则解析：星期几 ---------------- */

const 健身规则 = "每周一、三、五力量训练；周二、四有氧";
eq(parseRule(健身规则).length, 2, "分号切开是两条规则");
eqDeep(parseRule(健身规则)[0].weekdays, [1, 3, 5], "第一条认出一、三、五");
eq(parseRule(健身规则)[0].text, "力量训练", "第一条的任务文字只剩力量训练");
eqDeep(parseRule(健身规则)[1].weekdays, [2, 4], "第二条认出二、四");
eq(parseRule(健身规则)[1].text, "有氧", "第二条的任务文字是有氧");

eqDeep(parseRule("周一跑步")[0].weekdays, [1], "单说周一");
eqDeep(parseRule("星期一跑步")[0].weekdays, [1], "「星期一」也认");
eqDeep(parseRule("礼拜天休息")[0].weekdays, [0], "「礼拜天」是周日");
eqDeep(parseRule("每周日复盘")[0].weekdays, [0], "每周日也是周日");
eqDeep(parseRule("周1 跑步")[0].weekdays, [1], "写成阿拉伯数字也认");
eqDeep(parseRule("每周一三五力量训练")[0].weekdays, [1, 3, 5], "一三五连着写也认");
eq(parseRule("每周一三五力量训练")[0].text, "力量训练", "连着写时任务文字也对");
eqDeep(parseRule("周一和周三游泳")[0].weekdays, [1, 3], "用「和」连起来也认");
eqDeep(parseRule("周二/周四有氧")[0].weekdays, [2, 4], "用斜杠连也认");
eqDeep(parseRule("每周三30分钟跳绳")[0].weekdays, [3], "「30 分钟」里的 3 不算星期");
eq(parseRule("每周三30分钟跳绳")[0].text, "30分钟跳绳", "数字留在任务文字里");
eqDeep(parseRule("每周三 三组深蹲")[0].weekdays, [3], "后面那个「三组」不算星期");

/* ---------------- 规则解析：每天 / 每月 / 拆分 ---------------- */

eq(parseRule("每天学习2小时")[0].everyDay, true, "「每天」认出来");
eq(parseRule("每天学习2小时")[0].text, "学习2小时", "每天的任务文字");
eq(parseRule("每日背单词")[0].everyDay, true, "「每日」也认");
eqDeep(parseRule("每月1号交房租")[0].monthlyDays, [1], "每月 1 号");
eq(parseRule("每月1号交房租")[0].text, "交房租", "每月的任务文字");
eqDeep(parseRule("每月15号对账")[0].monthlyDays, [15], "每月 15 号");
eq(parseRule("周一跑步，周二游泳").length, 2, "逗号两边各自带时间词就拆成两条");
eq(parseRule("晚7点-9点学习").length, 1, "没有时间词的一整句不拆");
eq(parseRule("晚7点-9点学习")[0].text, "晚7点-9点学习", "没有时间词时整句都是任务文字");
eqDeep(parseRule(""), [], "规则空着就一条都不生成");
eqDeep(parseRule("   "), [], "只有空格也当没有");

eq(parseRule("每周一三五自动生成【力量训练】待办到今日计划")[0].text, "力量训练",
  "「自动生成…待办到今日计划」这些连接词和括号都去掉");
eq(parseRule("每天背单词（30 分钟）")[0].text, "背单词（30 分钟）",
  "圆括号里的是补充说明，原样留着（方括号那种是标记，才去掉）");

/* ---------------- 规则预览 ---------------- */

eq(previewDays(parseRule(健身规则)[0]), "每周一、周三、周五", "预览：星期几那半句");
eq(previewDays(parseRule("每天学习")[0]), "每天", "预览：每天");
eq(previewDays(parseRule("每月1号交房租")[0]), "每月 1 号", "预览：每月几号");
eq(previewDays(parseRule("晚7点-9点学习")[0], { cycle: "每日" }), "每天",
  "没写时间词时按周期兜底：每日");
eq(previewDays(parseRule("跑步")[0], { cycle: "每周", startDate: "2026-10-07" }), "每周三",
  "每周：按开始日期那天");
eq(previewDays(parseRule("跑步")[0], { cycle: "月度", startDate: "2026-10-07" }), "每月 7 号",
  "月度：按开始日期那个号");
eq(ruleSummary(健身规则), "每周一、周三、周五 力量训练；每周二、周四 有氧", "整句预览");
eq(ruleSummary("每天学习2小时"), "每天 学习2小时", "单条规则的预览");
eq(ruleSummary("", {}), "", "没有规则就是空串");

/* ---------------- 有效性 ---------------- */

const goalBase = {
  id: "g1", moduleId: "fitness", cycle: "每日",
  startDate: "2026-10-01", endDate: "2026-10-31", isActive: true, autoTask: true,
  dailyRule: "每天跑步",
};
eq(isActiveOn(goalBase, "2026-10-07"), true, "在起止之间就是有效的");
eq(isActiveOn(goalBase, "2026-09-30"), false, "开始日期之前不算");
eq(isActiveOn(goalBase, "2026-11-01"), false, "结束日期之后不算");
eq(isActiveOn({ ...goalBase, isActive: false }, "2026-10-07"), false, "关掉的目标不算");
eq(isActiveOn({ ...goalBase, startDate: "", endDate: "" }, "2030-01-01"), true, "没填起止就是一直有效");

/* ---------------- 今天该生成什么 ---------------- */

const 健身目标 = {
  id: "g-fit", moduleId: "fitness", moduleName: "健身计划",
  mainTarget: "三个月减 8kg", cycle: "月度",
  startDate: "2026-10-01", endDate: "2026-12-31",
  dailyRule: 健身规则, isActive: true, autoTask: true,
};
// 2026-10-05 是周一、10-06 周二、10-07 周三
eqDeep(tasksForDate(健身目标, "2026-10-05").map((t) => t.text), ["力量训练"], "周一生成力量训练");
eqDeep(tasksForDate(健身目标, "2026-10-06").map((t) => t.text), ["有氧"], "周二生成有氧");
eqDeep(tasksForDate(健身目标, "2026-10-07").map((t) => t.text), ["力量训练"], "周三还是力量训练");
eqDeep(tasksForDate(健身目标, "2026-10-11").map((t) => t.text), [], "周日什么都不生成");
eq(tasksForDate(健身目标, "2026-10-05")[0].key, "g-fit@2026-10-05#0", "生成键里有目标、日期、第几条");
eq(tasksForDate(健身目标, "2026-10-05")[0].goalId, "g-fit", "待办上记着是哪条目标");
eq(tasksForDate(健身目标, "2026-10-05")[0].moduleId, "fitness", "待办上记着哪个模块");
eqDeep(tasksForDate({ ...健身目标, autoTask: false }, "2026-10-05"), [], "关了自动生成就不生成");
eqDeep(tasksForDate({ ...健身目标, isActive: false }, "2026-10-05"), [], "关了目标也不生成");
eqDeep(tasksForDate(健身目标, "2026-09-30"), [], "开始之前不生成");
eqDeep(tasksForDate({ ...健身目标, dailyRule: "" }, "2026-10-05"), [], "没写规则就不生成");
eq(tasksForDate({ ...健身目标, dailyRule: "" , id: "g2" }, "2026-10-05").length, 0, "没规则时也不给兜底文字");

const 学习目标 = {
  id: "g-st", moduleId: "study", cycle: "每日",
  startDate: "2026-10-01", endDate: "", dailyRule: "晚7点-9点学习", isActive: true, autoTask: true,
};
eqDeep(tasksForDate(学习目标, "2026-10-07").map((t) => t.text), ["晚7点-9点学习"],
  "每日目标每天都生成");
eqDeep(tasksForDate(学习目标, "2026-10-08").map((t) => t.text), ["晚7点-9点学习"],
  "第二天照样生成");

const 每周目标 = {
  id: "g-w", moduleId: "fitness", cycle: "每周",
  startDate: "2026-10-05", endDate: "", dailyRule: "跑步", isActive: true, autoTask: true,
};
eqDeep(tasksForDate(每周目标, "2026-10-05").map((t) => t.text), ["跑步"], "每周：开始那天生成");
eqDeep(tasksForDate(每周目标, "2026-10-06").map((t) => t.text), [], "每周：别的天不生成（规则里没写）");
eqDeep(tasksForDate(每周目标, "2026-10-12").map((t) => t.text), ["跑步"], "每周：下一周同一天再生成");
eqDeep(tasksForDate({ ...每周目标, startDate: "" }, "2026-10-05"), [],
  "每周但没填开始日期时不瞎生成");

const 月度目标 = {
  id: "g-m", moduleId: "diet", cycle: "月度",
  startDate: "2026-10-07", endDate: "", dailyRule: "称体重", isActive: true, autoTask: true,
};
eqDeep(tasksForDate(月度目标, "2026-10-07").map((t) => t.text), ["称体重"], "月度：开始那天生成");
eqDeep(tasksForDate(月度目标, "2026-10-08").map((t) => t.text), [], "月度：别的天不生成");
eqDeep(tasksForDate(月度目标, "2026-11-07").map((t) => t.text), ["称体重"], "月度：下个月同一天再生成");

/* ---------------- 对表：防重复 + lastRun ---------------- */

const tasks = [];
const first = planGoalTasks([健身目标], tasks, "2026-10-05");
eq(first.newTasks.length, 1, "第一次对表补一条");
eq(first.newTasks[0].text, "力量训练", "补的是力量训练");
eq(first.newTasks[0].belong, "goal", "自动生成的待办 belong 是 goal");
eq(first.newTasks[0].category, "运动", "分类跟着模块走");
eq(first.newTasks[0].sourceModule, "fitness", "待办上留了来源模块");
eq(first.newTasks[0].done, false, "新待办默认没完成");
eqDeep(first.markRun, ["g-fit"], "对完表要记 lastRun");
eqDeep(first.newTasks[0].imagePaths, [], "待办也带空图片数组");

// 同一天再来一次（数据里已经有那条）：不该重复
const withOne = [{ genKey: "g-fit@2026-10-05#0", text: "力量训练" }];
const second = planGoalTasks([{ ...健身目标, lastRun: "" }], withOne, "2026-10-05");
eq(second.newTasks.length, 0, "同一条已经在了就不再生成");
eqDeep(second.markRun, ["g-fit"], "对过表还是要把 lastRun 记上");

// lastRun 是今天：整个跳过（删掉的那条不会被加回来）
const third = planGoalTasks([{ ...健身目标, lastRun: "2026-10-05" }], [], "2026-10-05");
eq(third.newTasks.length, 0, "今天已经对过表就不再补");
eqDeep(third.markRun, [], "跳过时连 lastRun 也不用再写");

// 关了自动生成 / 关了目标
eq(planGoalTasks([{ ...健身目标, autoTask: false }], [], "2026-10-05").newTasks.length, 0,
  "关了自动生成的任务不进来");
eq(planGoalTasks([{ ...健身目标, isActive: false }], [], "2026-10-05").newTasks.length, 0,
  "关了目标的任务不进来");
eq(planGoalTasks([], [], "2026-10-05").newTasks.length, 0, "没有目标就什么都不做");

// 两条目标同一天各生成各的
const two = planGoalTasks([健身目标, 学习目标], [], "2026-10-05");
eq(two.newTasks.length, 2, "两条目标各生成一条");
eqDeep(two.newTasks.map((t) => t.sourceModule), ["fitness", "study"], "来源分别标对");
eqDeep(two.markRun, ["g-fit", "g-st"], "两条都要记 lastRun");

/* ---------------- 进度 ---------------- */

const today = "2026-10-07";   // 周三，本周 10-05 ~ 10-11
const mine = [
  { goalId: "g-fit", date: "2026-10-05", text: "力量训练", done: true },
  { goalId: "g-fit", date: "2026-10-07", text: "力量训练", done: false },
  { goalId: "g-fit", date: "2026-09-28", text: "有氧", done: true },
  { goalId: "g-other", date: "2026-10-06", text: "别人的", done: false },
  { date: "2026-10-06", text: "手动加的普通待办", done: false },
];
const p = progressOf({ id: "g-fit", moduleId: "fitness" }, mine, today);
eq(p.total, 3, "只数这条目标生成的待办（普通待办不算）");
eq(p.done, 2, "完成了两条");
eq(p.percent, 67, "百分比四舍五入到整数");
eq(p.weekTotal, 2, "本周两条");
eq(p.weekDone, 1, "本周完成一条");
eq(p.unit, "次", "健身的单位是次");
eq(p.allText, "2 / 3", "累计文案");
const ps = progressOf({ id: "g-fit", moduleId: "study" }, mine, today);
eq(ps.weekDays, 1, "「天」为单位时另外给出本周完成的天数");
eq(ps.metric, "days", "学习按天数口径");
eq(progressOf({ id: "g-none", moduleId: "fitness" }, mine, today).percent, 0,
  "一条都没生成时进度是 0（不显示 NaN）");
eq(progressOf({ id: "g-none", moduleId: "fitness" }, [], today).total, 0, "空数据也给 0");

/* ---------------- 卡片上那行周期 ---------------- */

eq(cycleText({ cycle: "月度", startDate: "2026-10-07", endDate: "2027-01-07" }),
  "月度 · 2026-10-07 → 2027-01-07", "周期 + 起止");
eq(cycleText({ cycle: "自定义起止日期", startDate: "2026-10-07", endDate: "" }),
  "自定义 · 2026-10-07 → 不限", "自定义显示成「自定义」");
eq(cycleText({ cycle: "每日", startDate: "", endDate: "" }), "每日 · 不限时间", "没填起止就写不限时间");

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
