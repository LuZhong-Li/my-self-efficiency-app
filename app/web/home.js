/* 首页总览：双视图（简洁 / 完整）
 *
 * 简洁：核心区（今日进度 & 待办 ｜ 财务摘要）+ 高频模块卡 + 「其他模块」折叠 + 辅助区。
 * 完整：原来的全卡片平铺，一行布局都不动。
 *
 * 「哪个视图显示哪些卡、卡片正面写什么、提示写什么、进度怎么算」全在
 * home-view.js 里算（纯函数，有单测）；这个文件只管画和接事件。
 */

import { store, touch, table, esc, todayStr, homeViewOf, setHomeView } from "./store.js";
import { progressOf, overdueTasks, cardsFor } from "./home-view.js";
import { bindFresh, emptyState } from "./ui.js";
import { icon } from "./icons.js";

let memoTimer = null;

export function renderHome(root) {
  const today = todayStr();
  const data = store.data || {};
  const mode = homeViewOf();

  // 简洁模式在 Task 4–6 里长出来；这一步两个分支都还画原来的布局，
  // 免得中途出现「点进首页是空的」这种半成品状态。
  root.innerHTML = mode === "simple" ? fullView(data, today) : fullView(data, today);

  const memo = root.querySelector("#memo");
  if (memo) memo.value = (store.data && store.data.memo) || "";

  bindFresh(root, { change: onChange, input: onInput, click: onClick });
}

/* ---------------- 欢迎栏 ---------------- */

function heroHTML(mode) {
  const settings = (store.data && store.data.settings) || {};
  const slogan = (settings.slogan || "").trim();
  return `
    <section class="hero">
      <div>
        <h1>${esc(greeting())}，小李</h1>
        ${slogan ? `<div class="hero-sub">${esc(slogan)}</div>` : ""}
      </div>
      <div class="hero-actions">
        <span class="view-switch" role="group" aria-label="首页视图">
          <button class="btn small${mode === "simple" ? " active" : ""}" data-act="home-view"
            data-view="simple" title="简洁模式：只看今日核心和高频模块">${icon("list", 16)}简洁模式</button>
          <button class="btn small${mode === "full" ? " active" : ""}" data-act="home-view"
            data-view="full" title="完整模式：所有模块一次看完">${icon("grid", 16)}完整模式</button>
        </span>
        <a class="btn primary" href="#plan">${icon("plus", 16)}新建待办</a>
      </div>
    </section>`;
}

/* ---------------- 快速操作 / 快速备忘 ---------------- */

function commandStripHTML() {
  return `
    <nav class="command-strip" aria-label="快速操作">
      <span>快速操作</span>
      <button data-act="go" data-hash="#plan">${icon("plus", 16)}新建事项</button>
      <button data-act="focus-memo">${icon("pencil", 16)}记备忘</button>
      <button data-act="go" data-hash="#fitness">${icon("fitness", 16)}记训练</button>
      <button data-act="go" data-hash="#diet">${icon("diet", 16)}记饮食</button>
      <button data-act="go" data-hash="#media">${icon("media", 16)}加内容</button>
    </nav>`;
}

function memoCardHTML() {
  return `
    <section class="card">
      <div class="card-head"><h2>${icon("pencil", 18)}快速备忘</h2><span class="hint" id="memo-state">—</span></div>
      <textarea id="memo" class="memo-input" placeholder="随手写点什么，停笔自动保存…"></textarea>
    </section>`;
}

/* ---------------- 今日待办 ---------------- */

/** limit 传 0 表示不截断（完整模式）；传 HOME_TASK_LIMIT 就是简洁模式的「前 5 条」 */
function taskListHTML(p, limit = 0) {
  if (!p.total) {
    return emptyState(
      "今天还没有任务",
      "把最重要的一件事先写下来。",
      `<a class="btn primary" href="#plan">${icon("plus", 16)}加一条</a>`,
      "plan"
    );
  }
  const list = limit ? p.shown : p.mine;
  const timed = list.filter((t) => t.time);
  const untimed = list.filter((t) => !t.time);
  const rest = limit ? p.hidden : 0;
  return `
    ${
      timed.length
        ? `<div class="list-head"><span>按时间安排</span><span class="hint">${timed.length} 条</span></div>
           <ul class="tasks">${timed.map(row).join("")}</ul>`
        : ""
    }
    ${
      untimed.length
        ? `<div class="list-head"><span>待安排</span><span class="hint">${untimed.length} 条</span></div>
           <ul class="tasks">${untimed.map(row).join("")}</ul>`
        : ""
    }
    ${rest ? `<p class="more-link"><a class="link" href="#plan">还有 ${rest} 条，打开今日计划 →</a></p>` : ""}`;
}

/* ---------------- 模块卡片 ---------------- */

function modCard(card, showSub = false) {
  return `
    <a class="mod-card" href="#${card.id}" title="${esc(card.tip)}">
      <div class="mod-title"><span class="mod-icon">${icon(card.icon, 18)}</span>${esc(card.name)}</div>
      <div class="mod-main">${esc(card.main)}</div>
      ${showSub && card.sub ? `<div class="mod-sub">${esc(card.sub)}</div>` : ""}
      ${showSub && card.extra ? `<div class="mod-extra">${esc(card.extra)}</div>` : ""}
    </a>`;
}

/* ---------------- 完整模式（原布局） ---------------- */

function overviewStripHTML(p) {
  return `
    <section class="overview-strip">
      <div class="ov-item"><span>今日进度</span><strong>${p.percent}<small>%</small></strong></div>
      <div class="progress-track"><span style="width:${p.percent}%"></span></div>
      <div class="ov-item"><span>已完成</span><strong>${p.done}<small> / ${p.total}</small></strong></div>
      <div class="ov-item"><span>待安排</span><strong>${p.untimed}<small> 条</small></strong></div>
    </section>`;
}

function fullView(data, today) {
  const p = progressOf(data, today);
  const overdue = overdueTasks(data, today);
  const cards = cardsFor("full", data, today);
  return `
    ${heroHTML("full")}
    ${overviewStripHTML(p)}
    ${commandStripHTML()}
    ${memoCardHTML()}
    <section class="card">
      <div class="card-head">
        <h2>${icon("plan", 18)}今日待办</h2>
        <a class="link" href="#plan">打开今日计划 →</a>
      </div>
      ${overdueTip(overdue)}
      ${taskListHTML(p)}
    </section>
    <section class="mod-grid">${cards.highlight.map((c) => modCard(c, true)).join("")}</section>`;
}

/* ---------------- 欢迎语与小零件 ---------------- */

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return "夜深了";
  if (h < 9) return "早上好";
  if (h < 12) return "上午好";
  if (h < 14) return "中午好";
  if (h < 18) return "下午好";
  return "晚上好";
}

function row(t) {
  return `
    <li class="task${t.done ? " done" : ""}" data-id="${esc(t.id)}">
      <label class="check" title="${t.done ? "取消完成" : "标记完成"}">
        <input type="checkbox" data-act="toggle" ${t.done ? "checked" : ""}>
      </label>
      <span class="t-text">${esc(t.text)}</span>
      <span class="t-cat">${esc(t.category || "其他")}</span>
      <span class="t-time">${t.time ? esc(t.time) : ""}</span>
    </li>`;
}

function overdueTip(items) {
  if (!items.length) return "";
  return `<p class="tip">昨天及更早还有 ${items.length} 条没做完，
    <a class="link" href="#plan">去今日计划处理 →</a></p>`;
}

/* ---------------- 事件 ---------------- */

function onChange(e) {
  const box = e.target.closest('[data-act="toggle"]');
  if (!box) return;
  const li = box.closest("[data-id]");
  const task = table("tasks").find((t) => t.id === (li && li.dataset.id));
  if (!task) return;
  task.done = box.checked;
  task.doneAt = box.checked ? new Date().toISOString() : null;
  touch();
}

function onClick(e) {
  // 卡片整体可点，但卡片里的链接优先——不然点「债务欠款」会被卡片吞成「打开记账」
  const link = e.target.closest("a[href]");
  if (link && link.closest("[data-act]")) return;
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === "go") location.hash = btn.dataset.hash;
  else if (act === "home-view") setHomeView(btn.dataset.view);
  else if (act === "focus-memo") {
    const memo = document.getElementById("memo");
    if (memo) {
      memo.focus();
      memo.setSelectionRange(memo.value.length, memo.value.length);
    }
  }
}

function onInput(e) {
  if (e.target.id !== "memo") return;
  store.data.memo = e.target.value;
  const state = document.getElementById("memo-state");
  if (state) state.textContent = "正在保存…";
  touch(false, true); // 静默保存：不重画，光标不会跳
  clearTimeout(memoTimer);
  memoTimer = setTimeout(() => {
    const el = document.getElementById("memo-state");
    if (el) el.textContent = "已自动保存";
  }, 800);
}
