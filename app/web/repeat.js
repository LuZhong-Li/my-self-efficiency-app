/* 重复任务：把 task-calc.js 那些纯函数接到 store 上，再提供「今日计划」里那张卡片。
 *
 *   syncRepeatTasks(today)   进今日计划时对一遍表，把今天该生成的那条补上
 *   repeatCardHtml(today)    那张可折叠的「重复任务（N 条）」卡片
 *   repeatAction(e)          卡片上那几个按钮（添加 / 编辑 / 删除 / 折叠）
 *
 * 骨架照 goals.js（模块目标那一套）：规则的解析、哪天算数、人话预览都在
 * goal-calc.js / task-calc.js 里，这里只管「存哪儿、什么时候存、界面上长什么样」。
 * 规矩也和模块目标一致：删规则只删这条配置，已经生成的待办一条都不动。
 */

import { store, touch, uid, table, esc, todayStr } from "./store.js";
import { askConfirm, toast } from "./dialog.js";
import { icon } from "./icons.js";
import { openItemDialog, trashItem } from "./item-dialog.js";
import { ruleSummary } from "./goal-calc.js";
import { isRepeatRule, planRepeatTasks, nextRepeatDay } from "./task-calc.js";

/* 折叠状态只记在内存里，不进数据文件（和「查看目标进度」一个做法：
   不是常驻信息，刷新一下回到默认的展开，正好）。 */
let collapsed = false;

function ruleById(id) {
  return table("tasks").find((t) => t.id === id && isRepeatRule(t)) || null;
}

/* ---------------- 对表：今天该生成哪几条 ---------------- */

/**
 * 进「今日计划」时对一遍表：今天该做的重复任务写进 tasks。
 *
 * 和 syncGoalTasks 一样用「静默保存」（touch(true, true)）：这个函数是在渲染
 * 过程中调的，走普通 touch 会触发重画，把正在画的那一层 DOM 换掉、事件就白挂了。
 */
export function syncRepeatTasks(today = todayStr()) {
  if (!store.data) return 0;
  const tasks = table("tasks");
  const rules = tasks.filter(isRepeatRule);
  const { newTasks, markRun } = planRepeatTasks(rules, tasks, today);
  if (!newTasks.length && !markRun.length) return 0;
  for (const row of newTasks) {
    row.id = uid();
    row.createdAt = new Date().toISOString();
    for (const sub of row.subtasks) sub.id = uid();   // 子任务的 id 在这儿发（纯函数不管 id）
    tasks.push(row);
  }
  for (const id of markRun) {
    const rule = rules.find((r) => r.id === id);
    if (rule) rule.lastRun = today;   // 今天对过表了：你自己删掉的那条不再自动补回来
  }
  touch(true, true);
  return newTasks.length;
}

/* ---------------- 那张卡片 ---------------- */

/** 「重复任务（N 条）」：一条规则一行，行尾编辑 / 删除。没有规则时给一句空状态。 */
export function repeatCardHtml(today = todayStr()) {
  const rules = table("tasks").filter(isRepeatRule);
  const rows = rules
    .map((rule) => {
      const next = nextRepeatDay(rule, today);
      const until = rule.repeatUntil ? `（到 ${esc(rule.repeatUntil)}）` : "";
      return `
    <li class="repeat-item" data-rule="${esc(rule.id)}">
      <span class="r-text">${esc(rule.text || "（没写内容）")}</span>
      <span class="chip">${esc(ruleSummary(rule.repeat, {}))}</span>
      <span class="hint">${next ? `下次：${esc(next.slice(5))}${until}` : "已到期，不再生成"}</span>
      <span class="t-actions">
        <button class="link" data-act="repeat-edit">编辑</button>
        <button class="link danger" data-act="repeat-del">删除</button>
      </span>
    </li>`;
    })
    .join("");
  const body = rules.length
    ? `<ul class="repeat-list">${rows}</ul>`
    : `<p class="empty plan-empty">还没有重复任务。设一条「每周一、三、五 跑步」，` +
      `到那天会自动出现在今天的清单里。</p>`;
  return `
    <section class="card plan-card repeat-card${collapsed ? " collapsed" : ""}">
      <div class="plan-card-head">
        <div class="plan-head-row">
          <h2>重复任务（${rules.length} 条）</h2>
          <div class="card-tools">
            <button class="link" data-act="repeat-fold">${collapsed ? "展开" : "收起"}</button>
            <button class="btn primary small" data-act="repeat-add">${icon("plus", 14)}添加重复任务</button>
          </div>
        </div>
      </div>
      <div class="plan-card-body">${body}</div>
    </section>`;
}

/* ---------------- 卡片上那几个按钮 ---------------- */

/** 页面的事件里先叫它一声：归它管的返回 true（调用方就别往下处理了） */
export function repeatAction(e) {
  const btn = e.target.closest("[data-act]");
  if (!btn) return false;
  const act = btn.dataset.act;
  if (!act || act.indexOf("repeat-") !== 0) return false;

  if (act === "repeat-fold") {
    collapsed = !collapsed;
    touch();          // 只重画一次把卡片折起来，不落盘
    return true;
  }
  if (act === "repeat-add") {
    openItemDialog("repeatRule", null);
    return true;
  }

  const host = btn.closest("[data-rule]");
  const rule = host ? ruleById(host.dataset.rule) : null;
  if (!rule) return true;
  if (act === "repeat-edit") openItemDialog("repeatRule", rule);
  else if (act === "repeat-del") deleteRule(rule);
  return true;
}

/**
 * 删规则：只把这条规则挪进回收站，生成的待办一条都不动。
 * 确认框和模块目标一个口径，写明白「已经生成的留着」，免得你不敢删。
 */
async function deleteRule(rule) {
  const ok = await askConfirm({
    title: "删除这条重复任务？",
    message: `${rule.text || "（没写内容）"}\n\n只删除这条规则；` +
      "它已经生成的那几条待办会留在「今日计划」里，不会跟着消失。",
    confirmLabel: "删除",
    danger: true,
  });
  if (!ok) return;
  trashItem("repeatRule", rule);   // 走共用的删除计划（只把规则这一条挪进回收站）
  touch(true);
  toast("已删除重复任务（生成的待办保留）");
}
