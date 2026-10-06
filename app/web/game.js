/* 游戏娱乐：在玩 / 想玩 / 已通关 / 弃坑 */

import { touch, uid, table, esc, moveToTrash } from "./store.js";
import { sectionHead, emptyState, chip, options, bindFresh, pageHeader } from "./ui.js";
import { askConfirm, toast } from "./dialog.js";

const STATUSES = ["在玩", "想玩", "已通关", "弃坑"];
const PLATFORMS = ["PC", "Switch", "PS5", "手机", "其它"];

let editingId = null;

export function renderGame(root) {
  const items = table("games");

  root.innerHTML = `
    ${pageHeader("game", `<span class="date-chip">共 ${items.length} 款</span>`)}
    <section class="card">
      <form class="add-form" id="add-form" autocomplete="off">
        <input name="name" class="grow" maxlength="80" required placeholder="游戏名…">
        <input name="platform" list="game-platform-list" maxlength="20" placeholder="平台">
        <datalist id="game-platform-list">
          ${PLATFORMS.map((p) => `<option>${esc(p)}</option>`).join("")}
        </datalist>
        <select name="status" title="状态">${options(STATUSES)}</select>
        <input name="hours" type="number" min="0" step="1" placeholder="小时" title="累计游玩时长（小时）">
        <input name="progress" class="grow-note" maxlength="120" placeholder="进度备注（可不填）">
        <button class="btn primary" type="submit">添加</button>
      </form>

      ${
        items.length
          ? STATUSES.map((s) => block(items, s)).join("")
          : emptyState("还没有游戏", "想玩的、在玩的、通关的都记一下。", "", "game")
      }
    </section>
  `;

  bindFresh(root, { submit: onSubmit, click: onClick });
}

/* ---------------- 画 ---------------- */

function block(items, status) {
  const list = items.filter((g) => (g.status || "想玩") === status);
  const hours = list.reduce((sum, g) => sum + (Number(g.hours) || 0), 0);
  const extra = status === "在玩" && hours ? `累计 ${hours} 小时` : "";
  return (
    sectionHead(status, list.length, extra) +
    (list.length ? `<ul class="items">${list.map(row).join("")}</ul>` : "")
  );
}

function row(g) {
  if (g.id === editingId) return editRow(g);
  const hours = Number(g.hours) || 0;
  return `
    <li class="item${g.status === "已通关" || g.status === "弃坑" ? " done" : ""}" data-id="${esc(g.id)}">
      <span class="i-title">${esc(g.name)}</span>
      ${chip(g.platform)}
      <span class="i-meta">${hours ? hours + " 小时" : ""}</span>
      <span class="i-note">${esc(g.progress || "")}</span>
      <span class="i-actions">
        <button class="link" data-act="edit">编辑</button>
        <button class="link danger" data-act="delete">删除</button>
      </span>
    </li>`;
}

function editRow(g) {
  return `
    <li class="item editing" data-id="${esc(g.id)}">
      <input data-field="name" class="grow" maxlength="80" placeholder="游戏名" value="${esc(g.name)}">
      <input data-field="platform" list="game-platform-list" maxlength="20" placeholder="平台" value="${esc(g.platform || "")}">
      <select data-field="status">${options(STATUSES, g.status)}</select>
      <input data-field="hours" type="number" min="0" step="1" placeholder="小时" value="${g.hours === 0 || g.hours ? esc(g.hours) : ""}">
      <input data-field="progress" class="grow-note" maxlength="120" placeholder="进度备注" value="${esc(g.progress || "")}">
      <button class="btn primary small" data-act="save">保存</button>
      <button class="btn small" data-act="cancel">取消</button>
    </li>`;
}

function redraw() {
  renderGame(document.getElementById("view"));
}

/* ---------------- 事件 ---------------- */

function find(id) {
  return table("games").find((g) => g.id === id) || null;
}

function onSubmit(e) {
  if (!e.target.matches("#add-form")) return;
  e.preventDefault();
  const form = e.target;
  const name = form.name.value.trim();
  if (!name) return;
  table("games").push({
    id: uid(),
    name,
    platform: form.platform.value.trim(),
    status: form.status.value,
    progress: form.progress.value.trim(),
    hours: Number(form.hours.value) || 0,
  });
  touch(true);
}

async function onClick(e) {
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
    const name = val("name").trim();
    if (!name) {
      toast("游戏名不能是空的", "err");
      return;
    }
    item.name = name;
    item.platform = val("platform").trim();
    item.status = val("status");
    item.hours = Number(val("hours")) || 0;
    item.progress = val("progress").trim();
    editingId = null;
    touch(true);
  } else if (act === "delete") {
    const ok = await askConfirm({
      title: `删除「${item.name}」？`,
      message: "会放进回收站，误删可找回。",
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    moveToTrash("games", item, item.name);
    if (editingId === item.id) editingId = null;
    touch(true);
    toast("已移入回收站");
  }
}
