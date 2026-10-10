/* 今日计划：今天的任务增删改勾，外加「昨天没做完的」一键挪到今天。
 * 2026-10-07 起录入改成弹窗（和别的模块一套），卡片上只留一个「添加任务」按钮。
 * 2026-10-07 起还会在进页面时对一遍「模块目标」：健身 / 学习 / 饮食的目标到了
 * 该做的日子，会自动在这里生成一条待办（带来源标签，正文还能改）。
 * 同日又加了和「游戏娱乐」的联动：右上角一个可关的开关，开着就把今天的游玩记录
 * 摘要露在这页顶上，还能顺手把「玩游戏放松」加成一条带来源标签的待办。 */

import {
  store, touch, todayStr, formatDateCN, table, esc, moveToTrash,
  planShowGameOf, setPlanShowGame,
} from "./store.js";
import { bindFresh, pageHeader, markEnter, priorityChip, sourceTag } from "./ui.js";
import { askConfirm, toast } from "./dialog.js";
import { renderCalendar } from "./calendar.js";
import { icon } from "./icons.js";
import { imgBadge } from "./attachment.js";
import { openItemDialog } from "./item-dialog.js";
import { syncGoalTasks, goalBriefHtml } from "./goals.js";
import { recordsOn, durationText } from "./game-calc.js";
import {
  planTasksOf, planStatsOf, overdueTasksOf, taskOwnerOf, devProjectOf, groupPlanTasks, dailyTargetsOf,
} from "./task-calc.js";
import { updateTaskStatus, toggleTaskInTodayPlan, bumpModuleProgress } from "./task-actions.js";
import { openDailyTargetDialog } from "./daily-target.js";
import { barLevelOf } from "./goal-calc.js";

let mode = "today";   // today = 今天的清单，month = 月历

export function renderPlan(root, sub = "") {
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

  // 从首页「各模块今日进度」点过来时地址形如 #plan/mod-fitness：滚到那个模块分组
  if (mode === "today" && /^mod-/.test(sub)) {
    const target = document.getElementById(sub);
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function renderTodayView(body) {
  const today = todayStr();
  // 先把今天该生成的目标待办补上，再照着最新的 tasks 画
  syncGoalTasks(today);
  const all = table("tasks");
  // 「今天的任务」= 日期是今天的 + 别的模块「加入今日计划」的（见 task-calc.js）
  const todayTasks = planTasksOf(all, today);
  const overdue = overdueTasksOf(all, today);
  const p = planStatsOf(todayTasks);
  const { groups, loose } = groupPlanTasks(todayTasks, dailyTargetsOf(store.data));

  body.innerHTML = `
    ${goalBriefHtml(today)}
    ${gameBriefHtml(today)}
    <div class="plan-stack">
      ${overdueCardHTML(overdue)}
      <section class="card plan-card today-card">
        <div class="plan-card-head">
          <div class="plan-head-row">
            <h2>今天的任务</h2>
            <span class="dev-stats plan-stats" title="今日计划的完成情况，从别的模块加进来的也算在内">
              <i>未完成 ${p.open}</i>
              <i>已完成 ${p.done}</i>
            </span>
            <div class="card-tools">
              <span class="hint">${p.total ? `完成 ${p.percent}%` : "一条都还没有"}</span>
              <button class="link" data-act="game-toggle" title="游戏娱乐里的游玩记录，要不要在今日计划露一面">${
                planShowGameOf() ? "不显示今日游玩" : "显示今日游玩"
              }</button>
              <button class="link" data-act="daily-config" title="设置每个模块的今日目标（类型 / 目标值 / 单位 / 步长）">${icon("settings", 14)}今日目标</button>
              <button class="btn primary small" data-act="add">${icon("plus", 14)}添加任务</button>
            </div>
          </div>
          <div class="progress-track plan-track goal-ov-bar" title="今天完成 ${p.percent}%">
            <span class="${barLevelOf(p.percent)}" style="width:${Math.min(100, p.percent)}%"></span>
          </div>
        </div>
        <div class="plan-card-body">
          ${
            todayTasks.length
              ? `${moduleGroupsHTML(groups)}
                 ${
                   loose.length
                     ? `${groups.length ? `<div class="list-head sep"><span>自己加的</span><span class="hint">${loose.length} 条</span></div>` : ""}
                        <ul class="tasks">${loose.map(row).join("")}</ul>`
                     : ""
                 }`
              : `<p class="empty plan-empty">今日暂无任务，点右上角「添加任务」创建一条。</p>`
          }
        </div>
      </section>
    </div>
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

/* ---------------- 画 ---------------- */

/** 按模块分的一组今日待办：组头是「模块名 + 进度条 + 数量 + 加/减」，
 *  下面这个模块今天的条目。加/减走同一个入口（bumpModuleProgress），
 *  本质是勾 / 取消勾条目，所以和复选框、首页卡片三处永远一致。 */
function moduleGroupsHTML(groups) {
  return groups
    .map(
      (g) => `
    <div class="plan-group" id="mod-${esc(g.key)}" data-group="${esc(g.key)}">
      <div class="list-head plan-group-head">
        <button class="plan-group-name" data-act="group-toggle" title="折叠 / 展开「${esc(g.name)}」">${icon("arrowRight", 14)}${esc(g.name)}</button>
        <span class="progress-track goal-ov-bar plan-group-bar"><span class="${g.level}" style="width:${Math.min(100, g.percent)}%"></span></span>
        <span class="day-ctrl">
          <button class="day-btn" data-act="daily-minus" data-module="${esc(g.key)}" title="减一步" ${g.current > 0 ? "" : "disabled"}>${icon("minus", 14)}</button>
          <span class="goal-ov-num${g.over ? " over" : ""}">${g.current}/${g.target} ${esc(g.unit)}${g.over ? `<em class="goal-ov-over">超额</em>` : ""}</span>
          <button class="day-btn" data-act="daily-plus" data-module="${esc(g.key)}" title="加一步（追加一条已完成的快速记录）">${icon("plus", 14)}</button>
        </span>
      </div>
      <ul class="tasks">${g.tasks.map(row).join("")}</ul>
    </div>`
    )
    .join("");
}

/** 卡片 A：逾期待办（独立的一张玻璃卡片，内部自己滚动，不带动下面那张） */
function overdueCardHTML(items) {
  const body = items.length
    ? `<ul class="tasks">
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
      </ul>`
    : `<p class="empty plan-empty">暂无逾期任务 🎉</p>`;
  return `
    <section class="card plan-card overdue-card">
      <div class="plan-card-head">
        <div class="plan-head-row">
          <h2>昨天及更早没做完的（${items.length} 条）</h2>
          ${items.length ? `<button class="btn small" data-act="move-all">全部挪到今天</button>` : ""}
        </div>
      </div>
      <div class="plan-card-body">${body}</div>
    </section>`;
}

function row(t) {
  // 挂在开发工作项目上的待办是「外来的」：删除要回项目里删，这里只给移出 + 回项目
  const dev = taskOwnerOf(t) === "dev";
  const pid = devProjectOf(t);
  return `
    <li class="task ${t.done ? "done" : ""}" data-id="${esc(t.id)}">
      <label class="check" title="${t.done ? "取消完成" : "标记完成"}">
        <input type="checkbox" data-act="toggle" ${t.done ? "checked" : ""}>
      </label>
      <span class="t-time">${t.time ? esc(t.time) : "—"}</span>
      <span class="t-text">${esc(t.text)}</span>
      ${priorityChip(t.priority)}
      ${imgBadge(t.imagePaths, "图")}
      ${sourceTag(t)}
      ${t.category ? `<span class="t-cat">${esc(t.category)}</span>` : ""}
      <span class="t-note">${esc(t.note || "")}</span>
      <span class="t-actions">
        <button class="link" data-act="edit">编辑</button>
        ${
          dev
            ? `<button class="link" data-act="unplan" title="只从今日计划里移出去，任务留在开发工作的项目里">移出今日计划</button>
               <a class="link" href="#dev/${esc(pid)}">回项目</a>`
            : `<button class="link danger" data-act="delete">删除</button>`
        }
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
  if (act === "daily-plus") {
    bumpModuleProgress(btn.dataset.module, 1, todayStr());
    return;
  }
  if (act === "daily-minus") {
    bumpModuleProgress(btn.dataset.module, -1, todayStr());
    return;
  }
  if (act === "daily-config") {
    openDailyTargetDialog();
    return;
  }
  if (act === "group-toggle") {
    const group = btn.closest("[data-group]");
    if (group) group.classList.toggle("collapsed");
    return;
  }

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
    // 挪的就是逾期卡上那几条（同一份筛选：归档的和做完的都不算），
    // 不再自己另写一遍条件，免得哪天两边走岔把归档的也改了
    const today = todayStr();
    const overdue = overdueTasksOf(table("tasks"), today);
    for (const t of overdue) t.date = today;
    if (overdue.length) touch(true);
    return;
  }

  const li = btn.closest("[data-id]");
  const task = li ? findTask(li.dataset.id) : null;
  if (!task) return;

  if (act === "edit") {
    // 开发工作的待办用它自己那张字段表改（优先级、备注都在），改的是同一条记录
    if (taskOwnerOf(task) === "dev") openItemDialog("devTodo", task, { pid: devProjectOf(task) });
    else openItemDialog("todayPlan", task);
  } else if (act === "unplan") {
    toggleTaskInTodayPlan(task.id, false);
    toast("已移出今日计划，任务还在开发工作里");
  } else if (act === "move") {
    if (task.isArchived) return toast("这条已经归档了，先恢复再挪", "err");
    task.date = todayStr();
    touch(true);
  } else if (act === "delete") {
    // 外来的待办只能在原模块删（防止在今日计划里误删别的模块的东西）
    if (taskOwnerOf(task) === "dev") {
      toast("这条待办属于开发工作的项目，请回项目里删", "err");
      return;
    }
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
  if (!li) return;
  // 统一入口：勾完立刻落盘，首页总览、原模块那条跟着一起变
  updateTaskStatus(li.dataset.id, box.checked);
}
