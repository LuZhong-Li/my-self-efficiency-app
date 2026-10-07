/* 游戏娱乐：在玩 / 想玩 / 已通关 / 弃坑。
 * 2026-10-07 起录入改成弹窗（和别的模块一套），卡片上只留一个「添加」按钮。 */

import { touch, table, esc, moveToTrash } from "./store.js";
import { sectionHead, emptyState, chip, bindFresh, pageHeader } from "./ui.js";
import { askConfirm, toast } from "./dialog.js";
import { icon } from "./icons.js";
import { imgBadge } from "./attachment.js";
import { openItemDialog } from "./item-dialog.js";
import { GAME_STATUSES } from "./item-form.js";

export function renderGame(root) {
  const items = table("games");

  root.innerHTML = `
    ${pageHeader("game", `<span class="date-chip">共 ${items.length} 款</span>`)}
    <section class="card">
      <div class="card-head">
        <h2>游戏清单</h2>
        <div class="card-tools">
          <button class="btn primary small" data-act="add">${icon("plus", 14)}添加游戏</button>
        </div>
      </div>

      ${
        items.length
          ? GAME_STATUSES.map((s) => block(items, s)).join("")
          : emptyState("还没有游戏", "点右上角「添加游戏」，想玩的、在玩的、通关的都记一下。", "", "game")
      }
    </section>
  `;

  bindFresh(root, { click: onClick });
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
  const hours = Number(g.hours) || 0;
  return `
    <li class="item${g.status === "已通关" || g.status === "弃坑" ? " done" : ""}" data-id="${esc(g.id)}">
      <span class="i-title">${esc(g.name)}</span>
      ${chip(g.platform)}
      ${imgBadge(g.imagePaths, "图")}
      <span class="i-meta">${hours ? hours + " 小时" : ""}</span>
      <span class="i-note">${esc(g.progress || "")}</span>
      <span class="i-actions">
        <button class="link" data-act="edit">编辑</button>
        <button class="link danger" data-act="delete">删除</button>
      </span>
    </li>`;
}

/* ---------------- 事件 ---------------- */

function find(id) {
  return table("games").find((g) => g.id === id) || null;
}

async function onClick(e) {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;

  if (act === "add") {
    openItemDialog("game", null);
    return;
  }

  const li = btn.closest("[data-id]");
  const item = li ? find(li.dataset.id) : null;
  if (!item) return;

  if (act === "edit") {
    openItemDialog("game", item);
  } else if (act === "delete") {
    const ok = await askConfirm({
      title: `删除「${item.name}」？`,
      message: "会放进回收站，误删可找回。",
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    moveToTrash("games", item, item.name);
    touch(true);
    toast("已移入回收站");
  }
}
