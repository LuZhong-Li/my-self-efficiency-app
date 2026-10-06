/* 学习工作：学习对象（书 / 课程 / 视频 / 技能）+ 按天的学习记录
 *
 * 从原来的「咨询工作」改过来的：客户 → 学习对象，咨询记录 → 学习记录，
 * 「未收款 / 已收款」这组改成「待复习 / 已复习」，时长还是记分钟。
 */

import { touch, uid, table, esc, todayStr, dateStr, moveToTrash } from "./store.js";
import { emptyState, chip, options, bindFresh, pageHeader } from "./ui.js";
import { askConfirm, toast } from "./dialog.js";
import { monthGridHtml, calendarAction, dayLabel, KIND_STUDY } from "./calendar.js";

const KINDS = ["书", "课程", "视频", "技能", "其它"];

let selected = null;        // 月历选中的那天（默认今天）
let editingSubject = null;  // 正在编辑的学习对象 id
let editingStudy = null;    // 正在编辑的学习记录 id

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
        <span class="hint">${esc(dayLabel(selected))}</span>
      </div>
      ${
        subjects.length
          ? `<form class="add-form" id="add-study" autocomplete="off">
               <input name="date" type="date" value="${selected}" title="日期">
               <select name="subjectId" title="学习对象">${subjectOptions(subjects)}</select>
               <input name="minutes" type="number" min="0" step="5" placeholder="时长(分)" title="学习时长（分钟）">
               <input name="content" class="grow" maxlength="120" placeholder="今天学了什么…">
               <input name="takeaway" class="grow-note" maxlength="200" placeholder="心得 / 疑问">
               <button class="btn primary" type="submit">记一条</button>
             </form>`
          : `<p class="hint">先在下面加一个学习对象（书、课程、技能都行），再回来记。</p>`
      }
      ${
        dayStudies.length
          ? `<ul class="items">${dayStudies.map(studyRow).join("")}</ul>`
          : emptyState("这天还没记学习", "上面记一条，日历上就会出现一个小圆点。", "", "study")
      }
    </section>

    <section class="card">
      <div class="card-head">
        <h2>学习对象</h2>
        <span class="hint">共 ${subjects.length} 个</span>
      </div>
      <form class="add-form" id="add-subject" autocomplete="off">
        <input name="name" class="grow" maxlength="60" required placeholder="书名 / 课程名 / 要练的技能…">
        <select name="kind" title="类型">${options(KINDS)}</select>
        <input name="source" maxlength="60" placeholder="作者 / 平台">
        <input name="note" class="grow-note" maxlength="120" placeholder="备注（可不填）">
        <button class="btn primary" type="submit">添加</button>
      </form>
      ${
        subjects.length
          ? `<ul class="items">${subjects.map(subjectRow).join("")}</ul>`
          : emptyState("还没有学习对象", "先把想学的列出来，学的时候好归位。", "", "study")
      }
    </section>
  `;

  bindFresh(root, { submit: onSubmit, click: onClick });
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

function subjectOptions(subjects, current) {
  return subjects
    .map(
      (s) =>
        `<option value="${esc(s.id)}"${s.id === current ? " selected" : ""}>${esc(s.name)}</option>`
    )
    .join("");
}

/* ---------------- 画 ---------------- */

function subjectRow(s) {
  if (s.id === editingSubject) {
    return `
      <li class="item editing" data-id="${esc(s.id)}">
        <input data-field="name" class="grow" maxlength="60" value="${esc(s.name)}">
        <select data-field="kind">${options(KINDS, s.kind)}</select>
        <input data-field="source" maxlength="60" placeholder="作者 / 平台" value="${esc(s.source || "")}">
        <input data-field="note" class="grow-note" maxlength="120" placeholder="备注" value="${esc(s.note || "")}">
        <button class="btn primary small" data-act="sub-save">保存</button>
        <button class="btn small" data-act="sub-cancel">取消</button>
      </li>`;
  }
  const mine = table("studies").filter((x) => x.subjectId === s.id);
  const minutes = mine.reduce((sum, x) => sum + (Number(x.minutes) || 0), 0);
  const pending = mine.filter((x) => !x.reviewed).length;
  return `
    <li class="item" data-id="${esc(s.id)}">
      <span class="i-title">${esc(s.name)}</span>
      ${chip(s.kind || "其它")}
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
  if (s.id === editingStudy) {
    return `
      <li class="item editing" data-id="${esc(s.id)}">
        <input data-field="date" type="date" value="${esc(s.date || "")}">
        <select data-field="subjectId">${subjectOptions(table("subjects"), s.subjectId)}</select>
        <input data-field="minutes" type="number" min="0" step="5" placeholder="时长(分)" value="${s.minutes ? esc(s.minutes) : ""}">
        <select data-field="reviewed">
          <option value="0"${s.reviewed ? "" : " selected"}>待复习</option>
          <option value="1"${s.reviewed ? " selected" : ""}>已复习</option>
        </select>
        <input data-field="content" class="grow" maxlength="120" placeholder="学了什么" value="${esc(s.content || "")}">
        <input data-field="takeaway" class="grow-note" maxlength="200" placeholder="心得 / 疑问" value="${esc(s.takeaway || "")}">
        <button class="btn primary small" data-act="st-save">保存</button>
        <button class="btn small" data-act="st-cancel">取消</button>
      </li>`;
  }
  return `
    <li class="item" data-id="${esc(s.id)}">
      <span class="i-meta">${esc(s.date || "")}</span>
      <span class="i-title">${esc(s.content || "（没写学了什么）")}</span>
      ${chip(subjectName(s.subjectId))}
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

function onSubmit(e) {
  const form = e.target;

  if (form.id === "add-subject") {
    e.preventDefault();
    const name = form.name.value.trim();
    if (!name) return;
    table("subjects").push({
      id: uid(),
      name,
      kind: form.kind.value,
      source: form.source.value.trim(),
      note: form.note.value.trim(),
    });
    touch(true);
    toast("学习对象已添加");
    return;
  }

  if (form.id === "add-study") {
    e.preventDefault();
    const content = form.content.value.trim();
    const takeaway = form.takeaway.value.trim();
    if (!content && !takeaway) {
      toast("至少写一句学了什么", "err");
      return;
    }
    selected = form.date.value || todayStr(); // 补记别的日期时跟着切过去
    table("studies").push({
      id: uid(),
      subjectId: form.subjectId.value,
      date: selected,
      minutes: Number(form.minutes.value) || 0,
      content,
      takeaway,
      reviewed: false,
    });
    touch(true);
    toast(`已记到 ${selected}`);
  }
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

  if (act === "sub-edit") {
    editingSubject = id;
    redraw();
  } else if (act === "sub-cancel") {
    editingSubject = null;
    redraw();
  } else if (act === "sub-save") {
    const s = findRow("subjects", id);
    if (!s) return;
    const name = li.querySelector('[data-field="name"]').value.trim();
    if (!name) {
      toast("名称不能是空的", "err");
      return;
    }
    s.name = name;
    s.kind = li.querySelector('[data-field="kind"]').value;
    s.source = li.querySelector('[data-field="source"]').value.trim();
    s.note = li.querySelector('[data-field="note"]').value.trim();
    editingSubject = null;
    touch(true);
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
    if (editingSubject === id) editingSubject = null;
    touch(true);
    toast("已移入回收站");
  } else if (act === "st-edit") {
    editingStudy = id;
    redraw();
  } else if (act === "st-cancel") {
    editingStudy = null;
    redraw();
  } else if (act === "st-save") {
    const s = findRow("studies", id);
    if (!s) return;
    const val = (name) => li.querySelector(`[data-field="${name}"]`).value;
    s.date = val("date") || todayStr();
    s.subjectId = val("subjectId");
    s.minutes = Number(val("minutes")) || 0;
    s.reviewed = val("reviewed") === "1";
    s.content = val("content").trim();
    s.takeaway = val("takeaway").trim();
    editingStudy = null;
    touch(true);
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
    if (editingStudy === id) editingStudy = null;
    touch(true);
    toast("已移入回收站");
  }
}
