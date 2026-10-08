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

import { table, touch, todayStr } from "./store.js";

function findTask(taskId) {
  return table("tasks").find((t) => t && t.id === taskId) || null;
}

/** 只改内存里的状态，不落盘也不重画（自动归档那种要连着做几件事的地方用） */
export function markTaskDone(task, done) {
  task.done = Boolean(done);
  task.doneAt = task.done ? new Date().toISOString() : null;
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
