/* 待办状态的两个统一入口（2026-10-08 加）
 *
 * 一条待办在三个地方都能被勾、被加进今日计划：今日计划页、首页总览、还有
 * 它自己的原模块（开发工作的项目详情）。要是三处各写一遍「改字段 + 落盘」，
 * 迟早有一处漏掉同步。所以统一成这两个函数：
 *
 *   updateTaskStatus(taskId, done)          勾 / 取消勾（写 done + doneAt）
 *   toggleTaskInTodayPlan(taskId, isAdd)    加入 / 移出今日计划
 *
 * 两个都改的是**同一条原始记录**，改完调 store 的 touch(true) 立刻落盘；
 * touch 会广播给整个界面，当前页面跟着重画，首页 / 今日计划 / 原模块三处的
 * 数字和列表自然就对上了（页面同一时刻只挂一个，重画当前页面 = 全局同步）。
 */

import { store, table, touch, uid, todayStr } from "./store.js";
import {
  planTasksOf, moduleKeyOf, dailyTargetsOf, DAILY_DEFAULTS,
  subTasksOf, subtaskProgress, setSubtasksDone,
} from "./task-calc.js";

function findTask(taskId) {
  return table("tasks").find((t) => t && t.id === taskId) || null;
}

/** 只写 done / doneAt 这一格（子任务联动和别的地方都走它） */
function writeDone(task, done) {
  task.done = Boolean(done);
  task.doneAt = task.done ? new Date().toISOString() : null;
  return task;
}

/**
 * 勾 / 取消一条待办：顺带把它的子任务清单整体带成一样的状态（父 → 子）。
 * 「勾上父任务 → 清单全勾；取消父任务 → 全部取消」就发生在这一处，
 * 所以今日计划、首页、项目详情三处点复选框的表现天然一样。
 * 只改内存，不落盘也不重画（谁调用谁负责）。
 */
export function markTaskDone(task, done) {
  writeDone(task, done);
  if (subTasksOf(task).length) task.subtasks = setSubtasksDone(task, done);
  return task;
}

/** 勾选 / 取消勾选一条待办：不管在哪个页面点的，都走这一个 */
export function updateTaskStatus(taskId, done) {
  const task = findTask(taskId);
  if (!task) return null;
  markTaskDone(task, done);
  touch(true);
  return task;
}

/**
 * 勾 / 取消**一条子任务**（列表里就地展开那份清单上的复选框）。
 *
 * 子 → 父：清单全勾上就把父任务一起勾上；只要有一条没勾（刚取消的这条也算），
 * 父任务就跟着取消。这里用 writeDone 而不是 markTaskDone —— 走后者会把父任务的状态
 * 反过来铺给整份清单（取消一条会把别的子任务也一起取消）。
 */
export function setSubtaskDone(taskId, subId, done) {
  const task = findTask(taskId);
  if (!task) return null;
  const sub = subTasksOf(task).find((s) => s.id === subId);
  if (!sub) return null;
  sub.done = Boolean(done);
  const p = subtaskProgress(task);
  writeDone(task, p.total > 0 && p.done === p.total);
  touch(true);
  return task;
}

/** 列表里那个子任务复选框：认出来就处理掉、返回 true（页面那边的 change 就别管了） */
export function handleSubtaskChange(e) {
  const box = e.target.closest('[data-act="sub"]');
  if (!box) return false;
  const li = box.closest("[data-id]");
  if (li) setSubtaskDone(li.dataset.id, box.dataset.sub, box.checked);
  return true;
}

/** 行上那枚「2/5」：点一下就地展开 / 收起（只动这一层 DOM，不改数据、不落盘） */
export function handleSubtaskClick(e) {
  const btn = e.target.closest('[data-act="sub-open"]');
  if (!btn) return false;
  const li = btn.closest("[data-id]");
  if (li) li.classList.toggle("sub-open");
  return true;
}

/**
 * 首页 / 今日计划上那个「+ / −」快按钮。
 *
 * **不改数字**——进度是「这个模块今天的待办按 value 汇总」现算出来的，
 * 所以加减只是往条目上动手（永远和复选框、和另一边页面一致，不会有第二份计数漂移）：
 *   +  追加一条 `done=true` 的「快速记录」条目，贡献值 = 这一步的增量（数量 +1、
 *      时长 +30 分钟…）；所以想超额也能一路加，进度条封顶绿色、文字留真实数字。
 *   −  先撤最后一条这种「快速记录」；没有的话，把最后一条已完成的取消勾选。
 *      减到 0 就停住，不会变负。
 * 改完走 touch(true)：落盘 + 全局重画，首页卡片和今日计划分组两边一起变。
 */
export function bumpModuleProgress(moduleKey, delta, today) {
  const day = today || todayStr();
  const cfg = dailyTargetsOf(store.data || {})[moduleKey] || DAILY_DEFAULTS[moduleKey];
  const step = (cfg && cfg.step) || 1;
  const tasks = table("tasks");
  const mine = planTasksOf(tasks, day).filter((t) => moduleKeyOf(t) === moduleKey);

  if (delta > 0) {
    const unit = cfg && cfg.targetValue > 0 ? cfg.unit : "项";
    const row = {
      id: uid(),
      date: day,
      time: "",
      text: `快速记录 +${step}${unit}`,
      done: true,
      doneAt: new Date().toISOString(),
      category: "",
      note: "",
      belong: "plan",
      sourceModule: moduleKey,
      value: step,
      quick: true,
      imagePaths: [],
      createdAt: new Date().toISOString(),
    };
    tasks.push(row);
    touch(true);
    return row;
  }
  if (delta < 0) {
    const quick = mine.filter((t) => t.quick);
    if (quick.length) {
      const last = quick[quick.length - 1];
      const index = tasks.indexOf(last);
      if (index >= 0) tasks.splice(index, 1);
      touch(true);
      return last;
    }
    const done = mine.filter((t) => t.done);
    const last = done[done.length - 1];
    if (last) {
      markTaskDone(last, false);
      touch(true);
      return last;
    }
  }
  return null;
}

/** 保存「今日目标」配置（类型 / 目标值 / 单位 / 步长），存进 settings.dailyTargets */
export function saveDailyTargets(map) {
  if (!store.data) return;
  if (!store.data.settings) store.data.settings = {};
  store.data.settings.dailyTargets = map;
  touch(true);
}

/**
 * 加入 / 移出「今日计划」。
 *
 * 加入时把日期盖成今天：这样今日计划、首页今日待办、月历、「昨天没做完的」
 * 这套现成的口径全都认它，任务本身还留在原来的模块里（belong 一个字没动）。
 * 移出时把日期清空、开关关掉：今日计划不再显示，任务留在原模块继续用。
 */
export function toggleTaskInTodayPlan(taskId, isAdd, today) {
  const task = findTask(taskId);
  if (!task) return null;
  if (isAdd) {
    task.isTodayPlan = true;
    task.date = today || todayStr();
  } else {
    task.isTodayPlan = false;
    task.date = "";
  }
  touch(true);
  return task;
}
