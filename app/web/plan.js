/* 今日计划：今天的任务增删改勾，外加「昨天没做完的」一键挪到今天 */

import { touch, uid, todayStr, formatDateCN, table, esc, moveToTrash } from "./store.js";
import { bindFresh, pageHeader, markEnter } from "./ui.js";
import { askConfirm, toast } from "./dialog.js";
import { renderCalendar } from "./calendar.js";

const CATEGORIES = ["工作", "生活", "运动", "其他"];

let host = null;      // 承载当前视图的元素
let editingId = null; // 正在行内编辑的那条
let mode = "today";   // today = 今天的清单，month = 月历

export function renderPlan(root) {
  host = root;
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
  const all = table("tasks");
  const todayTasks = all.filter((t) => t.date === today).sort(order);
  const overdue = all
    .filter((t) => t.date && t.date < today && !t.done)
    .sort((a, b) => (a.date === b.date ? byTime(a, b) : a.date < b.date ? -1 : 1));

  body.innerHTML = `
    <section class="card">
      <form class="add-form" id="add-form" autocomplete="off">
        <input name="text" class="grow" maxlength="200" required placeholder="今天要做什么…">
        <input name="time" type="time" title="时间点（可不填）">
        <select name="category" title="分类">
          ${CATEGORIES.map((c) => `<option>${c}</option>`).join("")}
        </select>
        <input name="note" class="grow-note" maxlength="200" placeholder="备注（可不填）">
        <button class="btn primary" type="submit">添加</button>
      </form>

      ${overdueBlock(overdue)}

      <div class="list-head">
        <span>今天的任务</span>
        <span class="hint">${esc(summary(todayTasks))}</span>
      </div>
      ${
        todayTasks.length
          ? `<ul class="tasks">${todayTasks.map(row).join("")}</ul>`
          : `<p class="empty">今天还没有任务，在上面加一条。</p>`
      }
    </section>
  `;

  bindFresh(body, { submit: onSubmit, click: onClick, change: onChange });
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
  if (t.id === editingId) return editRow(t);
  return `
    <li class="task ${t.done ? "done" : ""}" data-id="${esc(t.id)}">
      <label class="check" title="${t.done ? "取消完成" : "标记完成"}">
        <input type="checkbox" data-act="toggle" ${t.done ? "checked" : ""}>
      </label>
      <span class="t-time">${t.time ? esc(t.time) : "—"}</span>
      <span class="t-text">${esc(t.text)}</span>
      <span class="t-cat">${esc(t.category || "其他")}</span>
      <span class="t-note">${esc(t.note || "")}</span>
      <span class="t-actions">
        <button class="link" data-act="edit">编辑</button>
        <button class="link danger" data-act="delete">删除</button>
      </span>
    </li>`;
}

function editRow(t) {
  return `
    <li class="task editing" data-id="${esc(t.id)}">
      <input data-field="text" class="grow" maxlength="200" value="${esc(t.text)}">
      <input data-field="time" type="time" value="${esc(t.time || "")}">
      <select data-field="category">
        ${CATEGORIES.map(
          (c) => `<option ${c === t.category ? "selected" : ""}>${c}</option>`
        ).join("")}
      </select>
      <input data-field="note" class="grow-note" maxlength="200" placeholder="备注" value="${esc(t.note || "")}">
      <button class="btn primary small" data-act="save">保存</button>
      <button class="btn small" data-act="cancel">取消</button>
    </li>`;
}

function redraw() {
  if (host) renderPlan(host);
}

/* ---------------- 事件 ---------------- */

function findTask(id) {
  return table("tasks").find((t) => t.id === id) || null;
}

function onSubmit(e) {
  if (!e.target.matches("#add-form")) return;
  e.preventDefault();
  const form = e.target;
  const text = form.text.value.trim();
  if (!text) return;

  table("tasks").push({
    id: uid(),
    date: todayStr(),
    text,
    time: form.time.value || "",
    category: form.category.value,
    done: false,
    note: form.note.value.trim(),
    belong: "plan",
    createdAt: new Date().toISOString(),
  });
  touch(true); // 增删改这类明确动作立刻落盘
}

async function onClick(e) {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === "toggle") return; // 勾选走 change

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
    editingId = task.id;
    redraw();
  } else if (act === "cancel") {
    editingId = null;
    redraw();
  } else if (act === "save") {
    const val = (name) => li.querySelector(`[data-field="${name}"]`).value;
    const text = val("text").trim();
    if (!text) {
      toast("内容不能是空的", "err");
      return;
    }
    task.text = text;
    task.time = val("time") || "";
    task.category = val("category");
    task.note = val("note").trim();
    editingId = null;
    touch(true);
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
    if (editingId === task.id) editingId = null;
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
