/* 今日计划：今天的任务增删改勾，外加「昨天没做完的」一键挪到今天。
 * 2026-10-07 起录入改成弹窗（和别的模块一套），卡片上只留一个「添加任务」按钮。
 * 2026-10-07 起还会在进页面时对一遍「模块目标」：健身 / 学习 / 饮食的目标到了
 * 该做的日子，会自动在这里生成一条待办（带来源标签，正文还能改）。
 * 同日又加了和「游戏娱乐」的联动：右上角一个可关的开关，开着就把今天的游玩记录
 * 摘要露在这页顶上，还能顺手把「玩游戏放松」加成一条带来源标签的待办。 */

import {
  touch, todayStr, formatDateCN, table, esc, moveToTrash,
  planShowGameOf, setPlanShowGame,
} from "./store.js";
import { bindFresh, pageHeader, markEnter } from "./ui.js";
import { askConfirm, toast } from "./dialog.js";
import { renderCalendar } from "./calendar.js";
import { icon } from "./icons.js";
import { imgBadge } from "./attachment.js";
import { openItemDialog } from "./item-dialog.js";
import { syncGoalTasks, goalBriefHtml } from "./goals.js";
import { sourceLabelOf } from "./goal-calc.js";
import { recordsOn, durationText } from "./game-calc.js";

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
    ${gameBriefHtml(today)}
    <section class="card">
      <div class="card-head">
        <h2>今天的任务</h2>
        <div class="card-tools">
          <span class="hint">${esc(summary(todayTasks))}</span>
          <button class="link" data-act="game-toggle" title="游戏娱乐里的游玩记录，要不要在今日计划露一面">${
            planShowGameOf() ? "不显示今日游玩" : "显示今日游玩"
          }</button>
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

/**
 * 游戏娱乐 → 今日计划 的联动（可关）：开关开着、今天又真有游玩记录时，
 * 在今日计划顶上露一条「今天玩了什么」；顺手也能把「玩游戏放松」加成一条待办，
 * 那条待办会挂上「游戏娱乐」的来源标签，和模块目标生成的待办一个待遇。
 */
function gameBriefHtml(today) {
  if (!planShowGameOf()) return "";
  const records = recordsOn(table("gameRecords"), today);
  if (!records.length) return "";
  const minutes = records.reduce((sum, r) => sum + (Number(r.durationMin) || 0), 0);
  const names = [...new Set(records.map((r) => r.gameName || "（没写游戏名）"))];
  return `
    <div class="goal-brief gm-plan-brief">
      <span>🎮 今日游玩：${esc(names.join("、"))} · 共 ${esc(durationText(minutes))}</span>
      <button class="link" data-act="game-add-task">加一条「玩游戏放松」</button>
      <a class="link" href="#game">去游戏娱乐 →</a>
    </div>`;
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

  if (act === "game-toggle") {
    setPlanShowGame(!planShowGameOf());   // touch(true) 会带着整页重画一次
    toast(planShowGameOf() ? "今日计划会显示今天的游玩记录" : "今日计划不再显示游玩记录");
    return;
  }

  if (act === "game-add-task") {
    openItemDialog("todayPlan", null, {
      date: todayStr(),
      defaults: { text: "玩游戏放松", category: "生活" },
      onSaved: (saved) => {
        // 来源标签「游戏娱乐」是这一条独有的，不往 todayPlan 那张公共字段表里塞，
        // 存完补一个字段再落一次盘就行（saved 就是 tasks 里那条，改的是同一个对象）。
        saved.sourceModule = "game";
        touch(true);
      },
    });
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
