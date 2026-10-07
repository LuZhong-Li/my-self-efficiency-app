/* 模块目标：把 goal-calc.js 那些纯函数接到 store 上，再提供三块界面零件。
 *
 *   goalCardHtml(moduleId)      模块页最上面那张「🎯 当前模块目标」卡片
 *   goalAction(e, moduleId, …)  卡片上那三个按钮（新增 / 编辑 / 查看进度 / 删除）
 *   syncGoalTasks(today)        进「今日计划」时对一遍表，把今天该生成的待办补上
 *   goalBriefHtml(today)        「今日计划」顶部那条目标摘要
 *
 * 目标不进回收站：删目标只删这条配置，已经生成的待办一条都不动（怕丢数据）。
 */

import { store, touch, uid, table, esc, todayStr } from "./store.js";
import { emptyState } from "./ui.js";
import { askConfirm, toast } from "./dialog.js";
import { icon } from "./icons.js";
import { openItemDialog } from "./item-dialog.js";
import {
  GOAL_MODULES, goalModuleOf, rawGoals, ensureBucket, normalizeGoal,
  planGoalTasks, progressOf, ruleSummary, cycleText, isActiveOn, tasksForDate,
} from "./goal-calc.js";

/* 「查看目标进度」是展开还是收起：只记在内存里，不进数据文件
 * （进度不是常驻信息，刷新一下收起来正好）。 */
const opened = {};

/* ---------------- 读 ---------------- */

/** 某个模块的目标。顺手把缺的字段原地补齐 —— 和 store.js 的 table() 一样，
 *  读一次就自动把老数据升级，下一次保存一起落盘。 */
export function goalsFor(moduleId, data = store.data) {
  return rawGoals(data, moduleId).map((raw) => {
    const fixed = normalizeGoal(raw, moduleId);
    for (const key of Object.keys(fixed)) raw[key] = fixed[key];
    return raw;
  });
}

export function allGoalsFor(data = store.data) {
  const out = [];
  for (const mod of GOAL_MODULES) out.push(...goalsFor(mod.id, data));
  return out;
}

/* ---------------- 自动生成待办 ---------------- */

/**
 * 进「今日计划」时对一遍表：今天该生成的目标任务写进 tasks。
 *
 * 这里用「静默保存」（touch(true, true)）：这个函数是在页面渲染过程中调的，
 * 要是走普通 touch 触发重画，正在画的那一层 DOM 会被换掉，事件就白挂了。
 * 反正调用方马上就会把新任务画出来，不需要再重画一次。
 */
export function syncGoalTasks(today = todayStr()) {
  if (!store.data) return 0;
  const tasks = table("tasks");
  const goals = allGoalsFor();
  const { newTasks, markRun } = planGoalTasks(goals, tasks, today);
  if (!newTasks.length && !markRun.length) return 0;
  for (const row of newTasks) {
    row.id = uid();
    row.createdAt = new Date().toISOString();
    tasks.push(row);
  }
  for (const id of markRun) {
    const goal = goals.find((g) => g.id === id);
    if (goal) goal.lastRun = today;    // 今天对过表了：你自己删掉的那条不再自动补回来
  }
  touch(true, true);
  return newTasks.length;
}

/** 「今日计划」顶部那条摘要：今天开着自动生成的目标各要做什么 */
export function goalBriefHtml(today = todayStr()) {
  const bits = [];
  for (const goal of allGoalsFor()) {
    if (!isActiveOn(goal, today) || goal.autoTask === false) continue;
    const items = tasksForDate(goal, today);
    if (!items.length) continue;
    const mod = goalModuleOf(goal.moduleId);
    bits.push(`${mod ? mod.short : "模块"}：${items.map((i) => i.text).join("、")}`);
  }
  if (!bits.length) return "";
  return `<p class="goal-brief">🎯 今天的模块目标：${esc(bits.join(" ｜ "))}</p>`;
}

/* ---------------- 卡片 ---------------- */

export function goalCardHtml(moduleId) {
  const mod = goalModuleOf(moduleId);
  const goals = goalsFor(moduleId);
  const head = `
    <div class="card-head">
      <h2>🎯 当前模块目标</h2>
      <div class="card-tools">
        <span class="hint">${goals.length ? `共 ${goals.length} 个目标` : "还没设置"}</span>
        <button class="btn primary small" data-act="go-add">${icon("plus", 14)}新增目标</button>
      </div>
    </div>`;
  const body = goals.length
    ? goals.map((goal) => goalBlock(goal)).join("")
    : emptyState(
        "还没有设置目标",
        `写下${mod ? mod.name : "这个模块"}的总目标，之后可以按规则自动生成待办到「今日计划」。`
      );
  return `<section class="card goal-card">${head}${body}</section>`;
}

function goalBlock(goal) {
  const tasks = table("tasks");
  const p = progressOf(goal, tasks, todayStr());
  const mod = goalModuleOf(goal.moduleId);
  const off = goal.isActive === false;
  const rule = ruleSummary(goal.dailyRule, goal);
  const open = Boolean(opened[goal.id]);
  const tags =
    (off ? `<span class="chip goal-off">已停用</span>` : "") +
    (!off && goal.autoTask === false ? `<span class="chip goal-off">不自动生成</span>` : "") +
    (!off && goal.autoTask !== false ? `<span class="chip goal-on">自动进今日计划</span>` : "");
  return `
    <div class="goal-item${off ? " off" : ""}" data-goal="${esc(goal.id)}">
      <div class="goal-title">${esc(goal.mainTarget || "（没写目标）")}</div>
      <div class="goal-meta">
        <span class="chip">${esc(cycleText(goal))}</span>
        ${tags}
        <span class="goal-num">已完成 ${esc(p.allText)} ${esc(mod ? mod.short : "")} · ${p.percent}%</span>
      </div>
      ${rule ? `<div class="goal-rule">自动生成：${esc(rule)}</div>` : ""}
      ${goal.remark ? `<div class="goal-note">备注：${esc(goal.remark)}</div>` : ""}
      <div class="progress-track goal-track"><span style="width:${p.percent}%"></span></div>
      <div class="goal-actions">
        <button class="link" data-act="go-edit">编辑目标</button>
        <button class="link" data-act="go-progress">${open ? "收起进度" : "查看目标进度"}</button>
        <button class="link danger" data-act="go-del">删除</button>
      </div>
      ${open ? goalProgressHtml(goal, tasks, p) : ""}
    </div>`;
}

function goalProgressHtml(goal, tasks, p) {
  const mod = goalModuleOf(goal.moduleId);
  const weekText =
    p.metric === "days"
      ? `本周完成 ${p.weekDone} 天`
      : `本周完成 ${p.weekDone} / ${p.weekTotal} ${p.unit}`;
  const mine = tasks
    .filter((t) => t && t.goalId === goal.id)
    .sort((a, b) => ((a.date || "") < (b.date || "") ? 1 : -1));
  return `
    <div class="goal-progress">
      <div class="goal-stats">
        <span><strong>${p.percent}%</strong> 累计进度</span>
        <span>${esc(weekText)}</span>
        <span>累计完成 ${esc(p.allText)} ${esc(mod ? mod.unit : "次")}</span>
      </div>
      ${
        mine.length
          ? `<ul class="items">${mine.slice(0, 8).map(goalTaskRow).join("")}</ul>`
          : `<p class="empty">这条目标还没生成过待办。</p>`
      }
    </div>`;
}

function goalTaskRow(t) {
  return `
    <li class="item${t.done ? " done" : ""}">
      <span class="i-meta">${esc(t.date || "")}</span>
      <span class="i-title">${esc(t.text || "")}</span>
      <span class="chip">${t.done ? "已完成" : "待办"}</span>
    </li>`;
}

/* ---------------- 卡片上的那几个按钮 ---------------- */

/** 页面的事件里先叫它一声：归它管的返回 true（调用方就别往下处理了） */
export function goalAction(e, moduleId, redraw) {
  const btn = e.target.closest("[data-act]");
  if (!btn) return false;
  const act = btn.dataset.act;
  if (!act || act.indexOf("go-") !== 0) return false;

  if (act === "go-add") {
    openItemDialog("moduleGoal", null, goalDialogOptions(moduleId, redraw));
    return true;
  }

  const host = btn.closest("[data-goal]");
  const goal = host ? goalsFor(moduleId).find((g) => g.id === host.dataset.goal) : null;
  if (!goal) return true;

  if (act === "go-edit") {
    openItemDialog("moduleGoal", goal, goalDialogOptions(moduleId, redraw));
  } else if (act === "go-progress") {
    opened[goal.id] = !opened[goal.id];
    redraw();
  } else if (act === "go-del") {
    deleteGoal(goal, moduleId, redraw);
  }
  return true;
}

function goalDialogOptions(moduleId, redraw) {
  const mod = goalModuleOf(moduleId);
  return {
    // 新增时：模块名自动填上，开始日期默认今天（每周 / 月度那种「没写星期几」的规则
    // 要靠开始日期来定「哪天生成」，所以得有个默认值；编辑时以记录里的值为准）
    defaults: { moduleName: mod ? mod.name : "", startDate: todayStr() },
    ctx: {
      moduleId,
      moduleName: mod ? mod.name : "",
      goals: ensureBucket(store.data, moduleId),   // 存哪儿：这个模块那一桶
      date: todayStr(),                            // 新增目标时开始日期默认今天
    },
    onSaved: () => redraw(),
    onDeleted: () => redraw(),
  };
}

async function deleteGoal(goal, moduleId, redraw) {
  const ok = await askConfirm({
    title: "删除这条目标设置？",
    message: `${goal.mainTarget || "（没写目标）"}\n\n只删除目标设置；` +
      "已经生成的待办会留在「今日计划」里，不会跟着消失。",
    confirmLabel: "删除",
    danger: true,
  });
  if (!ok) return;
  const bucket = ensureBucket(store.data, moduleId);
  const index = bucket.indexOf(goal);
  if (index >= 0) bucket.splice(index, 1);
  touch(true);
  toast("已删除目标设置（生成的待办保留）");
  redraw();
}
