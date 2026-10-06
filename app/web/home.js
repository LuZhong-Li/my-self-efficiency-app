/* 首页总览：欢迎头部 / 快速备忘 / 今日待办 / 模块摘要看板 */

import { store, touch, table, esc, todayStr, formatDateCN, dateStr } from "./store.js";
import { bindFresh, emptyState } from "./ui.js";
import { SUMMARY_MODULES, moduleOf } from "./modules.js";
import { icon } from "./icons.js";
import { monthTotals, dayTotals } from "./finance-calc.js";
import { fmtMoney } from "./money.js";

let memoTimer = null;

export function renderHome(root) {
  const today = todayStr();
  const mine = table("tasks").filter((t) => t.date === today).sort(order);
  const overdue = table("tasks").filter((t) => t.date && t.date < today && !t.done);
  const open = mine.filter((t) => !t.done).length;
  const done = mine.length - open;
  const percent = mine.length ? Math.round((done / mine.length) * 100) : 0;
  const timed = mine.filter((t) => t.time);
  const untimed = mine.filter((t) => !t.time);
  const settings = (store.data && store.data.settings) || {};
  const slogan = (settings.slogan || "").trim();

  root.innerHTML = `
    <section class="hero">
      <div>
        <h1>${esc(greeting())}，小李</h1>
        ${slogan ? `<div class="hero-sub">${esc(slogan)}</div>` : ""}
      </div>
      <a class="btn primary" href="#plan">${icon("plus", 16)}${
        mine.length
          ? open
            ? `还有 ${open} 条待办`
            : "今天的都做完了"
          : "加今天第一件事"
      }</a>
    </section>

    <section class="overview-strip">
      <div class="ov-item"><span>今日进度</span><strong>${percent}<small>%</small></strong></div>
      <div class="progress-track"><span style="width:${percent}%"></span></div>
      <div class="ov-item"><span>已完成</span><strong>${done}<small> / ${mine.length}</small></strong></div>
      <div class="ov-item"><span>待安排</span><strong>${untimed.length}<small> 条</small></strong></div>
    </section>

    <nav class="command-strip" aria-label="快速操作">
      <span>快速操作</span>
      <button data-act="go" data-hash="#plan">${icon("plus", 16)}新建事项</button>
      <button data-act="focus-memo">${icon("pencil", 16)}记备忘</button>
      <button data-act="go" data-hash="#fitness">${icon("fitness", 16)}记训练</button>
      <button data-act="go" data-hash="#diet">${icon("diet", 16)}记饮食</button>
      <button data-act="go" data-hash="#media">${icon("media", 16)}加内容</button>
    </nav>

    <section class="card">
      <div class="card-head"><h2>${icon("pencil", 18)}快速备忘</h2><span class="hint" id="memo-state">—</span></div>
      <textarea id="memo" class="memo-input" placeholder="随手写点什么，停笔自动保存…"></textarea>
    </section>

    <section class="card">
      <div class="card-head">
        <h2>${icon("plan", 18)}今日待办</h2>
        <a class="link" href="#plan">打开今日计划 →</a>
      </div>
      ${overdueTip(overdue)}
      ${
        mine.length
          ? `
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
            }`
          : emptyState(
              "今天还没有任务",
              "把最重要的一件事先写下来。",
              `<a class="btn primary" href="#plan">${icon("plus", 16)}加一条</a>`,
              "plan"
            )
      }
    </section>

    <section class="mod-grid">${cards()}</section>
  `;

  const memo = root.querySelector("#memo");
  if (memo) memo.value = (store.data && store.data.memo) || "";

  bindFresh(root, { change: onChange, input: onInput, click: onClick });
}

/* ---------------- 欢迎头部 ---------------- */

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return "夜深了";
  if (h < 9) return "早上好";
  if (h < 12) return "上午好";
  if (h < 14) return "中午好";
  if (h < 18) return "下午好";
  return "晚上好";
}

function order(a, b) {
  if (a.done !== b.done) return a.done ? 1 : -1;
  const at = a.time || "99:99";
  const bt = b.time || "99:99";
  if (at !== bt) return at < bt ? -1 : 1;
  return (a.createdAt || "") < (b.createdAt || "") ? -1 : 1;
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

/* ---------------- 模块摘要 ---------------- */

function cards() {
  return SUMMARY_MODULES.map((id) => {
    const mod = moduleOf(id);
    const s = summary(id);
    return `
      <a class="mod-card" href="#${id}">
        <div class="mod-title"><span class="mod-icon">${icon(mod.icon, 18)}</span>${esc(mod.name)}</div>
        <div class="mod-main">${esc(s.main)}</div>
        <div class="mod-sub">${esc(s.sub)}</div>
      </a>`;
  }).join("");
}

function summary(id) {
  if (id === "media") {
    const items = table("contents");
    const n = (s) => items.filter((x) => x.status === s).length;
    return {
      main: `${n("待发布")} 条待发布`,
      sub: items.length
        ? `想法 ${n("想法")} · 写作中 ${n("写作中")} · 已发布 ${n("已发布")}`
        : "还没有内容",
    };
  }
  if (id === "dev") {
    const running = table("projects").filter((p) => p.status === "进行中").length;
    const open = table("issues").filter((i) => !["已解决", "已关闭"].includes(i.status)).length;
    return { main: `${running} 个项目进行中`, sub: `未解决 bug ${open} 条` };
  }
  if (id === "study") {
    const all = table("studies");
    const start = weekStartStr();
    const today = todayStr();
    const week = all
      .filter((s) => s.date >= start && s.date <= today)
      .reduce((sum, s) => sum + (Number(s.minutes) || 0), 0);
    const pending = all.filter((s) => !s.reviewed).length;
    const last = newest(all);
    return {
      main: `本周学了 ${week} 分钟`,
      sub: pending
        ? `待复习 ${pending} 条`
        : last
        ? `最近：${last.date} ${last.content || ""}`.trim()
        : "还没有学习记录",
    };
  }
  if (id === "finance") {
    const txs = table("finance.transactions");
    const today = todayStr();
    const month = today.slice(0, 7);
    const day = dayTotals(txs, today);
    const totals = monthTotals(txs, month);
    return {
      main: `今日支出 ${fmtMoney(day.expenseCents)}`,
      sub: txs.length ? `本月结余 ${fmtMoney(totals.balanceCents)}` : "还没有记账",
    };
  }
  if (id === "fitness") {
    const logs = table("workoutLogs");
    const start = weekStartStr();
    const today = todayStr();
    const days = new Set(
      logs.filter((l) => l.date >= start && l.date <= today).map((l) => l.date)
    );
    const last = newest(logs);
    return {
      main: `本周练了 ${days.size} 次`,
      sub: last ? `最近一次：${last.date}` : "还没有训练记录",
    };
  }
  if (id === "diet") {
    const today = todayStr();
    const meal = table("meals").find((m) => m.date === today);
    const water = table("water").find((w) => w.date === today);
    const eaten = meal
      ? ["breakfast", "lunch", "dinner", "snack"].filter((k) => (meal[k] || "").trim()).length
      : 0;
    const cups = water ? Number(water.cups) || 0 : 0;
    return { main: `今天记了 ${eaten} 餐`, sub: `喝水 ${cups} 杯` };
  }
  const playing = table("games").filter((g) => g.status === "在玩");
  return {
    main: playing.length ? `在玩 ${playing.length} 款` : "没有在玩的游戏",
    sub: playing.length ? playing.map((g) => g.name).join("、") : "还没有游戏记录",
  };
}

function newest(items) {
  return items.slice().sort((a, b) => ((a.date || "") < (b.date || "") ? 1 : -1))[0];
}

function weekStartStr() {
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // 周一算一周的开始
  return dateStr(d);
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
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  if (btn.dataset.act === "go") location.hash = btn.dataset.hash;
  else if (btn.dataset.act === "focus-memo") {
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
