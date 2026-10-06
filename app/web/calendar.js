/* 月历：全站通用的「挑日期」零件。
 *
 * 骨架参考木子工作台的 MonthCalendar：周一起、固定 42 格、上下月切换、
 * 「回到今天」、选中态与今天态分开。它那边是把 MonthCalendar 塞进饮食页和
 * 健身页挑日期，这里也一样：
 *
 *   今日计划 → 月历视图：全部七个来源都画上
 *   健身计划 → 每天有没有训练
 *   饮食计划 → 每天有没有吃饭喝水
 *
 * 用法：页面里插 monthGridHtml({ selected, marksOf, kinds })，事件交给
 * calendarAction(e)；它告诉你「这次点击归我管吗、选中日要不要变」。
 */

import { touch, uid, table, esc, todayStr, dateStr, moveToTrash } from "./store.js";
import { bindFresh, emptyState, options } from "./ui.js";
import { askConfirm, toast } from "./dialog.js";
import { icon } from "./icons.js";

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];
const CATEGORIES = ["工作", "生活", "运动", "其他"];

// 小圆点的种类，顺序就是图例顺序
const ALL_KINDS = [
  ["task", "任务"],
  ["fitness", "训练"],
  ["diet", "饮食"],
  ["study", "学习"],
  ["publish", "发布"],
  ["planned", "计划发布"],
  ["dev", "进展"],
  ["weight", "体重"],
  ["finance", "支出"],
];

export const KIND_TASK = [ALL_KINDS[0]];
export const KIND_FITNESS = [ALL_KINDS[1]];
export const KIND_DIET = [ALL_KINDS[2]];
export const KIND_STUDY = [ALL_KINDS[3]];
export const KIND_PUBLISH = [ALL_KINDS[4], ALL_KINDS[5]];
// 「支出」那一类单独导出去，给记账页用（它的格子里画金额、不画圆点）
export const KIND_FINANCE = ALL_KINDS.filter(([kind]) => kind === "finance");

let cursor = null;   // 正在看的月份 "YYYY-MM"（全站共用一个）
let selected = null; // 今日计划页选中的那天
let host = null;

function ensureState() {
  const today = todayStr();
  if (!cursor) cursor = today.slice(0, 7);
  if (!selected) selected = today;
}

export function shiftMonth(month, amount) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + amount, 1, 12);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}

function formatMonth(month) {
  const [y, m] = month.split("-").map(Number);
  return `${y}年${m}月`;
}

function monthDays(month) {
  const [y, m] = month.split("-").map(Number);
  const first = new Date(y, m - 1, 1, 12);
  const offset = (first.getDay() + 6) % 7; // 周一算一周的开头
  const start = new Date(y, m - 1, 1 - offset, 12);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const value = dateStr(d);
    return { date: value, inMonth: value.slice(0, 7) === month };
  });
}

/* ---------------- 汇总每天有什么 ---------------- */

function marksOf(date) {
  const marks = [];
  const tasks = table("tasks").filter((t) => t.date === date);
  if (tasks.length) marks.push({ kind: "task", done: tasks.every((t) => t.done) });
  if (table("workoutLogs").some((l) => l.date === date)) marks.push({ kind: "fitness" });
  const hasMeal = table("meals").some((m) => m.date === date);
  const hasWater = table("water").some((w) => w.date === date && Number(w.cups) > 0);
  if (hasMeal || hasWater) marks.push({ kind: "diet" });
  if (table("studies").some((s) => s.date === date)) marks.push({ kind: "study" });
  if (table("contents").some((c) => c.publishDate === date)) marks.push({ kind: "publish" });
  else if (table("contents").some((c) => c.planDate === date)) marks.push({ kind: "planned" });
  if (table("progress").some((p) => p.date === date)) marks.push({ kind: "dev" });
  if (table("weights").some((w) => w.date === date)) marks.push({ kind: "weight" });
  return marks;
}

/* ---------------- 可复用的那一块 ---------------- */

/** 月历本体（工具条 + 星期表头 + 42 格 + 图例）。
 *  marksOf(date) 由调用方给：返回那些天的圆点数组。 */
export function monthGridHtml({ selected: sel, marksOf: marks, kinds = ALL_KINDS, dayExtraOf } = {}) {
  ensureState();
  const today = todayStr();
  const marksFn = marks || marksOf;
  return `
    <div class="cal-toolbar">
      <div class="cal-title">${icon("plan", 18)}<strong>${formatMonth(cursor)}</strong></div>
      <div class="row">
        <button class="icon-btn" data-act="cal-prev" title="上个月">‹</button>
        <button class="btn small" data-act="cal-today">回到今天</button>
        <button class="icon-btn" data-act="cal-next" title="下个月">›</button>
      </div>
    </div>

    <div class="cal-weekdays">${WEEKDAYS.map((w) => `<span>周${w}</span>`).join("")}</div>
    <div class="cal-grid">
      ${monthDays(cursor)
        .map((d) => {
          const ms = marksFn(d.date) || [];
          const extra = dayExtraOf ? dayExtraOf(d.date) : null;
          const lines = (extra && extra.lines) || [];
          return `<button type="button" class="cal-cell${d.inMonth ? "" : " out"}${
            d.date === today ? " today" : ""
          }${d.date === sel ? " sel" : ""}${extra && extra.over ? " over" : ""}" data-day="${d.date}">
            <span class="cal-num">${Number(d.date.slice(-2))}</span>
            <span class="cal-marks">${ms
              .map((m) => `<i class="mk mk-${m.kind}${m.done ? " done" : ""}"></i>`)
              .join("")}</span>
            ${
              lines.length
                ? `<span class="cal-extra">${lines
                    .map((l) => `<i class="cx cx-${esc(l.tone)}">${esc(l.text)}</i>`)
                    .join("")}</span>`
                : ""
            }
          </button>`;
        })
        .join("")}
    </div>

    ${
      kinds.length
        ? `<div class="cal-legend">
             ${kinds.map(([k, label]) => `<span><i class="mk mk-${k}"></i>${label}</span>`).join("")}
           </div>`
        : ""
    }
  `;
}

/** 页面的事件里先叫它一声：归它管的返回 handled: true。
 *  selected 有值表示用户点了某一天（调用方据此更新自己的选中日）。 */
export function calendarAction(e) {
  ensureState();
  const cell = e.target.closest(".cal-cell");
  if (cell) {
    const date = cell.dataset.day;
    cursor = date.slice(0, 7);
    return { handled: true, selected: date };
  }
  const btn = e.target.closest("[data-act]");
  if (!btn) return { handled: false };
  const act = btn.dataset.act;
  if (act === "cal-prev") {
    cursor = shiftMonth(cursor, -1);
    return { handled: true };
  }
  if (act === "cal-next") {
    cursor = shiftMonth(cursor, 1);
    return { handled: true };
  }
  if (act === "cal-today") {
    cursor = todayStr().slice(0, 7);
    return { handled: true, selected: todayStr() };
  }
  return { handled: false };
}

/* ---------------- 画 ---------------- */

export function renderCalendar(el) {
  host = el;
  ensureState();

  el.innerHTML = `
    <section class="card">
      ${monthGridHtml({ selected, marksOf })}
    </section>

    <section class="card">
      <div class="card-head">
        <h2>${esc(dayLabel(selected))}</h2>
        <span class="hint">${esc(dayCountText(selected))}</span>
      </div>
      ${dayDetail(selected)}
      <form class="add-form" id="cal-add" autocomplete="off">
        <input name="text" class="grow" maxlength="200" required placeholder="给这一天加一条任务…">
        <input name="time" type="time" title="时间点（可不填）">
        <select name="category" title="分类">${options(CATEGORIES)}</select>
        <button class="btn primary" type="submit">${icon("plus", 16)}加任务</button>
      </form>
    </section>
  `;

  bindFresh(el, { click: onClick, submit: onSubmit, change: onChange });
}

function redraw() {
  if (host) renderCalendar(host);
}

export function dayLabel(date) {
  const [y, m, d] = date.split("-").map(Number);
  const w = "日一二三四五六"[new Date(y, m - 1, d).getDay()];
  return `${m} 月 ${d} 日 星期${w}`;
}

function dayCountText(date) {
  const n =
    table("tasks").filter((t) => t.date === date).length +
    table("workoutLogs").filter((l) => l.date === date).length +
    table("studies").filter((s) => s.date === date).length +
    table("progress").filter((p) => p.date === date).length +
    table("weights").filter((w) => w.date === date).length +
    table("contents").filter((c) => c.publishDate === date || c.planDate === date).length;
  const diet = table("meals").some((m) => m.date === date) ? 1 : 0;
  const total = n + diet;
  return total ? `${total} 项` : "";
}

function section(title, body) {
  return `<div class="list-head"><span>${esc(title)}</span><span class="hint"></span></div>
    <ul class="items">${body}</ul>`;
}

function dayDetail(date) {
  const parts = [];

  const tasks = table("tasks").filter((t) => t.date === date);
  if (tasks.length) {
    parts.push(
      section(
        `任务（${tasks.length}）`,
        tasks
          .map(
            (t) => `<li class="item${t.done ? " done" : ""}" data-id="${esc(t.id)}">
              <label class="check" title="${t.done ? "取消完成" : "标记完成"}">
                <input type="checkbox" data-act="toggle" ${t.done ? "checked" : ""}>
              </label>
              <span class="i-title">${esc(t.text)}</span>
              ${t.time ? `<span class="i-meta">${esc(t.time)}</span>` : ""}
              <span class="chip">${esc(t.category || "其他")}</span>
              <span class="i-actions"><button class="link danger" data-act="cal-del">删除</button></span>
            </li>`
          )
          .join("")
      )
    );
  }

  const logs = table("workoutLogs").filter((l) => l.date === date);
  if (logs.length) {
    parts.push(
      section(
        `训练打卡（${logs.length}）`,
        logs
          .map(
            (l) => `<li class="item"><span class="i-title">${esc(l.moves || "")}</span>
              <span class="i-note">${esc(l.note || "")}</span></li>`
          )
          .join("")
      )
    );
  }

  const meal = table("meals").find((m) => m.date === date);
  const water = table("water").find((w) => w.date === date);
  if (meal || water) {
    const eaten = meal
      ? [["早餐", meal.breakfast], ["午餐", meal.lunch], ["晚餐", meal.dinner], ["加餐", meal.snack]]
          .filter(([, v]) => (v || "").trim())
          .map(([k, v]) => `${k} ${v}`)
          .join(" · ")
      : "";
    parts.push(
      section(
        "饮食",
        `<li class="item"><span class="i-title">${esc(eaten || "（没记吃了什么）")}</span>
          <span class="i-meta">${water ? (Number(water.cups) || 0) + " 杯水" : ""}</span></li>`
      )
    );
  }

  const studies = table("studies").filter((s) => s.date === date);
  if (studies.length) {
    parts.push(
      section(
        `学习（${studies.length}）`,
        studies
          .map((s) => {
            const subject = table("subjects").find((x) => x.id === s.subjectId);
            const title = [subject ? subject.name : "", s.content].filter(Boolean).join(" · ");
            return `<li class="item"><span class="i-title">${esc(title || "（没写学了什么）")}</span>
              ${Number(s.minutes) ? `<span class="i-meta">${esc(s.minutes)} 分钟</span>` : ""}
              <span class="chip">${s.reviewed ? "已复习" : "待复习"}</span></li>`;
          })
          .join("")
      )
    );
  }

  const contents = table("contents").filter(
    (c) => c.publishDate === date || (!c.publishDate && c.planDate === date)
  );
  if (contents.length) {
    parts.push(
      section(
        "自媒体",
        contents
          .map(
            (c) => `<li class="item"><span class="i-title">${esc(c.title)}</span>
              <span class="chip">${esc(c.publishDate === date ? "已发布" : "计划发布")}</span>
              ${c.platform ? `<span class="i-meta">${esc(c.platform)}</span>` : ""}</li>`
          )
          .join("")
      )
    );
  }

  const progress = table("progress").filter((p) => p.date === date);
  if (progress.length) {
    parts.push(
      section(
        `项目进展（${progress.length}）`,
        progress
          .map((p) => `<li class="item"><span class="i-title">${esc(p.text)}</span></li>`)
          .join("")
      )
    );
  }

  const weights = table("weights").filter((w) => w.date === date);
  if (weights.length) {
    parts.push(
      section(
        "体重",
        weights
          .map(
            (w) => `<li class="item"><span class="i-title">${esc(w.kg)} kg</span>
              ${w.bodyFat ? `<span class="chip">体脂 ${esc(w.bodyFat)}%</span>` : ""}</li>`
          )
          .join("")
      )
    );
  }

  return parts.length
    ? parts.join("")
    : emptyState("这一天还没有记录", "下面可以直接加一条任务。", "", "plan");
}

/* ---------------- 事件 ---------------- */

async function onClick(e) {
  const cal = calendarAction(e);
  if (cal.handled) {
    if (cal.selected) selected = cal.selected;
    redraw();
    return;
  }

  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;

  if (act === "cal-del") {
    const li = btn.closest("[data-id]");
    const task = li ? table("tasks").find((t) => t.id === li.dataset.id) : null;
    if (!task) return;
    const ok = await askConfirm({
      title: `删除「${task.text}」？`,
      message: "会放进回收站。",
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    moveToTrash("tasks", task, task.text);
    touch(true);
    toast("已移入回收站");
  }
}

function onSubmit(e) {
  if (e.target.id !== "cal-add") return;
  e.preventDefault();
  const form = e.target;
  const text = form.text.value.trim();
  if (!text) return;
  table("tasks").push({
    id: uid(),
    date: selected,
    text,
    time: form.time.value || "",
    category: form.category.value,
    done: false,
    note: "",
    belong: "plan",
    createdAt: new Date().toISOString(),
  });
  touch(true);
  toast(`已加到 ${selected}`);
}

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
