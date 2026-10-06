/* 健身计划：每周训练安排 / 训练打卡 / 体重记录 */

import { store, touch, uid, table, esc, todayStr, moveToTrash } from "./store.js";
import { sectionHead, emptyLine, emptyState, chip, options, bindFresh, pageHeader } from "./ui.js";
import { askConfirm, toast } from "./dialog.js";
import { monthGridHtml, calendarAction, dayLabel, KIND_FITNESS } from "./calendar.js";

const DAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

let editingLog = null;
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
        <span class="hint">${esc(dayLabel(selected))}</span>
      </div>
      <form class="add-form" id="add-log" autocomplete="off">
        <input name="date" type="date" value="${selected}" title="日期">
        <input name="moves" class="grow" maxlength="200" required placeholder="练了什么（动作、组数 / 重量）…">
        <input name="note" class="grow-note" maxlength="120" placeholder="备注（可不填）">
        <button class="btn primary" type="submit">记一次</button>
      </form>
      ${
        logs.length
          ? `<ul class="items">${logs.map(logRow).join("")}</ul>`
          : emptyState("这天还没有训练记录", "上面可以补记一条，日历上也能看到哪天练过。", "", "fitness")
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
  if (l.id === editingLog) {
    return `
      <li class="item editing" data-id="${esc(l.id)}">
        <input data-field="date" type="date" value="${esc(l.date || "")}">
        <input data-field="moves" class="grow" maxlength="200" value="${esc(l.moves || "")}">
        <input data-field="note" class="grow-note" maxlength="120" placeholder="备注" value="${esc(l.note || "")}">
        <button class="btn primary small" data-act="l-save">保存</button>
        <button class="btn small" data-act="l-cancel">取消</button>
      </li>`;
  }
  return `
    <li class="item" data-id="${esc(l.id)}">
      <span class="i-meta">${esc(l.date || "")}</span>
      <span class="i-title">${esc(l.moves || "")}</span>
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
  if (form.id === "add-log") {
    e.preventDefault();
    const moves = form.moves.value.trim();
    if (!moves) return;
    selected = form.date.value || todayStr(); // 补记别的日期时，跟着切过去
    table("workoutLogs").push({
      id: uid(),
      date: form.date.value || todayStr(),
      moves,
      note: form.note.value.trim(),
    });
    touch(true);
  } else if (form.id === "add-weight") {
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
  const cal = calendarAction(e);
  if (cal.handled) {
    if (cal.selected) selected = cal.selected;
    renderFitness(document.getElementById("view"));
    return;
  }

  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  const li = btn.closest("[data-id]");
  const id = li ? li.dataset.id : "";
  const rows = act.startsWith("w-") ? table("weights") : table("workoutLogs");
  const row = rows.find((x) => x.id === id) || null;
  if (!row) return;

  if (act === "l-edit") {
    editingLog = id;
    redraw();
  } else if (act === "l-cancel") {
    editingLog = null;
    redraw();
  } else if (act === "l-save") {
    const val = (name) => li.querySelector(`[data-field="${name}"]`).value;
    const moves = val("moves").trim();
    if (!moves) {
      toast("内容不能是空的", "err");
      return;
    }
    row.date = val("date") || todayStr();
    row.moves = moves;
    row.note = val("note").trim();
    editingLog = null;
    touch(true);
  } else if (act === "l-del") {
    const ok = await askConfirm({
      title: `删除 ${row.date} 这次打卡？`,
      message: "会放进回收站。",
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    moveToTrash("workoutLogs", row, row.moves);
    if (editingLog === id) editingLog = null;
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
