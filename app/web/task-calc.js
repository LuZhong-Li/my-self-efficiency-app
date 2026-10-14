/* 待办跨模块联动的纯逻辑（2026-10-08 加）
 *
 * 一条待办只有一份原始记录，都躺在 tasks 这张表里：
 *   belong = "plan"          今日计划自己的任务（含「玩游戏放松」那种顺手加的）
 *   belong = "dev:<项目 id>" 开发工作挂在项目上的待办
 *   belong = "goal"          模块目标按规则自动生成的待办
 * 哪个页面该画哪几条、行上挂什么标签、能在哪儿删，全由这里说了算：
 *
 *   inTodayPlan(row, today)   这条今天要不要出现在「今日计划」/ 首页今日待办里
 *   taskOwnerOf(row)          「原模块」是谁（决定能不能在今日计划里直接删）
 *   taskSourceLabel(row)      来源标签上写什么（开发待办 / 健身目标任务…）
 *   planTasksOf(tasks, today) 今日计划要画的那一列（先筛再排）
 *   planStatsOf(list)         顶部那几个数：未完成 / 已完成 / 待安排 / 百分比
 *
 * 全是纯函数（不吃 store、不碰 DOM），所以 `node tests\待办联动.test.mjs`
 * 能一条条断言，和记账、开发那几个计算模块一个路数。
 */

import { sourceLabelOf, barLevelOf, parseRule, clauseMatches } from "./goal-calc.js";

/** 优先级高 / 中 / 低各自对应哪个胶囊样式；没标的给空串（不画那个标签） */
export const PRIORITY_CLASS = { 高: "pri-high", 中: "pri-mid", 低: "pri-low" };

export function priorityClass(priority) {
  return PRIORITY_CLASS[String(priority == null ? "" : priority).trim()] || "";
}

/** 这条归档了没有（缺字段的老数据一律当没归档，和 dev-calc 一个口径） */
export function taskArchived(row) {
  return Boolean(row && typeof row === "object" && row.isArchived === true);
}

/**
 * 这条待办的「原模块」是谁。
 * 只有开发工作挂在项目上的待办算外来的（不能在这里删，得回项目里删）；
 * 今日计划自己的、模块目标生成的、游戏娱乐顺手加的，都算今日计划自己的 ——
 * 它们本来就能在今日计划里直接删，这条老规矩不动。
 */
export function taskOwnerOf(row) {
  const belong = String((row && row.belong) || "");
  return belong.indexOf("dev:") === 0 ? "dev" : "plan";
}

/** 开发待办挂在哪个项目上（「去原模块」那个链接要用） */
export function devProjectOf(row) {
  const belong = String((row && row.belong) || "");
  return belong.indexOf("dev:") === 0 ? belong.slice(4) : "";
}

/**
 * 今天这条要不要出现在「今日计划」里：
 *   · 日期就是今天（今日计划自己的任务，以及从别的模块「加入今日计划」时盖了今天的）；
 *   · 或者标了 isTodayPlan 还没落日期（兜底：别处写进来的数据也认这个开关）。
 * 归档的一律不露脸 —— 归档在归档区看，不占首页和今日计划。
 */
export function inTodayPlan(row, today) {
  if (!row || typeof row !== "object") return false;
  if (taskArchived(row)) return false;
  if (row.date && row.date === today) return true;
  return row.isTodayPlan === true && !row.date;
}

/** 来源标签上写什么。今日计划自己的任务不挂标签（返回空串就不画）。 */
export function taskSourceLabel(row) {
  const r = row && typeof row === "object" ? row : {};
  const belong = String(r.belong || "");
  if (belong.indexOf("dev:") === 0) return "开发待办";
  if (r.repeatId) return "重复任务";        // 重复规则生成的那条（2026-10-14 加的）
  if (r.sourceModule) return sourceLabelOf(r.sourceModule);
  return belong === "goal" ? "模块目标" : "";
}

/* ---------------- 排序与统计 ---------------- */

function byTime(a, b) {
  // 没填时间点的排在填了的后面
  if (!a.time && !b.time) return 0;
  if (!a.time) return 1;
  if (!b.time) return -1;
  return a.time < b.time ? -1 : a.time > b.time ? 1 : 0;
}

/** 今日计划的排法：没做完的在前，再按时间点，最后按录入先后 */
export function sortPlanTasks(a, b) {
  if (Boolean(a.done) !== Boolean(b.done)) return a.done ? 1 : -1;
  const t = byTime(a, b);
  if (t !== 0) return t;
  return (a.createdAt || "") < (b.createdAt || "") ? -1 : 1;
}

/** 今日计划要画的那一列：今天该看的全在这儿，跨模块加进来的一起 */
export function planTasksOf(tasks, today) {
  return (tasks || []).filter((t) => inTodayPlan(t, today)).sort(sortPlanTasks);
}

/**
 * 「昨天及更早没做完的」那一列（今日计划顶上的逾期卡）。
 * 归档的不算 —— 收起来的东西不该再冒出来，也不该被「全部挪到今天」顺手带走。
 * 逾期卡和「全部挪到今天」都用这一份：两处要是各写各的，哪天就会走岔
 * （2026-10-10 修的就是这个：卡上筛掉了归档的，「全部挪到今天」却把归档的也改了日期）。
 */
export function overdueTasksOf(tasks, today) {
  return (tasks || [])
    .filter((t) => t && t.date && t.date < today && !t.done && !taskArchived(t))
    .sort((a, b) => (a.date === b.date ? byTime(a, b) : a.date < b.date ? -1 : 1));
}

/** 顶部那几个数：未完成 / 已完成 / 待安排（今天没填时间点的）/ 完成百分比 */
export function planStatsOf(list) {
  const items = list || [];
  const done = items.filter((t) => t && t.done).length;
  return {
    total: items.length,
    done,
    open: items.length - done,
    untimed: items.filter((t) => t && !t.time).length,
    percent: items.length ? Math.round((done * 100) / items.length) : 0,
  };
}

/* ---------------- 子任务（2026-10-14 加） ----------------
   一条待办底下挂几件小事：tasks 里多一个 subtasks 数组，每条 { id, text, done }。
   只有一层（子任务不能再挂子任务），一条最多 30 条（上限在这里定义一份）。
   进度不落盘 —— 2/5 每次现算（和「今日进度不另存」一个哲学）。 */

export const SUBTASK_LIMIT = 30;

/** 这条待办的子任务清单。缺字段 / 写得不是数组 / 老数据，一律当空的 —— 页面不用到处判空。 */
export function subTasksOf(task) {
  if (!task || typeof task !== "object" || !Array.isArray(task.subtasks)) return [];
  return task.subtasks.filter((s) => s && typeof s === "object");
}

/** 清单的完成情况：{ done, total, percent }。没清单时长 0、百分比 0（不是 NaN）。 */
export function subtaskProgress(task) {
  const list = subTasksOf(task);
  const done = list.filter((s) => s.done === true).length;
  const total = list.length;
  return { done, total, percent: total ? Math.round((done * 100) / total) : 0 };
}

/** 父任务勾上 / 取消时，把清单整体带成一样的状态。
 *  返回一份**新的**清单，不改传进来的那条（勾选联动要能当纯函数测）。 */
export function setSubtasksDone(task, done) {
  return subTasksOf(task).map((s) => ({ id: s.id, text: s.text, done: Boolean(done) }));
}

/** 子任务的文字拼成一段（搜索池要用：搜「改侧栏」能带出父任务）。 */
export function subtaskTextOf(task) {
  return subTasksOf(task).map((s) => String(s.text || "")).filter(Boolean).join(" ");
}

/* ---------------- 按模块分组的「今日进度」（2026-10-09 加） ----------------
   首页那张「各模块今日进度」卡片、今日计划里每组模块的进度条，用的是同一套分组：
   把今天这列待办按所属模块归堆，每堆现算完成数 / 总数 / 百分比 / 配色档。
   进度不另存 —— 待办勾了几条就是几条，加减按钮也只是去勾 / 取消勾条目（见
   task-actions.js 的 bumpModuleProgress），所以两边永远不会对不上。 */

/** 分组用的模块清单：顺序固定，首页卡片的行和今日计划的分组都照这个排 */
export const PLAN_GROUPS = [
  { key: "fitness", name: "健身", icon: "fitness" },
  { key: "study", name: "学习", icon: "study" },
  { key: "diet", name: "饮食", icon: "diet" },
  { key: "dev", name: "开发工作", icon: "dev" },
  { key: "game", name: "游戏娱乐", icon: "game" },
];

/** 这条待办算哪个模块的：开发待办看 belong（dev:项目id），其余看 sourceModule；
 *  今日计划自己加的没有模块，返回空串（归到「其他」一列）。 */
export function moduleKeyOf(row) {
  if (!row || typeof row !== "object") return "";
  if (String(row.belong || "").indexOf("dev:") === 0) return "dev";
  const src = String(row.sourceModule || "");
  return PLAN_GROUPS.some((g) => g.key === src) ? src : "";
}

/* ---------------- 今日目标配置：多类型（数量 / 时长）+ 超额（2026-10-09 加） ----------------
   每个模块可以配一个「今日目标」：类型（数量 / 时长）、目标值、单位、单步增量。
   没配（targetValue = 0）就退回老口径：目标 = 今天这组待办的值之和、单位「项」。
   进度永远是现算的：currentValue = 已完成条目的 value 之和（不另存一份数字）。 */

export const DAILY_TYPES = { count: "数量", time: "时长" };

/** 每个模块的默认今日目标（没配过的模块走这套） */
export const DAILY_DEFAULTS = {
  fitness: { type: "count", targetValue: 0, unit: "项", step: 1 },
  study: { type: "count", targetValue: 0, unit: "项", step: 1 },
  diet: { type: "count", targetValue: 0, unit: "项", step: 1 },
  dev: { type: "count", targetValue: 0, unit: "项", step: 1 },
  game: { type: "count", targetValue: 0, unit: "项", step: 1 },
};

function normType(t) {
  return t === "time" ? "time" : "count";
}

function posNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 把 settings.dailyTargets 读成「每个模块一条」的完整配置（缺的补默认值，认不出的兜住） */
export function dailyTargetsOf(data) {
  const raw = (data && data.settings && data.settings.dailyTargets) || {};
  const out = {};
  for (const meta of PLAN_GROUPS) {
    const d = DAILY_DEFAULTS[meta.key];
    const r = raw[meta.key] && typeof raw[meta.key] === "object" ? raw[meta.key] : {};
    const targetValue = Number(r.targetValue);
    out[meta.key] = {
      type: normType(r.type),
      targetValue: Number.isFinite(targetValue) && targetValue > 0 ? targetValue : 0,
      unit: String(r.unit == null ? "" : r.unit).trim() || d.unit,
      step: posNum(r.step, d.step),
    };
  }
  return out;
}

/** 一条待办对进度的贡献值：自己写了 value 就用它；没写按类型兜底
 *  （数量 1 条、时长一个步长），这样老的待办不用改也是每条记一笔。 */
export function valueOf(task, cfg) {
  const v = Number(task && task.value);
  if (Number.isFinite(v) && v > 0) return v;
  return cfg && cfg.type === "time" ? cfg.step : 1;
}

/**
 * 把一列待办按模块分组，并算好每组的今日进度。
 *
 * @param {object[]} list   今天要看的待办（一般是 planTasksOf 的结果）
 * @param {object} targets  dailyTargetsOf(data) 的结果；可省，省了走默认
 * @returns {object} { groups, loose }
 *   groups 每项：{ key, name, icon, cfg, type, unit, target, current, planned,
 *                 done, total, percent, over, level, tasks }
 *     · current = 已完成条目的 value 之和（现算，不存）
 *     · target  = 配了目标值就用它，没配就用这组待办的值之和
 *     · over    = current > target（超额）；超额时进度条满格绿色 + 「超额」标记
 *   loose 是不属于任何模块的（今日计划自己加的）。
 *   有内容的模块，或配了目标值（哪怕今天还没条目）的模块，都会出组。
 */
export function groupPlanTasks(list, targets) {
  const cfgOf = (key) => (targets && targets[key]) || DAILY_DEFAULTS[key] || DAILY_DEFAULTS.fitness;
  const buckets = {};
  const loose = [];
  for (const t of list || []) {
    if (!t) continue;
    const key = moduleKeyOf(t);
    if (!key) {
      loose.push(t);
      continue;
    }
    (buckets[key] = buckets[key] || []).push(t);
  }
  const groups = [];
  for (const meta of PLAN_GROUPS) {
    const tasks = buckets[meta.key] || [];
    const cfg = cfgOf(meta.key);
    const configured = cfg.targetValue > 0;
    if (!tasks.length && !configured) continue;
    const current = tasks.reduce((sum, t) => sum + (t.done ? valueOf(t, cfg) : 0), 0);
    const planned = tasks.reduce((sum, t) => sum + valueOf(t, cfg), 0);
    const target = configured ? cfg.targetValue : planned;
    const percent = target > 0 ? Math.round((current * 100) / target) : 0;
    const over = target > 0 && current > target;
    groups.push({
      ...meta,
      tasks,
      cfg,
      type: configured ? cfg.type : "count",
      unit: configured ? cfg.unit : "项",
      target,
      current,
      planned,
      done: tasks.filter((t) => t.done).length,
      total: tasks.length,
      percent,
      over,
      level: over ? "green" : barLevelOf(percent),
    });
  }
  return { groups, loose };
}

/* ---------------- 重复任务（2026-10-14 加） ----------------
   一条规则 = tasks 里 repeat 有内容、且不占某一天（date 空）的那条记录；
   到日子了给它生成一条当天的实例（带 genKey / repeatId）。
   规则怎么解析、哪天算数，直接用 goal-calc.js 那套现成的（parseRule / clauseMatches），
   和模块目标的「自动任务规则」一句话也不差；这里只管「今天该补哪几条」。 */

/** 这条是不是规则：repeat 有内容、没归档、且不占某一天。
 *  生成出来的实例有日期、身上也没有 repeat，所以不会被误认成规则。 */
export function isRepeatRule(row) {
  if (!row || typeof row !== "object") return false;
  if (!String(row.repeat || "").trim()) return false;
  if (taskArchived(row)) return false;
  return !row.date;
}

/** 所有生效中的规则（页面上那张卡片、对表都用这一份） */
export function repeatRulesOf(tasks) {
  return (tasks || []).filter((t) => isRepeatRule(t));
}

/** 这一天是不是这条规则的日子。repeatUntil 之后一律不算（「重复到哪天」）。 */
export function repeatDueOn(rule, date) {
  if (!rule || !String(rule.repeat || "").trim()) return false;
  if (rule.repeatUntil && date > rule.repeatUntil) return false;
  return parseRule(rule.repeat, {}).some((clause) => clauseMatches(clause, date, {}));
}

/** 防重键：同一条规则、同一天只生成一条 */
export function genKeyOf(rule, date) {
  return "repeat:" + rule.id + ":" + date;
}

/** 日期加减（本地时区，不走 UTC；和 goal-calc.js 的日期小工具一个口径） */
export function addDays(date, n) {
  const [y, m, d] = String(date).split("-").map(Number);
  const dt = new Date(y, m - 1, d + n);
  const p = (x) => String(x).padStart(2, "0");
  return dt.getFullYear() + "-" + p(dt.getMonth() + 1) + "-" + p(dt.getDate());
}

/** 卡片上那行「下次：10-16」：从明天往后找最近一天，最多找 400 天（够跨年了）；
 *  过了 repeatUntil 就是空串，卡片上写「已到期，不再生成」。 */
export function nextRepeatDay(rule, today) {
  if (!rule || !String(rule.repeat || "").trim()) return "";
  const clauses = parseRule(rule.repeat, {});
  if (!clauses.length) return "";
  let date = addDays(today, 1);
  for (let i = 0; i < 400; i += 1) {
    if (rule.repeatUntil && date > rule.repeatUntil) return "";
    if (clauses.some((clause) => clauseMatches(clause, date, {}))) return date;
    date = addDays(date, 1);
  }
  return "";
}

/** 从规则抄一条实例（今天要做的那条）。id / createdAt 留给上屏那边补。 */
function instanceOfRule(rule, today, key) {
  return {
    id: "",
    date: today,
    time: rule.time || "",
    text: rule.text || "",
    done: false,
    doneAt: null,
    category: rule.category || "",
    priority: rule.priority || "",
    note: rule.note || "",
    tags: Array.isArray(rule.tags) ? rule.tags.slice() : [],
    // 清单抄一份过去，勾选从零开始（今天的勾不带到明天那条）。id 由调用方补。
    subtasks: subTasksOf(rule).map((s) => ({ id: "", text: String(s.text || ""), done: false })),
    belong: "plan",
    genKey: key,
    repeatId: rule.id,
    imagePaths: [],          // 故意不继承图片：共用路径的话删今天是会误删规则那张
    createdAt: "",
  };
}

/**
 * 对一遍表：给「今天」挑出该补的重复任务。
 *
 * 两道闸和 planGoalTasks 一个形状：
 *   1. genKey（规则 id + 日期）—— 同一条规则同一天只生成一次；
 *   2. rule.lastRun —— 今天已经对过表就不再补，所以你自己删掉的那条不会被加回来。
 *
 * 返回 { newTasks, markRun }：newTasks 交给调用方补 id / 时间再 push；
 * markRun 那些规则要把 lastRun 记成今天。纯函数，不写盘、不改入参。
 */
export function planRepeatTasks(rules, tasks, today) {
  const existing = new Set((tasks || []).map((t) => t && t.genKey).filter(Boolean));
  const newTasks = [];
  const markRun = [];
  for (const rule of rules || []) {
    if (!isRepeatRule(rule)) continue;
    if (!repeatDueOn(rule, today)) continue;      // 今天不是它的日子
    if (rule.lastRun === today) continue;         // 今天已经对过表了
    const key = genKeyOf(rule, today);
    if (!existing.has(key)) {
      existing.add(key);
      newTasks.push(instanceOfRule(rule, today, key));
    }
    markRun.push(rule.id);
  }
  return { newTasks, markRun };
}
