/* 饮食计划：今天三餐 + 加餐、喝水杯数，外加最近几天回顾 */

import { touch, uid, table, esc, todayStr, moveToTrash } from "./store.js";
import { sectionHead, emptyState, bindFresh, pageHeader } from "./ui.js";
import { askConfirm, toast } from "./dialog.js";
import { monthGridHtml, calendarAction, dayLabel, KIND_DIET } from "./calendar.js";

const SLOTS = [
  ["breakfast", "早餐"],
  ["lunch", "午餐"],
  ["dinner", "晚餐"],
  ["snack", "加餐"],
];

let selected = null; // 正在看哪一天（默认今天）

export function renderDiet(root) {
  const today = todayStr();
  if (!selected) selected = today;
  const meal = table("meals").find((m) => m.date === selected) || null;
  const water = table("water").find((w) => w.date === selected) || null;
  const recent = recentDays(7);

  root.innerHTML = `
    ${pageHeader("diet", `<span class="date-chip">${esc(selected === today ? "今天 " + today : selected)}</span>`)}

    <section class="card">
      ${monthGridHtml({
        selected,
        kinds: KIND_DIET,
        marksOf: (date) =>
          table("meals").some((m) => m.date === date) ||
          table("water").some((w) => w.date === date && Number(w.cups) > 0)
            ? [{ kind: "diet" }]
            : [],
      })}
    </section>

    <section class="card">
      <div class="card-head">
        <h2>${esc(selected === today ? "今天吃了什么" : dayLabel(selected) + " 吃了什么")}</h2>
        <span class="hint">离开输入框自动保存</span>
      </div>
      <div class="meal-grid">
        ${SLOTS.map(
          ([key, label]) => `
          <label class="meal-row">
            <span class="meal-label">${label}</span>
            <input data-slot="${key}" maxlength="120" placeholder="吃了什么…" value="${esc(meal ? meal[key] || "" : "")}">
          </label>`
        ).join("")}
      </div>
      <div class="water-row">
        <span class="meal-label">喝水</span>
        <button class="btn small" data-act="water-minus">−</button>
        <span class="water-count">${water ? Number(water.cups) || 0 : 0} 杯</span>
        <button class="btn small" data-act="water-plus">+</button>
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <h2>最近几天</h2>
        <span class="hint">最多看 7 天</span>
      </div>
      ${
        recent.length
          ? `<ul class="items">${recent.map(dayRow).join("")}</ul>`
          : emptyState("还没有记录", "上面写点东西就出现了。", "", "diet")
      }
    </section>
  `;

  bindFresh(root, { input: onSlotInput, change: onChange, click: onClick });
}

/* ---------------- 小计算 ---------------- */

function recentDays(limit) {
  const dates = new Set();
  for (const m of table("meals")) if (m.date) dates.add(m.date);
  for (const w of table("water")) if (w.date) dates.add(w.date);
  return Array.from(dates)
    .sort((a, b) => (a < b ? 1 : -1))
    .slice(0, limit);
}

function daySummary(date) {
  const meal = table("meals").find((m) => m.date === date);
  if (!meal) return "";
  return SLOTS.map(([key, label]) => {
    const v = (meal[key] || "").trim();
    return v ? `${label} ${v}` : "";
  })
    .filter(Boolean)
    .join(" · ");
}

function cupsOf(date) {
  const w = table("water").find((x) => x.date === date);
  return w ? Number(w.cups) || 0 : 0;
}

function ensureWater(date) {
  let w = table("water").find((x) => x.date === date);
  if (!w) {
    w = { id: uid(), date, cups: 0 };
    table("water").push(w);
  }
  return w;
}

/* ---------------- 画 ---------------- */

function dayRow(date) {
  const summary = daySummary(date);
  const cups = cupsOf(date);
  return `
    <li class="item" data-date="${esc(date)}">
      <span class="i-meta">${esc(date)}</span>
      <span class="i-title">${esc(summary || "（只记了喝水）")}</span>
      <span class="i-meta">${cups ? cups + " 杯水" : ""}</span>
      <span class="i-actions">
        <button class="link danger" data-act="day-del">删除</button>
      </span>
    </li>`;
}

/* ---------------- 事件 ---------------- */

function ensureMeal(date) {
  let m = table("meals").find((x) => x.date === date);
  if (!m) {
    m = { id: uid(), date, breakfast: "", lunch: "", dinner: "", snack: "" };
    table("meals").push(m);
  }
  return m;
}

/** 打字过程中静默保存：只写数据，不重画，光标不会被打断 */
function onSlotInput(e) {
  const input = e.target.closest("input[data-slot]");
  if (!input) return;
  const meal = ensureMeal(selected);
  meal[input.dataset.slot] = input.value.trim();
  touch(false, true);
}

/** 离开输入框时再走一次正常保存：重画一遍，顺便把「最近几天」刷新 */
function onChange(e) {
  const input = e.target.closest("input[data-slot]");
  if (!input) return;
  const meal = ensureMeal(selected);
  meal[input.dataset.slot] = input.value.trim();
  touch();
}

async function onClick(e) {
  const cal = calendarAction(e);
  if (cal.handled) {
    if (cal.selected) selected = cal.selected;
    renderDiet(document.getElementById("view"));
    return;
  }

  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;

  if (act === "water-plus" || act === "water-minus") {
    const w = ensureWater(selected);
    w.cups = Math.max(0, (Number(w.cups) || 0) + (act === "water-plus" ? 1 : -1));
    touch(true);
  } else if (act === "day-del") {
    const date = btn.closest("[data-date]").dataset.date;
    const ok = await askConfirm({
      title: `删除 ${date} 这天的饮食记录？`,
      message: "会放进回收站。",
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    for (const key of ["meals", "water"]) {
      for (const row of table(key).filter((r) => r.date === date)) {
        moveToTrash(key, row, date + (key === "meals" ? " 吃了什么" : " 喝水"));
      }
    }
    touch(true);
    toast("已移入回收站");
  }
}
