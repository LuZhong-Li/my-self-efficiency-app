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

import { sourceLabelOf } from "./goal-calc.js";

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
