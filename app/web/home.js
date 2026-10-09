/* 首页总览：双视图（简洁 / 完整）
 *
 * 简洁：核心区（今日进度 & 待办 ｜ 财务摘要）+ 高频模块卡 + 「其他模块」折叠 + 辅助区。
 * 完整：原来的全卡片平铺，一行布局都不动。
 *
 * 「哪个视图显示哪些卡、卡片正面写什么、提示写什么、进度怎么算」全在
 * home-view.js 里算（纯函数，有单测）；这个文件只管画和接事件。
 */

import {
  store, touch, esc, todayStr,
  homeViewOf, setHomeView, memoCollapsedOf, setMemoCollapsed,
} from "./store.js";
import {
  HOME_TASK_LIMIT, progressOf, overdueTasks, cardsFor, otherVisibleIn,
  financeBriefOf, financeTextOf,
} from "./home-view.js";
import { bindFresh, emptyState, priorityChip, sourceTag } from "./ui.js";
import { icon } from "./icons.js";
import { updateTaskStatus, bumpModuleProgress } from "./task-actions.js";
import { overviewRowsOf } from "./goal-calc.js";
import { planTasksOf, groupPlanTasks, dailyTargetsOf } from "./task-calc.js";
import { openDailyTargetDialog } from "./daily-target.js";

let memoTimer = null;

export function renderHome(root) {
  const today = todayStr();
  const data = store.data || {};
  const mode = homeViewOf();

  root.innerHTML = mode === "simple" ? simpleView(data, today) : fullView(data, today);

  const memo = root.querySelector("#memo");
  if (memo) memo.value = (store.data && store.data.memo) || "";

  bindFresh(root, { change: onChange, input: onInput, click: onClick, keydown: onKeydown });
  bindMorePanel(root);
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
            data-view="simple" title="日常仪表盘｜聚焦今日任务与财务">${icon("list", 16)}简洁模式</button>
          <button class="btn small${mode === "full" ? " active" : ""}" data-act="home-view"
            data-view="full" title="全模块总览｜适合复盘查看全部模块数据">${icon("grid", 16)}完整模式</button>
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
  const collapsed = memoCollapsedOf();
  return `
    <section class="card memo-card">
      <div class="card-head">
        <h2>${icon("pencil", 18)}快速备忘</h2>
        <span class="card-tools">
          <span class="hint" id="memo-state">—</span>
          <button class="memo-toggle" data-act="memo-toggle" aria-expanded="${collapsed ? "false" : "true"}"
            title="${collapsed ? "展开快速备忘" : "收起快速备忘"}">${icon(collapsed ? "plus" : "minus", 16)}</button>
        </span>
      </div>
      ${
        collapsed
          ? ""
          : `<textarea id="memo" class="memo-input" placeholder="随手写点什么，停笔自动保存…"></textarea>`
      }
    </section>`;
}

/* ---------------- 今日待办 ---------------- */

/** limit 传 0 表示不截断（完整模式）；传 HOME_TASK_LIMIT 就是简洁模式的「前 5 条」 */
function taskListHTML(p, limit = 0) {
  if (!p.total) {
    return emptyState(
      "今日暂无任务",
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
        ? `<div class="list-head${timed.length ? " sep" : ""}"><span>待安排</span><span class="hint">${untimed.length} 条</span></div>
           <ul class="tasks">${untimed.map(row).join("")}</ul>`
        : ""
    }
    ${rest ? `<p class="more-link"><a class="link" href="#plan">还有 ${rest} 条，查看更多待办 →</a></p>` : ""}`;
}

/* ---------------- 模块卡片 ---------------- */

function modCard(card, showSub = false) {
  return `
    <a class="mod-card" href="#${card.id}" title="${esc(card.tip)}">
      <div class="mod-title"><span class="mod-icon">${icon(card.icon, 18)}</span>${esc(card.name)}</div>
      <div class="mod-main${card.empty ? " mod-main-none" : ""}">${esc(card.main)}</div>
      ${showSub && card.sub ? `<div class="mod-sub">${esc(card.sub)}</div>` : ""}
      ${showSub && card.extra ? `<div class="mod-extra">${esc(card.extra)}</div>` : ""}
    </a>`;
}

/* ---------------- 目标总览（健身 / 学习 / 饮食的模块目标汇总） ----------------
   只读卡片：现读 moduleGoals + tasks 算进度，点一行跳回对应模块页去改；
   卡片自己不存数据、也不给编辑（数据源头始终在各模块里）。
   完整模式直接摆出来；简洁模式塞进「其他模块」折叠里，展开才渲染（见 bindMorePanel）。 */

function targetRowHTML(r) {
  return `
    <a class="goal-ov-row${r.off ? " off" : ""}" href="${r.route}" title="打开${esc(r.moduleName)}模块">
      <span class="goal-ov-name">${icon(r.moduleIcon, 16)}<span title="${esc(r.title)}">${esc(r.title)}</span></span>
      <span class="progress-track goal-ov-bar">
        <span class="${r.level}" style="width:${r.percent}%"></span>
      </span>
      <span class="goal-ov-num">${r.done}/${r.total} ${esc(r.unit)}${r.overtime ? `<em class="goal-ov-over">超额</em>` : ""}</span>
    </a>`;
}

function targetOverviewHTML(rows) {
  const body = rows.length
    ? `<div class="goal-ov-list">${rows.map(targetRowHTML).join("")}</div>`
    : `<p class="goal-ov-empty">暂未设置模块目标，前往健身 / 学习 / 饮食模块添加</p>`;
  return `
    <section class="card goal-ov-card">
      <div class="card-head">
        <h2>📌 目标总览</h2>
        <div class="card-tools"><span class="hint">${rows.length ? `共 ${rows.length} 个目标` : "暂无目标"}</span></div>
      </div>
      ${body}
    </section>`;
}

/* ---------------- 各模块今日进度（首页那张带 +/− 的卡片） ----------------
   今天这列待办按模块归堆：健身 / 学习 / 饮食 / 开发工作 / 游戏娱乐，每组一行。
   进度是现算的（勾了几条就是几条）；「+ / −」也只是去勾 / 取消勾这一组的条目，
   和今日计划里的分组、勾选框共用一个数据源，两边永远一致。 */

function dailyGroupsOf(data, today) {
  return groupPlanTasks(planTasksOf((data && data.tasks) || [], today), dailyTargetsOf(data)).groups;
}

function dailyCtrlHTML(g) {
  return `
    <span class="day-ctrl">
      <button class="day-btn" data-act="daily-minus" data-module="${g.key}"
        title="减一步（撤掉最后一条快速记录，或取消勾选一条完成的）" aria-label="减少一步" ${g.current > 0 ? "" : "disabled"}>${icon("minus", 14)}</button>
      <span class="goal-ov-num${g.over ? " over" : ""}">${g.current}/${g.target} ${esc(g.unit)}${g.over ? `<em class="goal-ov-over">超额</em>` : ""}</span>
      <button class="day-btn" data-act="daily-plus" data-module="${g.key}"
        title="加一步（追加一条已完成的快速记录）" aria-label="增加一步">${icon("plus", 14)}</button>
    </span>`;
}

function dailyRowHTML(g) {
  return `
    <div class="goal-ov-row day-row" data-route="#plan/mod-${g.key}" role="link" tabindex="0"
      title="去今日计划看「${esc(g.name)}」今天的安排">
      <span class="goal-ov-name">${icon(g.icon, 16)}<span>${esc(g.name)}</span></span>
      <span class="progress-track goal-ov-bar">
        <span class="${g.level}" style="width:${Math.min(100, g.percent)}%"></span>
      </span>
      ${dailyCtrlHTML(g)}
    </div>`;
}

function dailyProgressCardHTML(groups) {
  const body = groups.length
    ? `<div class="goal-ov-list">${groups.map(dailyRowHTML).join("")}</div>`
    : `<p class="goal-ov-empty">暂无今日计划，去健身 / 学习 / 饮食模块设置目标，或往今日计划里加一条。</p>`;
  return `
    <section class="card goal-ov-card day-card">
      <div class="card-head">
        <h2>📌 各模块今日进度</h2>
        <div class="card-tools">
          <span class="hint">${groups.length ? "点 + / − 快速记一笔，点整行去今日计划" : "暂无今日计划"}</span>
          <button class="link" data-act="daily-config" title="设置每个模块的今日目标（类型 / 目标值 / 单位 / 步长）">${icon("settings", 14)}今日目标</button>
        </div>
      </div>
      ${body}
    </section>`;
}

/** 「其他模块」折叠面板：用原生 <details>，零 JS、键盘也能开。
 *  三个次要模块一条数据都没有时，整个面板不渲染（不留空壳）。 */
function otherPanelHTML(cards, visible) {
  if (!visible) return "";
  return `
    <details class="home-more">
      <summary>${icon("grid", 16)}其他模块（健身计划、饮食计划、游戏娱乐）</summary>
      <div class="goal-ov-slot" data-day-ov></div>
      <div class="goal-ov-slot" data-goal-ov></div>
      <div class="mod-grid">${cards.map((c) => modCard(c, false)).join("")}</div>
    </details>`;
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
    ${dailyProgressCardHTML(dailyGroupsOf(data, today))}
    <section class="card">
      <div class="card-head">
        <h2>${icon("plan", 18)}今日待办</h2>
        <a class="link" href="#plan">打开今日计划 →</a>
      </div>
      ${overdueTip(overdue)}
      ${taskListHTML(p)}
    </section>
    ${targetOverviewHTML(overviewRowsOf(data, today))}
    <section class="mod-grid">${cards.highlight.map((c) => modCard(c, true)).join("")}</section>`;
}

/* ---------------- 简洁模式（默认） ---------------- */

function simpleView(data, today) {
  const p = progressOf(data, today);
  const overdue = overdueTasks(data, today);
  const brief = financeBriefOf(data, today);
  const money = financeTextOf(brief);
  const cards = cardsFor("simple", data, today);
  const goals = overviewRowsOf(data, today);
  const daily = dailyGroupsOf(data, today);
  return `
    ${heroHTML("simple")}
    <div class="home-core">
      <section class="card home-progress">
        <div class="card-head">
          <h2>${icon("plan", 18)}今日进度</h2>
          <span class="home-head-note">已完成 ${p.done} / ${p.total} ｜ 待安排 ${p.untimed} 条</span>
        </div>
        <div class="home-progress-row">
          <strong class="home-percent">${p.percent}<small>%</small></strong>
          <div class="progress-track"><span style="width:${p.percent}%"></span></div>
        </div>
        ${overdueTip(overdue)}
        ${taskListHTML(p, HOME_TASK_LIMIT)}
      </section>
      <aside class="card home-finance" data-act="go" data-hash="#finance" title="打开记账">
        <div class="card-head">
          <h2>${icon("money", 18)}财务摘要</h2>
          <a class="link" href="#finance">去记账 →</a>
        </div>
        <div class="home-money">
          <div class="home-money-item">
            <span>${esc(money.expenseLabel)}</span>
            <strong${brief.hasTodayExpense ? "" : ' class="home-money-none"'}>${esc(money.expenseText)}</strong>
          </div>
          ${
            money.balanceText
              ? `<div class="home-money-item">
                   <span>${esc(money.balanceLabel)}</span>
                   <strong>${esc(money.balanceText)}</strong>
                 </div>`
              : ""
          }
        </div>
        ${
          brief.debt
            ? `<a class="home-alert${brief.debt.level === "overdue" ? " overdue" : ""}" href="#finance/debt"
                 title="${esc(brief.debt.tip)}">${icon("warning", 14)}${esc(brief.debt.text)}
                 <span class="home-alert-tip">${esc(brief.debt.tip)}</span></a>`
            : ""
        }
      </aside>
    </div>
    <section class="mod-grid">${cards.highlight.map((c) => modCard(c, false)).join("")}</section>
    ${otherPanelHTML(cards.other, otherVisibleIn(data) || goals.length > 0 || daily.length > 0)}
    ${commandStripHTML()}
    ${memoCardHTML()}`;
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
      ${priorityChip(t.priority)}
      ${sourceTag(t)}
      ${t.category ? `<span class="t-cat">${esc(t.category)}</span>` : ""}
      <span class="t-time">${t.time ? esc(t.time) : ""}</span>
    </li>`;
}

function overdueTip(items) {
  if (!items.length) return "";
  // 整条都能点，不用非去戳那行蓝字
  return `<a class="tip tip-link" href="#plan">昨天及更早还有 ${items.length} 条没做完，
    去今日计划处理 →</a>`;
}

/* ---------------- 事件 ---------------- */

/** 简洁模式下「目标总览」藏在「其他模块」折叠里：展开时才现读现画。
 *  折叠着的时候这个槽是空的，等于这一块不渲染（首页信息压力小一点）。
 *  <details> 的 toggle 事件不冒泡，所以直接挂在它自己身上，不走 bindFresh 那层代理。 */
function bindMorePanel(root) {
  const details = root.querySelector("details.home-more");
  if (!details) return;
  const daySlot = details.querySelector("[data-day-ov]");
  const goalSlot = details.querySelector("[data-goal-ov]");
  if (!daySlot && !goalSlot) return;
  const draw = () => {
    if (!details.open) return;
    const today = todayStr();
    const data = store.data || {};
    if (daySlot) daySlot.innerHTML = dailyProgressCardHTML(dailyGroupsOf(data, today));
    if (goalSlot) goalSlot.innerHTML = targetOverviewHTML(overviewRowsOf(data, today));
  };
  draw();
  details.addEventListener("toggle", draw);
}

function onChange(e) {
  const box = e.target.closest('[data-act="toggle"]');
  if (!box) return;
  const li = box.closest("[data-id]");
  if (!li) return;
  // 和今日计划、原模块共用同一个入口：在这里勾完，那边那条跟着变
  updateTaskStatus(li.dataset.id, box.checked);
}

function onClick(e) {
  // 卡片整体可点，但卡片里的链接优先——不然点「债务欠款」会被卡片吞成「打开记账」
  const link = e.target.closest("a[href]");
  if (link && link.closest("[data-act]")) return;
  const btn = e.target.closest("[data-act]");
  if (!btn) {
    // 「各模块今日进度」那一行：点空白处（不是 + / − 按钮）就跳去今日计划对应分组
    const row = e.target.closest(".goal-ov-row[data-route]");
    if (row) location.hash = row.dataset.route;
    return;
  }
  const act = btn.dataset.act;
  if (act === "daily-plus") bumpModuleProgress(btn.dataset.module, 1, todayStr());
  else if (act === "daily-minus") bumpModuleProgress(btn.dataset.module, -1, todayStr());
  else if (act === "daily-config") openDailyTargetDialog();
  else if (act === "go") location.hash = btn.dataset.hash;
  else if (act === "home-view") setHomeView(btn.dataset.view);
  else if (act === "memo-toggle") setMemoCollapsed(!memoCollapsedOf());
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

/** 「各模块今日进度」那一行用键盘也能进（Enter / 空格），和鼠标点空白处一样 */
function onKeydown(e) {
  if (e.key !== "Enter" && e.key !== " ") return;
  const row = e.target.closest && e.target.closest(".goal-ov-row[data-route]");
  if (!row || e.target !== row) return;
  e.preventDefault();
  location.hash = row.dataset.route;
}
