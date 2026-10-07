/* 学习工作：学习对象（书 / 课程 / 视频 / 技能）+ 按天的学习记录
 *
 * 从原来的「咨询工作」改过来的：客户 → 学习对象，咨询记录 → 学习记录，
 * 「未收款 / 已收款」这组改成「待复习 / 已复习」，时长还是记分钟。
 * 2026-10-07 起两处录入都改成弹窗（和别的模块一套），卡片上只留添加按钮。
 */

import { touch, table, esc, todayStr, dateStr, moveToTrash } from "./store.js";
import { emptyState, chip, bindFresh, pageHeader } from "./ui.js";
import { askConfirm, toast } from "./dialog.js";
import { icon } from "./icons.js";
import { monthGridHtml, calendarAction, dayLabel, KIND_STUDY } from "./calendar.js";
import { imgBadge } from "./attachment.js";
import { openItemDialog } from "./item-dialog.js";

let selected = null;        // 月历选中的那天（默认今天）

export function renderStudy(root) {
  const subjects = table("subjects");
  const all = table("studies").slice().sort((a, b) => ((a.date || "") < (b.date || "") ? 1 : -1));
  if (!selected) selected = todayStr();
  const dayStudies = all.filter((s) => s.date === selected);
  const pending = all.filter((s) => !s.reviewed).length;
  const weekMinutes = thisWeekMinutes(all);

  root.innerHTML = `
    ${pageHeader(
      "study",
      `<span class="date-chip">本周 ${weekMinutes} 分钟 · 待复习 ${pending} 条</span>`
    )}

    <section class="card">
      ${monthGridHtml({
        selected,
        kinds: KIND_STUDY,
        marksOf: (date) => (all.some((s) => s.date === date) ? [{ kind: "study" }] : []),
      })}
    </section>

    <section class="card">
      <div class="card-head">
        <h2>学习记录</h2>
        <div class="card-tools">
          <span class="hint">${esc(dayLabel(selected))}</span>
          ${
            subjects.length
              ? `<button class="btn primary small" data-act="st-add">${icon("plus", 14)}记一条</button>`
              : ""
          }
        </div>
      </div>
      ${
        subjects.length
          ? ""
          : `<p class="hint">先在下面加一个学习对象（书、课程、技能都行），再回来记。</p>`
      }
      ${
        dayStudies.length
          ? `<ul class="items">${dayStudies.map(studyRow).join("")}</ul>`
          : emptyState("这天还没记学习", "点右上角「记一条」，日历上就会出现一个小圆点。", "", "study")
      }
    </section>

    <section class="card">
      <div class="card-head">
        <h2>学习对象</h2>
        <div class="card-tools">
          <span class="hint">共 ${subjects.length} 个</span>
          <button class="btn primary small" data-act="sub-add">${icon("plus", 14)}添加</button>
        </div>
      </div>
      ${
        subjects.length
          ? `<ul class="items">${subjects.map(subjectRow).join("")}</ul>`
          : emptyState("还没有学习对象", "点右上角「添加」，把想学的先列出来。", "", "study")
      }
    </section>
  `;

  bindFresh(root, { click: onClick });
}

/* ---------------- 小计算 ---------------- */

function thisWeekMinutes(all) {
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // 周一
  const start = dateStr(d);
  const today = todayStr();
  return all
    .filter((s) => s.date >= start && s.date <= today)
    .reduce((sum, s) => sum + (Number(s.minutes) || 0), 0);
}

function subjectName(id) {
  const s = table("subjects").find((x) => x.id === id);
  return s ? s.name : "（对象已删）";
}

/* ---------------- 画 ---------------- */

function subjectRow(s) {
  const mine = table("studies").filter((x) => x.subjectId === s.id);
  const minutes = mine.reduce((sum, x) => sum + (Number(x.minutes) || 0), 0);
  const pending = mine.filter((x) => !x.reviewed).length;
  return `
    <li class="item" data-id="${esc(s.id)}">
      <span class="i-title">${esc(s.name)}</span>
      ${chip(s.kind || "其它")}
      ${imgBadge(s.imagePaths, "图")}
      ${s.source ? `<span class="i-meta">${esc(s.source)}</span>` : ""}
      <span class="i-note">${esc(s.note || "")}</span>
      <span class="i-meta">学了 ${mine.length} 次 · ${minutes} 分钟${pending ? ` · 待复习 ${pending}` : ""}</span>
      <span class="i-actions">
        <button class="link" data-act="sub-edit">编辑</button>
        <button class="link danger" data-act="sub-del">删除</button>
      </span>
    </li>`;
}

function studyRow(s) {
  return `
    <li class="item" data-id="${esc(s.id)}">
      <span class="i-meta">${esc(s.date || "")}</span>
      <span class="i-title">${esc(s.content || "（没写学了什么）")}</span>
      ${chip(subjectName(s.subjectId))}
      ${imgBadge(s.imagePaths, "图")}
      <span class="chip">${s.reviewed ? "已复习" : "待复习"}</span>
      ${Number(s.minutes) ? `<span class="i-meta">${esc(s.minutes)} 分钟</span>` : ""}
      <span class="i-note">${esc(s.takeaway || "")}</span>
      <span class="i-actions">
        <button class="link" data-act="st-review">${s.reviewed ? "标记待复习" : "标记已复习"}</button>
        <button class="link" data-act="st-edit">编辑</button>
        <button class="link danger" data-act="st-del">删除</button>
      </span>
    </li>`;
}

function redraw() {
  renderStudy(document.getElementById("view"));
}

/* ---------------- 事件 ---------------- */

function findRow(key, id) {
  return table(key).find((x) => x.id === id) || null;
}

/** 学习对象的下拉选项：id + 名称，交给弹窗去画 */
function subjectChoices() {
  return table("subjects").map((s) => [s.id, s.name]);
}

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
  const li = btn.closest("[data-id]");
  const id = li ? li.dataset.id : "";

  if (act === "sub-add") {
    openItemDialog("studyItem", null);
  } else if (act === "sub-edit") {
    const s = findRow("subjects", id);
    if (s) openItemDialog("studyItem", s);
  } else if (act === "sub-del") {
    const s = findRow("subjects", id);
    if (!s) return;
    const n = table("studies").filter((x) => x.subjectId === id).length;
    const ok = await askConfirm({
      title: `删除「${s.name}」？`,
      message: n ? `它的 ${n} 条学习记录也一起进回收站。` : "会放进回收站。",
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    moveToTrash("subjects", s, s.name);
    for (const row of table("studies").filter((x) => x.subjectId === id)) {
      moveToTrash("studies", row, row.content);
    }
    touch(true);
    toast("已移入回收站");
  } else if (act === "st-add") {
    openItemDialog("studyRecord", null, {
      date: selected,
      ctx: { subjects: subjectChoices() },
      onSaved: (saved) => {
        selected = saved.date || selected; // 补记到别的日期时，跟着切过去
        redraw();
      },
    });
  } else if (act === "st-edit") {
    const s = findRow("studies", id);
    if (s) {
      openItemDialog("studyRecord", s, {
        ctx: { subjects: subjectChoices() },
        onSaved: (saved) => {
          selected = saved.date || selected; // 改到别的日期就跟着切过去
          redraw();
        },
      });
    }
  } else if (act === "st-review") {
    const s = findRow("studies", id);
    if (!s) return;
    s.reviewed = !s.reviewed;
    touch(true);
    toast(s.reviewed ? "标记为已复习" : "标记为待复习");
  } else if (act === "st-del") {
    const s = findRow("studies", id);
    if (!s) return;
    const ok = await askConfirm({
      title: `删除 ${s.date} 这条学习记录？`,
      message: "会放进回收站。",
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    moveToTrash("studies", s, s.content);
    touch(true);
    toast("已移入回收站");
  }
}
