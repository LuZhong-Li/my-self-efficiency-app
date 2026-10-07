/* 游戏娱乐：游玩记录 + 游玩统计 + 游戏清单（在玩 / 想玩 / 已通关 / 弃坑）。
 *
 * 页面从上到下三张卡片：
 *   1. 🎮 游玩记录 —— 默认看当天，能翻日期、按游戏名和日期范围翻历史；
 *   2. 📊 游玩统计 —— 今日 / 本周 / 本月 / 全年 + 玩得最多的 TOP3；
 *   3. 📋 游戏清单 —— 四个状态分组，累计时长由游玩记录自动加出来。
 *
 * 录入还是老规矩：卡片上只留一个蓝色按钮，点开弹窗填（type = gamePlayRecord），
 * 字段表和其他模块共用 item-form.js 那一套。纯计算（时长换算、统计、排行、筛选）
 * 在 game-calc.js 里，node tests\游戏计算.test.mjs 能一条条断言。
 */

import { touch, table, esc, todayStr, shiftDate, moveToTrash } from "./store.js";
import { sectionHead, emptyState, chip, bindFresh, pageHeader } from "./ui.js";
import { askConfirm, toast } from "./dialog.js";
import { icon } from "./icons.js";
import { imgBadge } from "./attachment.js";
import { openItemDialog } from "./item-dialog.js";
import { GAME_STATUSES } from "./item-form.js";
import {
  recordsOn, recordsOfGame, statsOf, topGames, filterRecords, hasFilter,
  durationText, hoursText, totalMinutesOfGame, elapsedMinutes, clockText, overTargetGames,
} from "./game-calc.js";

let viewDate = null;                              // 游玩记录卡片在看哪一天（默认今天）
const filter = { name: "", from: "", to: "" };    // 历史筛选（点清单里的「看记录」也会写进来）
const timer = { startedAt: 0, tick: null };       // 快速计时（开始那一刻的时间戳）
const TIMER_KEY = "xiali-game-timer";             // 记在 sessionStorage 里，切到别的模块再回来还在计

let sorters = [];                                 // 游戏清单四个分组的拖拽（一组一个实例，共享 group）

export function renderGame(root) {
  const games = table("games");
  const records = table("gameRecords");
  const today = todayStr();
  if (!viewDate) viewDate = today;

  const days = isDayView();
  const dayRecords = recordsOn(records, viewDate);
  const history = days ? [] : filterRecords(records, filter);
  const stats = statsOf(records, today);
  const top = topGames(records, games, 3);
  const over = overTargetGames(records, games, today.slice(0, 7));

  root.innerHTML = `
    ${pageHeader("game", `<span class="date-chip">共 ${games.length} 款 · 今日 ${esc(durationText(stats.todayMin))}</span>`)}
    ${recordCardHtml({ dayRecords, history, stats })}
    ${statsCardHtml(stats, top, over)}
    ${listCardHtml(games, records)}
  `;

  bindFresh(root, { click: onClick, change: onChange, input: onInput });
  applyDragSort(root);
  startTicker();
}

/** 筛选框全空的时候，上面的列表就是「这一天的记录」；填了任意一个就是翻历史 */
function isDayView() {
  return !hasFilter(filter);
}

/* ---------------- 卡片一：游玩记录 ---------------- */

function recordCardHtml({ dayRecords, history, stats }) {
  const days = isDayView();
  const list = days ? dayRecords : history;
  const running = timerStartedAt();
  return `
    <section class="card gm-records">
      <div class="card-head">
        <h2>🎮 游玩记录</h2>
        <div class="card-tools">
          <span class="hint">${
            days
              ? `${esc(dayText(viewDate))}${list.length ? ` · ${list.length} 条` : ""}`
              : `筛出 ${list.length} 条 / 共 ${stats.count} 条`
          }</span>
          <button class="btn primary small" data-act="gm-add">${icon("plus", 14)}添加游玩记录</button>
        </div>
      </div>

      <div class="gm-bar">
        <button class="icon-btn" data-act="gm-prev" title="前一天">‹</button>
        <input id="game-date" type="date" value="${esc(viewDate)}" title="看哪一天的游玩记录">
        <button class="icon-btn" data-act="gm-next" title="后一天">›</button>
        <button class="btn small" data-act="gm-today">回到今天</button>
        <span class="gm-bar-gap"></span>
        ${
          running
            ? `<span class="gm-timer" id="gm-timer">${icon("plan", 14)}<b>${esc(
                clockText(running, Date.now())
              )}</b> 计时中</span>
               <button class="btn small primary" data-act="gm-timer-stop">停止并记录</button>
               <button class="link" data-act="gm-timer-cancel">取消计时</button>`
            : `<button class="btn small" data-act="gm-timer-start">${icon("plan", 14)}开始计时</button>`
        }
      </div>

      <div class="gm-filter">
        <span class="gm-filter-label">翻历史</span>
        <input id="game-filter-name" maxlength="40" autocomplete="off"
          placeholder="按游戏名筛…" value="${esc(filter.name)}">
        <input id="game-filter-from" type="date" value="${esc(filter.from)}" title="从哪天起">
        <span class="gm-filter-sep">到</span>
        <input id="game-filter-to" type="date" value="${esc(filter.to)}" title="到哪天">
        ${isDayView() ? "" : `<button class="btn small" data-act="gm-filter-clear">清除筛选</button>`}
      </div>

      ${
        list.length
          ? `<ul class="items">${list.map((r) => recordRow(r, !days)).join("")}</ul>`
          : emptyState(
              days ? "这天还没记游玩" : "没有匹配的游玩记录",
              days
                ? "点右上角「添加游玩记录」记一条，或者按「开始计时」让程序帮你算时长。"
                : "换个游戏名或者换个日期范围试试，也可以点「清除筛选」。",
              "",
              "game"
            )
      }
    </section>`;
}

function recordRow(r, withDate) {
  return `
    <li class="item" data-id="${esc(r.id)}">
      <span class="i-title">${esc(r.gameName || "（没写游戏名）")}</span>
      ${chip(durationText(r.durationMin))}
      ${withDate ? `<span class="i-meta">${esc(r.playDate || "")}</span>` : ""}
      ${imgBadge(r.imagePaths, "图")}
      <span class="i-note">${esc(r.remark || "")}</span>
      <span class="i-actions">
        <button class="link" data-act="gr-edit">编辑</button>
        <button class="link danger" data-act="gr-del">删除</button>
      </span>
    </li>`;
}

/* ---------------- 卡片二：游玩统计 ---------------- */

function statsCardHtml(stats, top, over) {
  const cells = [
    ["今日", stats.todayMin],
    ["本周", stats.weekMin],
    ["本月", stats.monthMin],
    ["全年", stats.yearMin],
    ["累计", stats.allMin],
  ];
  return `
    <section class="card gm-stats">
      <div class="card-head">
        <h2>📊 游玩统计</h2>
        <span class="hint">${
          stats.count ? `共 ${stats.count} 条记录 · 玩过 ${stats.days} 天` : "有游玩记录后自动汇总"
        }</span>
      </div>
      <div class="gm-grid">
        ${cells
          .map(
            ([label, minutes]) => `
          <div class="gm-stat">
            <span>${label}</span>
            <strong>${esc(hoursText(minutes))}</strong>
            <small>${esc(minutes ? `${minutes} 分钟` : "—")}</small>
          </div>`
          )
          .join("")}
      </div>
      ${sectionHead("玩得最多的游戏 TOP3", top.length, top.length ? "点一条看它的全部记录" : "")}
      ${
        top.length
          ? `<ul class="items">${top.map(topRow).join("")}</ul>`
          : `<p class="empty">还没有游玩记录，上面记一条就会出现排行。</p>`
      }
      ${
        over.length
          ? `<p class="gm-warn">⚠️ 本月超过自己设的目标：${over
              .map((g) => `${esc(g.name)} 已玩 ${esc(durationText(g.minutes))}（目标 ${esc(hoursText(g.targetMinutes))}）`)
              .join("；")}</p>`
          : ""
      }
    </section>`;
}

function topRow(g, index) {
  return `
    <li class="item gm-top" data-name="${esc(g.name)}">
      <span class="gm-rank">${index + 1}</span>
      <span class="i-title">${esc(g.name)}</span>
      <span class="chip">${esc(durationText(g.minutes))}</span>
      <span class="i-note">${g.count ? `${g.count} 条记录` : "原有手填"}</span>
      <span class="i-actions">
        <button class="link" data-act="gm-history" data-name="${esc(g.name)}">看记录</button>
      </span>
    </li>`;
}

/* ---------------- 卡片三：游戏清单 ---------------- */

function listCardHtml(games, records) {
  return `
    <section class="card">
      <div class="card-head">
        <h2>📋 游戏清单</h2>
        <div class="card-tools">
          <span class="hint">按住一行可以拖动排序，拖到别的分组就是换状态</span>
          <button class="btn primary small" data-act="add">${icon("plus", 14)}添加游戏</button>
        </div>
      </div>
      ${
        games.length
          ? GAME_STATUSES.map((s) => block(games, records, s)).join("")
          : emptyState("还没有游戏", "点右上角「添加游戏」，想玩的、在玩的、通关的都记一下。", "", "game")
      }
    </section>`;
}

function block(games, records, status) {
  const list = games.filter((g) => (g.status || "想玩") === status);
  const minutes = list.reduce((sum, g) => sum + totalMinutesOfGame(records, g), 0);
  const extra = list.length ? `累计 ${hoursText(minutes)}` : "";
  return (
    sectionHead(status, list.length, extra) +
    `<ul class="items gm-list" data-sort="${esc(status)}">` +
    (list.length
      ? list.map((g) => row(g, records)).join("")
      : `<li class="gm-drop-hint">把一款游戏拖到这儿 = 改成「${esc(status)}」</li>`) +
    `</ul>`
  );
}

function row(g, records) {
  const minutes = totalMinutesOfGame(records, g);
  const mine = recordsOfGame(records, g);
  const legacy = Number(g.hours) || 0;
  const source = mine.length
    ? `${mine.length} 条记录`
    : legacy
    ? `原有手填 ${legacy} 小时`
    : "";
  const target = Number(g.targetHours) || 0;
  return `
    <li class="item${g.status === "已通关" || g.status === "弃坑" ? " done" : ""}" data-id="${esc(g.id)}">
      <span class="i-title">${esc(g.name)}</span>
      ${chip(g.platform)}
      ${imgBadge(g.imagePaths, "图")}
      ${g.finishDate ? chip("通关 " + g.finishDate) : ""}
      <span class="i-meta" title="${esc(minutes ? `累计 ${durationText(minutes)}` : "还没记过游玩时长")}">${
        minutes ? esc("累计 " + durationText(minutes)) : ""
      }</span>
      <span class="i-meta">${esc(source)}</span>
      ${target ? `<span class="i-meta">目标 ${esc(target)} 小时/月</span>` : ""}
      <span class="i-note">${esc(g.progress || "")}</span>
      <span class="i-actions">
        <button class="link" data-act="gm-history" data-name="${esc(g.name)}">看记录</button>
        <button class="link" data-act="edit">编辑</button>
        <button class="link danger" data-act="delete">删除</button>
      </span>
    </li>`;
}

/* ---------------- 弹窗：选项与打开 ---------------- */

/** 「游戏名」那一格的候选项：在玩的排前面，想玩、已通关、弃坑跟在后面 */
function gameChoices(games) {
  const rank = { 在玩: 0, 想玩: 1, 已通关: 2, 弃坑: 3 };
  return (games || [])
    .filter((g) => g && g.name)
    .slice()
    .sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9))
    .map((g) => ({ value: g.name, label: g.status ? `${g.name} · ${g.status}` : g.name }));
}

/** 名字 → 游戏 id：下拉里选过的名字自动绑上清单里那款，累计时长才算得到它头上 */
function gameIdMap(games) {
  const map = {};
  for (const g of games || []) {
    if (g && g.name && !(g.name in map)) map[g.name] = g.id;
  }
  return map;
}

function openRecordDialog(record, defaults) {
  const games = table("games");
  openItemDialog("gamePlayRecord", record, {
    date: viewDate,
    defaults: defaults || {},
    ctx: { gameOptions: gameChoices(games), gameIdByName: gameIdMap(games) },
    onSaved: (saved) => {
      // 记到别的日子就跟着切过去；筛出来的结果里看不到这条时，把筛选清掉，
      // 免得存完像没存上一样。
      if (saved.playDate) viewDate = saved.playDate;
      if (!isDayView() && !filterRecords([saved], filter).length) clearFilter();
      redraw();
    },
  });
}

function clearFilter() {
  filter.name = "";
  filter.from = "";
  filter.to = "";
}

/* ---------------- 快速计时 ---------------- */

function timerStartedAt() {
  if (timer.startedAt) return timer.startedAt;
  try {
    timer.startedAt = Number(sessionStorage.getItem(TIMER_KEY)) || 0;
  } catch {
    timer.startedAt = 0;   // 隐私模式之类读不到 sessionStorage，就当没在计时
  }
  return timer.startedAt;
}

function startTimer() {
  timer.startedAt = Date.now();
  try {
    sessionStorage.setItem(TIMER_KEY, String(timer.startedAt));
  } catch {
    /* 存不下就只在这次会话里计着，不影响用 */
  }
}

function stopTimer() {
  const started = timerStartedAt();
  const minutes = elapsedMinutes(started, Date.now());
  timer.startedAt = 0;
  try {
    sessionStorage.removeItem(TIMER_KEY);
  } catch {
    /* 上面没存下，这里也没什么好删的 */
  }
  return minutes;
}

/** 每秒把「00:12:34」刷一下。只改那一行字，不重画整页，免得一闪一闪 */
function startTicker() {
  if (timer.tick || !timerStartedAt()) return;
  timer.tick = setInterval(() => {
    const box = document.getElementById("gm-timer");
    if (!box) {
      clearInterval(timer.tick);
      timer.tick = null;
      return;
    }
    const num = box.querySelector("b");
    if (num) num.textContent = clockText(timerStartedAt(), Date.now());
  }, 1000);
}

/* ---------------- 拖拽排序 ---------------- */

/**
 * 游戏清单那一行的拖拽：四个状态分组共享一个 group，行可以在组内排，
 * 也可以拖到别的组（拖过去就跟着改状态）。用的是本地那个 SortableJS（不联网），
 * 库没加载成功也不影响别的功能，只是拖不动。
 *
 * 一个分组挂一个实例（这个版本的 Sortable 只吃单个元素，给数组会报
 * "el must be an HTMLElement"），四个都叫同一个 group，彼此就能互相收。
 */
function applyDragSort(root) {
  for (const s of sorters) {
    try {
      s.destroy();
    } catch {
      /* 旧元素已经不在页面上了，忽略 */
    }
  }
  sorters = [];
  if (typeof window.Sortable !== "function") return;

  for (const list of root.querySelectorAll(".gm-list")) {
    sorters.push(
      new window.Sortable(list, {
        group: "games",
        animation: 180,
        ghostClass: "card-ghost",
        chosenClass: "card-chosen",
        dragClass: "card-follow",
        fallbackClass: "card-follow",
        // 和项目卡片一样用 forceFallback：跟手的是真实 DOM，手里那张才不虚化
        forceFallback: true,
        fallbackOnBody: true,
        fallbackTolerance: 4,
        filter: "input, textarea, select, .gm-drop-hint, .link, .btn",
        distance: 5,
        onEnd(evt) {
          const status = (evt.to && evt.to.dataset.sort) || "";
          const game = table("games").find((g) => g.id === evt.item.dataset.id) || null;
          const moved = Boolean(game && status && game.status !== status);
          if (moved) game.status = status;
          // 按页面上的顺序把 games 数组重排：四个分组从上到下、组内按看到的顺序
          const ids = [...root.querySelectorAll(".gm-list [data-id]")].map((el) => el.dataset.id);
          const games = table("games");
          games.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
          touch(true);
          toast(moved ? `「${game.name}」移到「${status}」` : "顺序已保存");
        },
      })
    );
  }
  root.dataset.gmSortable = sorters.length ? "on" : "off";
}

/* ---------------- 事件 ---------------- */

function findGame(id) {
  return table("games").find((g) => g.id === id) || null;
}

function findRecord(id) {
  return table("gameRecords").find((r) => r.id === id) || null;
}

function redraw() {
  renderGame(document.getElementById("view"));
}

function showHistory(name) {
  filter.name = name || "";
  filter.from = "";
  filter.to = "";
  redraw();
  const card = document.querySelector(".gm-records");
  if (card && card.scrollIntoView) card.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function onClick(e) {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  const li = btn.closest("[data-id]");
  const id = li ? li.dataset.id : "";

  /* 游玩记录那一张 */
  if (act === "gm-add") {
    openRecordDialog(null);
    return;
  }
  if (act === "gm-prev" || act === "gm-next" || act === "gm-today") {
    viewDate = act === "gm-today" ? todayStr() : shiftDate(viewDate, act === "gm-prev" ? -1 : 1);
    clearFilter();       // 翻到某一天就是看那一天，先退出筛选
    redraw();
    return;
  }
  if (act === "gm-filter-clear") {
    clearFilter();
    redraw();
    return;
  }
  if (act === "gm-history") {
    showHistory(btn.dataset.name || "");
    return;
  }
  if (act === "gm-timer-start") {
    startTimer();
    toast("开始计时，玩完点「停止并记录」");
    redraw();
    return;
  }
  if (act === "gm-timer-cancel") {
    stopTimer();
    toast("已取消计时");
    redraw();
    return;
  }
  if (act === "gm-timer-stop") {
    const minutes = stopTimer();
    redraw();
    // 计出来的分钟直接填进弹窗，确认一下（想改游戏名、补备注都在这里）
    openRecordDialog(null, { duration: minutes, durationUnit: "分钟" });
    return;
  }
  if (act === "gr-edit") {
    const r = findRecord(id);
    if (r) openRecordDialog(r);
    return;
  }
  if (act === "gr-del") {
    const r = findRecord(id);
    if (!r) return;
    const ok = await askConfirm({
      title: `删除「${r.gameName || "这条"}」${r.playDate ? " " + r.playDate : ""}的游玩记录？`,
      message: `时长 ${durationText(r.durationMin)}，会放进回收站，误删可找回。`,
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    moveToTrash("gameRecords", r, r.gameName || "");
    touch(true);
    toast("已移入回收站");
    return;
  }

  /* 游戏清单那一张 */
  if (act === "add") {
    openItemDialog("game", null);
    return;
  }

  const game = findGame(id);
  if (!game) return;
  if (act === "edit") {
    openItemDialog("game", game);
  } else if (act === "delete") {
    const n = recordsOfGame(table("gameRecords"), game).length;
    const ok = await askConfirm({
      title: `删除「${game.name}」？`,
      message: n
        ? `它的 ${n} 条游玩记录不跟着删（统计里还看得到），只是不再挂在清单这一款下面了。`
        : "会放进回收站，误删可找回。",
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    moveToTrash("games", game, game.name);
    touch(true);
    toast("已移入回收站");
  }
}

/** 打字的时候只记着筛的关键词，不重画（否则光标会被换掉） */
function onInput(e) {
  if (e.target && e.target.id === "game-filter-name") filter.name = e.target.value;
}

/** 离开输入框 / 选完日期之后才重画一次 */
function onChange(e) {
  const el = e.target;
  if (!el || !el.id) return;
  if (el.id === "game-date") {
    if (el.value) viewDate = el.value;
    clearFilter();
    redraw();
  } else if (el.id === "game-filter-name") {
    filter.name = el.value;
    redraw();
  } else if (el.id === "game-filter-from") {
    filter.from = el.value;
    redraw();
  } else if (el.id === "game-filter-to") {
    filter.to = el.value;
    redraw();
  }
}

/* ---------------- 小零件 ---------------- */

/** 「2026-10-07 星期三」 */
function dayText(date) {
  const [y, m, d] = String(date).split("-").map(Number);
  const w = new Date(y, m - 1, d).getDay();
  return `${date} 星期${"日一二三四五六"[w]}`;
}
