/* 健身计划：每周训练安排 / 训练打卡 / 体重记录 */

import { store, touch, uid, table, esc, todayStr, moveToTrash } from "./store.js";
import { emptyLine, emptyState, chip, bindFresh, pageHeader } from "./ui.js";
import { askConfirm, toast } from "./dialog.js";
import { icon } from "./icons.js";
import { monthGridHtml, calendarAction, dayLabel, KIND_FITNESS } from "./calendar.js";
import { imgBadge } from "./attachment.js";
import { openItemDialog } from "./item-dialog.js";
import { goalCardHtml, goalAction } from "./goals.js";

const DAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

let selected = null; // 正在看哪一天（默认今天）

export function renderFitness(root) {
  const plan = ensurePlan();
  if (!selected) selected = todayStr();
  const allLogs = table("workoutLogs");
  const logs = allLogs
    .filter((l) => l.date === selected)
    .sort((a, b) => ((a.date || "") < (b.date || "") ? 1 : -1));
  const weights = table("weights")
    .slice()
    .sort((a, b) => ((a.date || "") < (b.date || "") ? 1 : -1));
  const week = thisWeekCount(allLogs);
  const today = weekdayCN();

  root.innerHTML = `
    ${pageHeader("fitness", `<span class="date-chip">本周练了 ${week} 次</span>`)}

    ${goalCardHtml("fitness")}

    <section class="card">
      ${monthGridHtml({
        selected,
        kinds: KIND_FITNESS,
        marksOf: (date) => (allLogs.some((l) => l.date === date) ? [{ kind: "fitness" }] : []),
      })}
    </section>

    <section class="card">
      <div class="card-head">
        <h2>训练打卡</h2>
        <div class="card-tools">
          <span class="hint">${esc(dayLabel(selected))}</span>
          <button class="btn primary small" data-act="l-add">${icon("plus", 14)}记一次</button>
        </div>
      </div>
      ${
        logs.length
          ? `<ul class="items">${logs.map(logRow).join("")}</ul>`
          : emptyState("这天还没有训练记录", "点右上角「记一次」补记一条，日历上也能看到哪天练过。", "", "fitness")
      }
    </section>

    <section class="card">
      <div class="card-head">
        <h2>每周训练安排</h2>
        <span class="hint">今天那行高亮</span>
      </div>
      <p class="hint">写一次就固定下来，改完自动保存。</p>
      <div class="plan-grid">
        ${DAYS.map(
          (d) => `
          <label class="plan-row${d === today ? " today" : ""}">
            <span class="plan-day">${d}</span>
            <input data-day="${d}" maxlength="80" placeholder="练什么（可不填）" value="${esc(plan[d] || "")}">
          </label>`
        ).join("")}
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <h2>体重记录</h2>
        <span class="hint">${weightHint(weights)}</span>
      </div>
      <form class="add-form" id="add-weight" autocomplete="off">
        <input name="date" type="date" value="${todayStr()}" title="日期">
        <input name="kg" type="number" min="20" max="300" step="0.1" required placeholder="体重(kg)">
        <input name="bodyFat" type="number" min="1" max="70" step="0.1" placeholder="体脂%(可不填)">
        <button class="btn primary" type="submit">记一次</button>
      </form>
      ${weights.length ? `<ul class="items">${weights.map((w, i) => weightRow(w, weights, i)).join("")}</ul>` : emptyLine("还没有体重记录。")}
    </section>
  `;

  bindFresh(root, { submit: onSubmit, click: onClick, input: onPlanInput, change: onChange });
}

/* ---------------- 小计算 ---------------- */

function ensurePlan() {
  if (!store.data.workoutPlan || typeof store.data.workoutPlan !== "object") {
    store.data.workoutPlan = {};
  }
  return store.data.workoutPlan;
}

function weekdayCN() {
  return "周" + "日一二三四五六"[new Date().getDay()];
}

function thisWeekCount(logs) {
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // 周一
  const p = (n) => String(n).padStart(2, "0");
  const start = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const today = todayStr();
  return new Set(logs.filter((l) => l.date >= start && l.date <= today).map((l) => l.date)).size;
}

function weightHint(weights) {
  if (!weights.length) return "还没有记录";
  const latest = weights[0]; // 已经按日期从新到旧排过
  return `最近 ${latest.date} ${latest.kg} kg`;
}

/* ---------------- 画 ---------------- */

function logRow(l) {
  return `
    <li class="item" data-id="${esc(l.id)}">
      <span class="i-meta">${esc(l.date || "")}</span>
      <span class="i-title">${esc(l.moves || "")}</span>
      ${imgBadge(l.imagePaths, "图")}
      <span class="i-note">${esc(l.note || "")}</span>
      <span class="i-actions">
        <button class="link" data-act="l-edit">编辑</button>
        <button class="link danger" data-act="l-del">删除</button>
      </span>
    </li>`;
}

function weightRow(w, list, index) {
  const prev = list[index + 1]; // 列表是从新到旧，下一条就是上一次
  let delta = "";
  if (prev) {
    const diff = Math.round((Number(w.kg) - Number(prev.kg)) * 10) / 10;
    if (diff !== 0) delta = (diff > 0 ? "+" : "") + diff + " kg";
    else delta = "持平";
  }
  return `
    <li class="item" data-id="${esc(w.id)}">
      <span class="i-meta">${esc(w.date || "")}</span>
      <span class="i-title">${esc(w.kg)} kg</span>
      ${w.bodyFat ? chip("体脂 " + w.bodyFat + "%") : ""}
      <span class="i-meta">${esc(delta)}</span>
      <span class="i-actions">
        <button class="link danger" data-act="w-del">删除</button>
      </span>
    </li>`;
}

function redraw() {
  renderFitness(document.getElementById("view"));
}

/* ---------------- 事件 ---------------- */

function onSubmit(e) {
  const form = e.target;
  if (form.id === "add-weight") {
    e.preventDefault();
    const kg = Number(form.kg.value);
    if (!kg) return;
    table("weights").push({
      id: uid(),
      date: form.date.value || todayStr(),
      kg,
      bodyFat: Number(form.bodyFat.value) || 0,
    });
    touch(true);
  }
}

async function onClick(e) {
  // 顶部那张「模块目标」卡片上的按钮先接住（新增 / 编辑 / 查看进度 / 删除）
  if (goalAction(e, "fitness", redraw)) return;

  const cal = calendarAction(e);
  if (cal.handled) {
    if (cal.selected) selected = cal.selected;
    renderFitness(document.getElementById("view"));
    return;
  }

  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;

  // 「记一次」在卡片头上，没有 data-id，所以要在找行之前先接住
  if (act === "l-add") {
    openItemDialog("fitness", null, {
      date: selected,
      onSaved: (saved) => {
        selected = saved.date || selected; // 补记到别的日期时，跟着切过去
        redraw();
      },
    });
    return;
  }

  const li = btn.closest("[data-id]");
  const id = li ? li.dataset.id : "";
  const rows = act.startsWith("w-") ? table("weights") : table("workoutLogs");
  const row = rows.find((x) => x.id === id) || null;
  if (!row) return;

  if (act === "l-edit") {
    openItemDialog("fitness", row, {
      onSaved: (saved) => {
        selected = saved.date || selected; // 改到别的日期就跟着切过去
        redraw();
      },
    });
  } else if (act === "l-del") {
    const ok = await askConfirm({
      title: `删除 ${row.date} 这次打卡？`,
      message: "会放进回收站。",
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    moveToTrash("workoutLogs", row, row.moves);
    touch(true);
    toast("已移入回收站");
  } else if (act === "w-del") {
    const ok = await askConfirm({
      title: `删除 ${row.date} 的体重记录？`,
      message: "会放进回收站。",
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    moveToTrash("weights", row, `${row.date} ${row.kg} kg`);
    touch(true);
    toast("已移入回收站");
  }
}

/** 打字过程中静默保存：只写数据，不重画，光标不会被打断 */
function onPlanInput(e) {
  const input = e.target.closest("input[data-day]");
  if (!input) return;
  ensurePlan()[input.dataset.day] = input.value.trim();
  touch(false, true);
}

/** 离开输入框时再走一次正常保存：重画一遍，顺便更新「本周练了几次」 */
function onChange(e) {
  const input = e.target.closest("input[data-day]");
  if (!input) return;
  ensurePlan()[input.dataset.day] = input.value.trim();
  touch();
}
