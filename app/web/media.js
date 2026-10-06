/* 自媒体：想法 → 写作中 → 待发布 → 已发布（发布记录按日期排） */

import { touch, uid, table, esc, todayStr, moveToTrash } from "./store.js";
import { sectionHead, emptyState, chip, options, bindFresh, pageHeader } from "./ui.js";
import { askConfirm, toast } from "./dialog.js";
import { monthGridHtml, calendarAction, dayLabel, KIND_PUBLISH } from "./calendar.js";

const STATUSES = ["想法", "写作中", "待发布", "已发布"];
const PLATFORMS = ["小红书", "公众号", "抖音", "B站", "视频号", "知乎"];

let editingId = null;
let selected = null; // 排期月历里选中的那天

export function renderMedia(root) {
  const items = table("contents");
  if (!selected) selected = todayStr();
  const dayItems = items.filter((c) => (c.publishDate || c.planDate) === selected);

  root.innerHTML = `
    ${pageHeader("media", `<span class="date-chip">共 ${items.length} 条</span>`)}

    <section class="card">
      ${monthGridHtml({
        selected,
        kinds: KIND_PUBLISH,
        marksOf: (date) => {
          const marks = [];
          for (const _ of items.filter((c) => c.publishDate === date)) marks.push({ kind: "publish" });
          for (const _ of items.filter((c) => !c.publishDate && c.planDate === date)) {
            marks.push({ kind: "planned" });
          }
          return marks;
        },
      })}
    </section>

    <section class="card">
      <div class="card-head">
        <h2>${esc(dayLabel(selected))}</h2>
        <span class="hint">${dayItems.length ? dayItems.length + " 条安排" : ""}</span>
      </div>
      ${
        dayItems.length
          ? `<ul class="items">${dayItems.map(dayRow).join("")}</ul>`
          : emptyState("这天没有发布安排", "下面可以给这天排一条内容。", "", "media")
      }
      <form class="add-form" id="add-plan" autocomplete="off">
        <input name="title" class="grow" maxlength="120" required placeholder="给这一天排一条内容…">
        <input name="platform" list="platform-list" maxlength="20" placeholder="平台">
        <button class="btn primary" type="submit">排到这天</button>
      </form>
    </section>

    <section class="card">
      <form class="add-form" id="add-form" autocomplete="off">
        <input name="title" class="grow" maxlength="120" required placeholder="选题 / 标题…">
        <input name="platform" list="platform-list" maxlength="20" placeholder="平台">
        <datalist id="platform-list">
          ${PLATFORMS.map((p) => `<option>${esc(p)}</option>`).join("")}
        </datalist>
        <select name="status" title="状态">${options(STATUSES)}</select>
        <input name="planDate" type="date" title="计划发布日期（可不填）">
        <button class="btn primary" type="submit">添加</button>
      </form>

      ${
        items.length
          ? STATUSES.map((s) => block(items, s)).join("")
          : emptyState("还没有内容", "把想到的选题先记下来，再慢慢推进。", "", "media")
      }
    </section>
  `;

  bindFresh(root, { submit: onSubmit, click: onClick });
}

function dayRow(c) {
  const published = c.publishDate === selected;
  return `
    <li class="item" data-id="${esc(c.id)}">
      <span class="i-title">${esc(c.title)}</span>
      ${chip(c.platform)}
      <span class="chip">${published ? "已发布" : "计划发布"}</span>
      ${published && c.link ? `<a class="link" href="${esc(c.link)}" target="_blank" rel="noreferrer">链接</a>` : ""}
      <span class="i-actions">
        ${published ? "" : `<button class="link" data-act="cal-publish">标记已发布</button>`}
        <button class="link danger" data-act="delete">删除</button>
      </span>
    </li>`;
}

/* ---------------- 画 ---------------- */

function block(items, status) {
  let list = items.filter((c) => (c.status || "想法") === status);
  let extra = "";
  if (status === "已发布") {
    list = list.slice().sort((a, b) => ((a.publishDate || "") < (b.publishDate || "") ? 1 : -1));
    extra = "按发布日期排";
  }
  return (
    sectionHead(status, list.length, extra) +
    (list.length ? `<ul class="items">${list.map(row).join("")}</ul>` : "")
  );
}

function row(c) {
  if (c.id === editingId) return editRow(c);
  const published = c.status === "已发布";
  const when = published
    ? c.publishDate || ""
    : c.planDate
    ? "计划 " + c.planDate
    : "";
  return `
    <li class="item${published ? " done" : ""}" data-id="${esc(c.id)}">
      <span class="i-title">${esc(c.title)}</span>
      ${chip(c.platform)}
      <span class="i-meta">${esc(when)}</span>
      ${c.link ? `<a class="link" href="${esc(c.link)}" target="_blank" rel="noreferrer">链接</a>` : ""}
      <span class="i-actions">
        ${c.status === "待发布" ? `<button class="link" data-act="publish">标记已发布</button>` : ""}
        <button class="link" data-act="edit">编辑</button>
        <button class="link danger" data-act="delete">删除</button>
      </span>
    </li>`;
}

function editRow(c) {
  return `
    <li class="item editing" data-id="${esc(c.id)}">
      <input data-field="title" class="grow" maxlength="120" placeholder="标题" value="${esc(c.title)}">
      <input data-field="platform" list="platform-list" maxlength="20" placeholder="平台" value="${esc(c.platform || "")}">
      <select data-field="status">${options(STATUSES, c.status)}</select>
      <input data-field="planDate" type="date" title="计划发布日期" value="${esc(c.planDate || "")}">
      <input data-field="publishDate" type="date" title="发布日期" value="${esc(c.publishDate || "")}">
      <input data-field="link" class="grow-note" maxlength="300" placeholder="发布后的链接" value="${esc(c.link || "")}">
      <button class="btn primary small" data-act="save">保存</button>
      <button class="btn small" data-act="cancel">取消</button>
    </li>`;
}

function redraw() {
  renderMedia(document.getElementById("view"));
}

/* ---------------- 事件 ---------------- */

function find(id) {
  return table("contents").find((c) => c.id === id) || null;
}

function onSubmit(e) {
  if (e.target.id === "add-plan") {
    e.preventDefault();
    const form = e.target;
    const title = form.title.value.trim();
    if (!title) return;
    table("contents").push({
      id: uid(),
      title,
      platform: form.platform.value.trim(),
      status: "待发布",
      planDate: selected,
      publishDate: "",
      link: "",
    });
    touch(true);
    toast(`已排到 ${selected}`);
    return;
  }
  if (!e.target.matches("#add-form")) return;
  e.preventDefault();
  const form = e.target;
  const title = form.title.value.trim();
  if (!title) return;
  table("contents").push({
    id: uid(),
    title,
    platform: form.platform.value.trim(),
    status: form.status.value,
    planDate: form.planDate.value || "",
    publishDate: "",
    link: "",
  });
  touch(true);
}

async function onClick(e) {
  const cal = calendarAction(e);
  if (cal.handled) {
    if (cal.selected) selected = cal.selected;
    renderMedia(document.getElementById("view"));
    return;
  }

  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  const li = btn.closest("[data-id]");
  const item = li ? find(li.dataset.id) : null;
  if (!item) return;

  if (act === "edit") {
    editingId = item.id;
    redraw();
  } else if (act === "cancel") {
    editingId = null;
    redraw();
  } else if (act === "save") {
    const val = (name) => li.querySelector(`[data-field="${name}"]`).value;
    const title = val("title").trim();
    if (!title) {
      toast("标题不能是空的", "err");
      return;
    }
    item.title = title;
    item.platform = val("platform").trim();
    item.status = val("status");
    item.planDate = val("planDate") || "";
    item.publishDate = val("publishDate") || "";
    item.link = val("link").trim();
    if (item.status === "已发布" && !item.publishDate) item.publishDate = todayStr();
    editingId = null;
    touch(true);
  } else if (act === "publish") {
    item.status = "已发布";
    if (!item.publishDate) item.publishDate = todayStr();
    touch(true);
  } else if (act === "cal-publish") {
    // 在「某一天」的卡片里标记发布，就算在那一天，不是算今天
    item.status = "已发布";
    item.publishDate = selected;
    touch(true);
    toast(`已按 ${selected} 记为发布`);
  } else if (act === "delete") {
    const ok = await askConfirm({
      title: `删除「${item.title}」？`,
      message: "会放进回收站，误删可找回。",
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    moveToTrash("contents", item, item.title);
    if (editingId === item.id) editingId = null;
    touch(true);
    toast("已移入回收站");
  }
}
