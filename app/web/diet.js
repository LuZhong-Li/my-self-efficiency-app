/* 饮食计划：今天三餐 + 加餐、喝水杯数，外加最近几天回顾。
 * 2026-10-14 起多了一块「热量营养」：每餐能挂上吃了什么（从菜谱库里挑、填份数），
 * 热量与三大营养素自动算出来，还能配每日目标和看近 7 天趋势。
 * 纯计算在 diet-calc.js，图表复用 chart-calc.js。 */

import { store, touch, uid, table, esc, todayStr, moveToTrash, shiftDate } from "./store.js";
import { sectionHead, emptyState, bindFresh, pageHeader, tagChips } from "./ui.js";
import { askConfirm, toast } from "./dialog.js";
import { icon } from "./icons.js";
import { openItemDialog } from "./item-dialog.js";
import { trendChartHtml } from "./chart-calc.js";
import { monthGridHtml, calendarAction, dayLabel, KIND_DIET } from "./calendar.js";
import { goalCardHtml, goalAction } from "./goals.js";
import {
  DIET_SLOTS, normalizeFood, itemsOfSlot, nutritionOf, dayKcalSeries,
  nutritionTargetOf, kcalStateOf,
} from "./diet-calc.js";

const SLOTS = [
  ["breakfast", "早餐"],
  ["lunch", "午餐"],
  ["dinner", "晚餐"],
  ["snack", "加餐"],
];

let selected = null; // 正在看哪一天（默认今天）

/** 今天吃了什么 / 菜谱库 这一对子页的页签 */
function subTabsHtml(onFoods) {
  return `<a class="sub-tab${onFoods ? "" : " active"}" href="#diet">今天吃了什么</a>
          <a class="sub-tab${onFoods ? " active" : ""}" href="#diet/foods">菜谱库</a>`;
}

export function renderDiet(root, sub = "") {
  if (sub === "foods") renderFoods(root);
  else renderDay(root);
}

function renderDay(root) {
  const today = todayStr();
  if (!selected) selected = today;
  const meal = table("meals").find((m) => m.date === selected) || null;
  const water = table("water").find((w) => w.date === selected) || null;
  const recent = recentDays(7);

  root.innerHTML = `
    ${pageHeader("diet", `<span class="sub-tabs">${subTabsHtml(false)}</span>
       <span class="date-chip">${esc(selected === today ? "今天 " + today : selected)}</span>`)}

    ${goalCardHtml("diet")}

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
          <div class="meal-row" data-slot-row="${key}">
            <label class="meal-line">
              <span class="meal-label">${label}</span>
              <input data-slot="${key}" maxlength="120" placeholder="吃了什么…"
                value="${esc(meal ? meal[key] || "" : "")}">
            </label>
            ${slotItemsHtml(meal, key)}
          </div>`
        ).join("")}
      </div>
      <div class="water-row">
        <span class="meal-label">喝水</span>
        <button class="btn small" data-act="water-minus">−</button>
        <span class="water-count">${water ? Number(water.cups) || 0 : 0} 杯</span>
        <button class="btn small" data-act="water-plus">+</button>
      </div>
    </section>

    ${nutritionCard(meal, nutritionTargetOf(store.data || {}))}

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

/* ---------------- 今天吃了什么：条目与今日营养（2026-10-14 加） ---------------- */

/** 一条条目在页面上怎么写：`米饭 1.5 碗` */
function itemLine(it) {
  const one = it.unit ? ` ${it.unit}` : "";
  return `${it.name || "（没写什么）"} ${it.amount}${one}`;
}

/** 某一餐的条目清单 + 行尾那个「＋ 加一样」 */
function slotItemsHtml(meal, slot) {
  const rows = itemsOfSlot(meal, slot)
    .map(
      (it) => `
        <li class="meal-item" data-id="${esc(it.id)}">
          <span class="mi-name">${esc(itemLine(it))}</span>
          <span class="mi-kcal">${Math.round(it.kcal * it.amount)} 千卡</span>
          <button class="link" data-act="mi-edit">改</button>
          <button class="link danger" data-act="mi-del">删</button>
        </li>`
    )
    .join("");
  return `
    <ul class="meal-items">
      ${rows}
      <li class="meal-item-add">
        <button class="link" data-act="mi-add" data-slot="${esc(slot)}">＋ 加一样</button>
      </li>
    </ul>`;
}

/** 今日营养卡：热量进度 + 三格营养素 + 每日目标（就地填）+ 近 7 天柱状图 */
function nutritionCard(meal, target) {
  const nut = nutritionOf(meal && Array.isArray(meal.items) ? meal.items : []);
  const state = kcalStateOf(nut.kcal, target.kcal);
  const dates = [];
  for (let i = 6; i >= 0; i -= 1) dates.push(shiftDate(todayStr(), -i));
  const series = dayKcalSeries(table("meals"), dates);
  const seriesTotal = series.reduce((sum, r) => sum + r.kcal, 0);
  const stateText =
    state.level === "none"
      ? "还没设目标（下面填一个就知道差多少了）"
      : state.over
        ? `超了 ${Math.abs(state.diff)} 千卡`
        : `还差 ${state.diff} 千卡`;
  return `
    <section class="card nu-card">
      <div class="card-head">
        <h2>今日营养</h2>
        <span class="hint">目标填一次就行，之后每天照着看</span>
      </div>
      <div class="nu-kcal">
        已吃 <strong>${nut.kcal}</strong> / 目标
        <input id="nu-target-kcal" type="number" min="0" step="50"
          value="${target.kcal || ""}" placeholder="比如 2000"> 千卡
      </div>
      <div class="progress-track nu-track"><span class="${state.level}"
        style="width:${Math.min(100, state.percent)}%"></span></div>
      <p class="nu-state ${state.level}">${esc(stateText)}</p>
      <div class="nu-grid">
        ${[
          ["protein", "蛋白质", "克"],
          ["fat", "脂肪", "克"],
          ["carb", "碳水", "克"],
        ]
          .map(
            ([key, label, unit]) => `
          <div class="nu-cell">
            <span>${label}</span>
            <strong>${nut[key]} ${unit}</strong>
            <label class="nu-goal">目标
              <input id="nu-target-${key}" type="number" min="0" step="5"
                value="${target[key] || ""}" placeholder="—"></label>
          </div>`
          )
          .join("")}
      </div>
      ${
        seriesTotal
          ? sectionHead("近 7 天热量", undefined, `共 ${seriesTotal} 千卡`) +
            trendChartHtml(series, {
              value: (r) => r.kcal,
              label: (r) => Number(r.date.slice(8)) + "日",
              valueText: (v) => String(v),
              title: (r) => `${r.date} · ${r.kcal} 千卡`,
              ariaLabel: "近 7 天热量",
            })
          : ""
      }
    </section>`;
}

/** 每日目标存进 settings.nutritionTarget（和主题、首页视图一样跟着数据文件走） */
function saveNutritionTarget(patch) {
  if (!store.data) return;
  if (!store.data.settings) store.data.settings = {};
  const cur = store.data.settings.nutritionTarget || {};
  store.data.settings.nutritionTarget = { ...cur, ...patch };
  touch(true);
}

/** 加 / 改「吃了什么」：弹窗要拿到「哪一天那条记录」和菜谱库的候选与资料 */
function openItemFor(slot, item = null) {
  const meal = ensureMeal(selected);
  return openItemDialog("mealItem", item, {
    defaults: item ? null : { slot: (DIET_SLOTS.find((s) => s[0] === slot) || [])[1] },
    ctx: {
      meal,
      foodOptions: table("foods").map((f) => [f.name, f.name]),
      autoFill: {
        foods: Object.fromEntries(table("foods").map((f) => {
          const one = normalizeFood(f);
          return [one.name, { unit: one.unit, kcal: one.kcal, protein: one.protein,
            fat: one.fat, carb: one.carb }];
        })),
      },
    },
    onSaved: () => redraw(),
  });
}

async function deleteMealItem(item) {
  const ok = await askConfirm({
    title: "删掉这一条？",
    message: `${item.name || "这一条"}\n\n只从这一餐里去掉了，不进回收站。`,
    confirmLabel: "删除",
    danger: true,
  });
  if (!ok) return;
  const meal = table("meals").find((m) => m.date === selected);
  if (meal && Array.isArray(meal.items)) {
    const index = meal.items.indexOf(item);
    if (index >= 0) meal.items.splice(index, 1);
  }
  touch(true);
}

/** 菜谱库子页：一行一样，行尾改 / 删 */
function renderFoods(root) {
  const foods = table("foods").map((f) => normalizeFood(f));
  root.innerHTML = `
    ${pageHeader("diet", `<span class="sub-tabs">${subTabsHtml(true)}</span>
       <span class="date-chip">${foods.length} 样</span>`)}
    <section class="card">
      <div class="card-head">
        <h2>菜谱库</h2>
        <div class="card-tools">
          <button class="btn primary small" data-act="food-add">${icon("plus", 14)}加一样</button>
        </div>
      </div>
      ${
        foods.length
          ? `<ul class="items">${foods.map(foodRow).join("")}</ul>`
          : `<p class="empty food-empty">还没有菜谱。加一样常吃的（米饭一碗多少千卡），
             之后每餐挑一下、填份数，热量就自己算出来了。</p>`
      }
    </section>
  `;
  // 每一页都要自己挂一次事件（bindFresh 会新建一层容器，旧页面的监听跟着旧 DOM 一起走）
  bindFresh(root, { click: onClick, change: onChange });
}

function foodRow(f) {
  const per = f.unit ? ` / ${esc(f.unit)}` : "";
  return `
    <li class="item food-row" data-id="${esc(f.id)}">
      <span class="i-title">${esc(f.name || "（没写名字）")}</span>
      <span class="chip">${f.kcal} 千卡${per}</span>
      <span class="i-meta">蛋白 ${f.protein} · 脂肪 ${f.fat} · 碳水 ${f.carb}</span>
      ${tagChips(f)}
      <span class="i-note">${esc(f.note || "")}</span>
      <span class="i-actions">
        <button class="link" data-act="food-edit">改</button>
        <button class="link danger" data-act="food-del">删</button>
      </span>
    </li>`;
}

/** 删菜谱：进回收站。已经记过的条目不受影响 —— 它们存的是当时的营养快照 */
async function deleteFood(row) {
  const ok = await askConfirm({
    title: `删掉「${row.name || "这一样"}」？`,
    message: "会放进回收站。已经记过的那些条目不受影响（它们存的是当时的营养数）。",
    confirmLabel: "删除",
    danger: true,
  });
  if (!ok) return;
  moveToTrash("foods", row, row.name || "");
  touch(true);
  toast("已移入回收站");
}

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

function redraw() {
  renderDiet(document.getElementById("view"), location.hash.split("/")[1] || "");
}

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
  if (input) {
    const meal = ensureMeal(selected);
    meal[input.dataset.slot] = input.value.trim();
    touch();
    return;
  }
  // 每日目标：离开输入框就存，然后重画一次把进度条和那句「还差 / 超了」更新掉
  const goal = e.target.closest("input[id^='nu-target-']");
  if (goal) {
    const key = goal.id.replace("nu-target-", "");
    saveNutritionTarget({ [key]: Math.max(0, Number(goal.value) || 0) });
    redraw();
  }
}

async function onClick(e) {
  // 顶部那张「模块目标」卡片上的按钮先接住
  if (goalAction(e, "diet", redraw)) return;

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
  } else if (act === "mi-add") {
    openItemFor(btn.dataset.slot, null);
  } else if (act === "mi-edit" || act === "mi-del") {
    const li = btn.closest("[data-id]");
    const meal = table("meals").find((m) => m.date === selected) || null;
    const item = meal && Array.isArray(meal.items)
      ? meal.items.find((x) => x.id === (li && li.dataset.id)) || null
      : null;
    if (!item) return;
    if (act === "mi-edit") openItemFor(item.slot, item);
    else deleteMealItem(item);
  } else if (act === "food-add") {
    openItemDialog("food", null, { onSaved: () => redraw() });
  } else if (act === "food-edit" || act === "food-del") {
    const li = btn.closest("[data-id]");
    const row = li ? table("foods").find((f) => f.id === li.dataset.id) || null : null;
    if (!row) return;
    if (act === "food-edit") openItemDialog("food", row, { onSaved: () => redraw() });
    else deleteFood(row);
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
