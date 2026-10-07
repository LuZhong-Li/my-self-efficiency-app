/* 今日计划：今天的任务增删改勾，外加「昨天没做完的」一键挪到今天。
 * 2026-10-07 起录入改成弹窗（和别的模块一套），卡片上只留一个「添加任务」按钮。
 * 2026-10-07 起还会在进页面时对一遍「模块目标」：健身 / 学习 / 饮食的目标到了
 * 该做的日子，会自动在这里生成一条待办（带来源标签，正文还能改）。 */

import { touch, todayStr, formatDateCN, table, esc, moveToTrash } from "./store.js";
import { bindFresh, pageHeader, markEnter } from "./ui.js";
import { askConfirm, toast } from "./dialog.js";
import { renderCalendar } from "./calendar.js";
import { icon } from "./icons.js";
import { imgBadge } from "./attachment.js";
import { openItemDialog } from "./item-dialog.js";
import { syncGoalTasks, goalBriefHtml } from "./goals.js";
import { sourceLabelOf } from "./goal-calc.js";

let mode = "today";   // today = 今天的清单，month = 月历

export function renderPlan(root) {
  const today = todayStr();

  root.innerHTML = `
    ${pageHeader(
      "plan",
      `<span class="date-chip">${esc(formatDateCN(today))}</span>
       <span class="view-switch">
         <button class="btn small${mode === "today" ? " active" : ""}" data-mode="today">今天</button>
         <button class="btn small${mode === "month" ? " active" : ""}" data-mode="month">月历</button>
       </span>`
    )}
    <div id="plan-view"></div>
  `;

  const actions = root.querySelector(".page-actions");
  if (actions) {
    actions.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-mode]");
      if (!btn || btn.dataset.mode === mode) return;
      mode = btn.dataset.mode;
      renderPlan(root);
      markEnter(root);
    });
  }

  const body = root.querySelector("#plan-view");
  if (mode === "month") renderCalendar(body);
  else renderTodayView(body);
}

function renderTodayView(body) {
  const today = todayStr();
  // 先把今天该生成的目标待办补上，再照着最新的 tasks 画
  syncGoalTasks(today);
  const all = table("tasks");
  const todayTasks = all.filter((t) => t.date === today).sort(order);
  const overdue = all
    .filter((t) => t.date && t.date < today && !t.done)
    .sort((a, b) => (a.date === b.date ? byTime(a, b) : a.date < b.date ? -1 : 1));

  body.innerHTML = `
    ${goalBriefHtml(today)}
    <section class="card">
      <div class="card-head">
        <h2>今天的任务</h2>
        <div class="card-tools">
          <span class="hint">${esc(summary(todayTasks))}</span>
          <button class="btn primary small" data-act="add">${icon("plus", 14)}添加任务</button>
        </div>
      </div>

      ${overdueBlock(overdue)}

      ${
        todayTasks.length
          ? `<ul class="tasks">${todayTasks.map(row).join("")}</ul>`
          : `<p class="empty">今天还没有任务，点右上角「添加任务」加一条。</p>`
      }
    </section>
  `;

  bindFresh(body, { click: onClick, change: onChange });
}

/* ---------------- 排序与统计 ---------------- */

function byTime(a, b) {
  // 没填时间的排在填了时间的后面
  if (!a.time && !b.time) return 0;
  if (!a.time) return 1;
  if (!b.time) return -1;
  return a.time < b.time ? -1 : a.time > b.time ? 1 : 0;
}

function order(a, b) {
  if (a.done !== b.done) return a.done ? 1 : -1; // 没做完的排前面
  const t = byTime(a, b);
  if (t !== 0) return t;
  return (a.createdAt || "") < (b.createdAt || "") ? -1 : 1;
}

function summary(items) {
  const done = items.filter((t) => t.done).length;
  return items.length ? `共 ${items.length} 条 · 已完成 ${done} 条` : "一条都还没有";
}

/* ---------------- 画 ---------------- */

function overdueBlock(items) {
  if (!items.length) return "";
  return `
    <div class="overdue">
      <div class="list-head">
        <span>昨天及更早没做完的（${items.length} 条）</span>
        <button class="btn small" data-act="move-all">全部挪到今天</button>
      </div>
      <ul class="tasks">
        ${items
          .map(
            (t) => `
          <li class="task overdue-item" data-id="${esc(t.id)}">
            <span class="t-date">${esc(t.date.slice(5))}</span>
            ${t.time ? `<span class="t-time">${esc(t.time)}</span>` : ""}
            <span class="t-text">${esc(t.text)}</span>
            <span class="t-actions">
              <button class="link" data-act="move">挪到今天</button>
            </span>
          </li>`
          )
          .join("")}
      </ul>
    </div>`;
}

function row(t) {
  return `
    <li class="task ${t.done ? "done" : ""}" data-id="${esc(t.id)}">
      <label class="check" title="${t.done ? "取消完成" : "标记完成"}">
        <input type="checkbox" data-act="toggle" ${t.done ? "checked" : ""}>
      </label>
      <span class="t-time">${t.time ? esc(t.time) : "—"}</span>
      <span class="t-text">${esc(t.text)}</span>
      ${imgBadge(t.imagePaths, "图")}
      ${t.sourceModule ? `<span class="t-src" title="由模块目标自动生成，内容可以改，删了也不会再自动补">${esc(sourceLabelOf(t.sourceModule))}</span>` : ""}
      <span class="t-cat">${esc(t.category || "其他")}</span>
      <span class="t-note">${esc(t.note || "")}</span>
      <span class="t-actions">
        <button class="link" data-act="edit">编辑</button>
        <button class="link danger" data-act="delete">删除</button>
      </span>
    </li>`;
}

/* ---------------- 事件 ---------------- */

function findTask(id) {
  return table("tasks").find((t) => t.id === id) || null;
}

async function onClick(e) {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === "toggle") return; // 勾选走 change

  if (act === "add") {
    openItemDialog("todayPlan", null, { date: todayStr() });
    return;
  }

  if (act === "move-all") {
    const today = todayStr();
    let n = 0;
    for (const t of table("tasks")) {
      if (t.date && t.date < today && !t.done) {
        t.date = today;
        n++;
      }
    }
    if (n) touch(true);
    return;
  }

  const li = btn.closest("[data-id]");
  const task = li ? findTask(li.dataset.id) : null;
  if (!task) return;

  if (act === "edit") {
    openItemDialog("todayPlan", task);
  } else if (act === "move") {
    task.date = todayStr();
    touch(true);
  } else if (act === "delete") {
    const ok = await askConfirm({
      title: "删除这条任务？",
      message: `${task.text}\n\n会放进回收站，误删可去「数据与设置」找回。`,
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    moveToTrash("tasks", task, task.text);
    touch(true);
    toast("已移入回收站");
  }
}

function onChange(e) {
  const box = e.target.closest('[data-act="toggle"]');
  if (!box) return;
  const li = box.closest("[data-id]");
  const task = li ? findTask(li.dataset.id) : null;
  if (!task) return;
  task.done = box.checked;
  task.doneAt = box.checked ? new Date().toISOString() : null;
  touch(); // 勾选走 400ms 防抖，连着勾几条不会写好几次盘
}
