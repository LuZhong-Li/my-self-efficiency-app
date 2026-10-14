/* 笔记：左边列表、右边写。正文就是 Markdown 源码，右上角「预览」看渲染结果。
 *
 * 为什么不开弹窗：弹窗是给「填几条字段」用的，写长文该像本地编辑器 ——
 * 打字时静默保存（不重画，光标不跳），离开输入框时正常保存并刷新左边列表。
 * 渲染是纯逻辑（markdown.js），图片走现成的附件组件（目录 note，早就预留好了）。
 */

import { touch, table, esc, uid, moveToTrash } from "./store.js";
import { pageHeader, bindFresh, emptyState } from "./ui.js";
import { askConfirm, toast } from "./dialog.js";
import { icon } from "./icons.js";
import { tagsOfRow, tagColor } from "./tag-calc.js";

let currentId = null;   // 正在写哪一条（只记在内存里：刷新回到「没选」）
let filterText = "";    // 左边列表的筛选词（也只记在内存里）

export function renderNote(root, sub = "") {
  const notes = table("notes");
  // 地址 #note/<id>：从搜索点过来直接打开那一条
  if (sub && notes.some((n) => n.id === sub)) currentId = sub;
  const cur = notes.find((n) => n.id === currentId) || null;
  root.innerHTML = `
    ${pageHeader("note", `<span class="date-chip">${notes.length} 篇</span>`)}
    <div class="note-layout">
      <section class="card note-side">
        <div class="card-head">
          <h2>笔记</h2>
          <div class="card-tools">
            <button class="btn primary small" data-act="note-new">${icon("plus", 14)}新笔记</button>
          </div>
        </div>
        <input id="note-filter" class="grow note-filter" maxlength="60" autocomplete="off"
          placeholder="筛选标题 / 正文 / 标签…" value="${esc(filterText)}">
        <div id="note-list-host">${listHtml(notes)}</div>
      </section>
      <section class="card note-main">${editorHtml(cur)}</section>
    </div>
  `;
  bindFresh(root, { click: onClick, input: onInput, change: onChange });
}

/** 正文第一行（没标题时用它顶上列表） */
function firstLine(body) {
  const line = String(body || "").split("\n").find((l) => l.trim()) || "";
  return line.replace(/^#+\s*/, "").replace(/^[-*+]\s+/, "").trim().slice(0, 40);
}

/** 列表上那句摘要：正文去掉 Markdown 记号，掐前 60 个字 */
function subText(n) {
  return String(n.body || "").replace(/[#>*`~]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

/** 右边那块：选了笔记就是编辑器，没选就一句提示 */
function editorHtml(cur) {
  if (!cur) {
    return `<div class="note-pick-hint">${emptyState(
      "选一条，或者新建一条",
      "左边点一条笔记开始写；右上角「新笔记」开一条新的。",
      "",
      "pencil"
    )}</div>`;
  }
  return `
    <div class="note-editor-head">
      <input id="note-title" class="grow note-title" maxlength="80" autocomplete="off"
        placeholder="标题（可以空着）" value="${esc(cur.title || "")}">
      <button class="link danger" data-act="note-del">删除</button>
    </div>
    <textarea id="note-body" class="note-text"
      placeholder="写点什么…（支持 Markdown：标题 #、列表 -、加粗 **、代码块 三个反引号）">${esc(cur.body || "")}</textarea>
    <p class="note-hint">打字会自动存；离开输入框会刷新左边列表。</p>
  `;
}

/** 左边那一列：按更新时间倒序（越新越上面），再按筛选词过一遍 */
function listHtml(notes) {
  const kw = filterText.trim().toLowerCase();
  const rows = notes
    .slice()
    .sort((a, b) =>
      String(a.updatedAt || a.createdAt) < String(b.updatedAt || b.createdAt) ? 1 : -1)
    .filter((n) => {
      if (!kw) return true;
      const hay = [n.title, n.body, tagsOfRow(n).join(" ")].join(" ").toLowerCase();
      return hay.includes(kw);
    });
  if (!rows.length) {
    return notes.length
      ? `<p class="empty">没有符合「${esc(filterText.trim())}」的笔记。</p>`
      : `<p class="empty note-empty">还没有笔记。点右上角「新笔记」写第一条。</p>`;
  }
  return `<ul class="items note-list">${rows.map(noteRow).join("")}</ul>`;
}

/** 列表上的一行（整行可点 = 选这条） */
function noteRow(n) {
  const title = n.title || firstLine(n.body) || "（空笔记）";
  const chips = tagsOfRow(n)
    .slice(0, 3)
    .map((t) => `<span class="chip tag-chip" data-c="${tagColor(t)}">${esc(t)}</span>`)
    .join("");
  return `
    <li class="item note-row${n.id === currentId ? " active" : ""}"
        data-act="note-pick" data-id="${esc(n.id)}">
      <span class="i-title nr-title">${esc(title)}</span>
      <span class="i-note nr-sub">${esc(subText(n))}</span>
      ${chips}
    </li>`;
}

function findNote(id) {
  return table("notes").find((n) => n && n.id === id) || null;
}

/** 记一下「刚改过」（列表按这个倒序） */
function stamp(n) {
  n.updatedAt = new Date().toISOString();
  return n;
}

/** 新建一条空的并选中它 */
function newNote() {
  const now = new Date().toISOString();
  const row = {
    id: uid(), title: "", body: "", tags: [], imagePaths: [],
    createdAt: now, updatedAt: now,
  };
  table("notes").push(row);
  currentId = row.id;
  touch(true);
}

async function deleteNote(row) {
  const ok = await askConfirm({
    title: "删掉这篇笔记？",
    message: `${row.title || firstLine(row.body) || "（空笔记）"}\n\n` +
      "会放进回收站，误删可以去「数据与设置」找回。",
    confirmLabel: "删除",
    danger: true,
  });
  if (!ok) return;
  moveToTrash("notes", row, row.title || firstLine(row.body) || "空笔记");
  if (currentId === row.id) currentId = null;
  touch(true);
  toast("已移入回收站");
}

/** 打字时静默保存：只写数据、不重画（光标不会跳） */
function onInput(e) {
  // 筛选框：只重画左边那一列（整页重画会把正在打字的框冲掉）
  if (e.target.id === "note-filter") {
    filterText = e.target.value;
    const host = document.getElementById("note-list-host");
    if (host) host.innerHTML = listHtml(table("notes"));
    return;
  }
  const note = findNote(currentId);
  if (!note) return;
  if (e.target.id === "note-title") note.title = e.target.value;
  else if (e.target.id === "note-body") note.body = e.target.value;
  else return;
  stamp(note);
  touch(false, true);
}

/** 离开输入框：正常保存一次并重画（列表的标题 / 摘要 / 排序跟着变） */
function onChange(e) {
  const note = findNote(currentId);
  if (!note) return;
  if (e.target.id === "note-title") note.title = e.target.value;
  else if (e.target.id === "note-body") note.body = e.target.value;
  else return;
  stamp(note);
  touch(true);
}

async function onClick(e) {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === "note-new") {
    newNote();
    return;
  }
  if (act === "note-pick") {
    currentId = btn.dataset.id;
    touch(true);
    return;
  }
  if (act === "note-del") {
    const note = findNote(currentId);
    if (note) await deleteNote(note);
  }
}
