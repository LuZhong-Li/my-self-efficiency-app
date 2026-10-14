/* 笔记：左边列表、右边写。正文就是 Markdown 源码，右上角「预览」看渲染结果。
 *
 * 为什么不开弹窗：弹窗是给「填几条字段」用的，写长文该像本地编辑器 ——
 * 打字时静默保存（不重画，光标不跳），离开输入框时正常保存并刷新左边列表。
 * 渲染是纯逻辑（markdown.js），图片走现成的附件组件（目录 note，早就预留好了）。
 */

import { store, touch, table, esc, uid, moveToTrash } from "./store.js";
import { pageHeader, bindFresh, emptyState } from "./ui.js";
import { askConfirm, toast } from "./dialog.js";
import { icon } from "./icons.js";
import { tagsOfRow, tagColor, normalizeTags, tagInputError } from "./tag-calc.js";
import { renderMarkdown } from "./markdown.js";
import { assetsOf, assetPickBoxHtml } from "./asset-calc.js";
import { openAssetDialog } from "./media.js";
import {
  createAttach, mountAttach, disposeAttach, uploadPending, commitUploads, rowPaths,
} from "./attachment.js";

let currentId = null;   // 正在写哪一条（只记在内存里：刷新回到「没选」）
let filterText = "";    // 左边列表的筛选词（也只记在内存里）
let preview = false;    // 预览开着没（也只记在内存里）
let attach = null;      // 当前这条的图片会话（重画时按当前这条重建）

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
  // 图片区：每条笔记一份会话，重画时按当前这条重建 —— 但**待存的那几张要带过去**
  // （它们还只是内存里的 blob，重建时丢掉就等于白贴了）。
  const pending = attach && Array.isArray(attach.files) ? attach.files.slice() : [];
  if (cur) {
    attach = createAttach({ module: "note", paths: rowPaths(cur), files: pending });
    // 图片区自己变了（加了一张 / 撤了一张）就重画一次：
    // 「保存图片」那个按钮要靠重画才露出来，撤掉已存的图也要立刻写回记录
    mountAttach(root.querySelector("#note-attach"), attach, {
      onChange: (state) => {
        const note = findNote(currentId);
        if (note) {
          note.imagePaths = state.paths.slice();
          stamp(note);
        }
        touch(true);
      },
    });
  } else {
    if (attach) disposeAttach(attach);
    attach = null;
  }
  // 素材那一块：勾 / 取消勾直接写进这条笔记（不用等保存按钮）；「＋ 新建素材」叠开素材弹窗
  const assetBox = root.querySelector('[data-assets="note-assets"]');
  if (assetBox) {
    const write = () => {
      const note = findNote(currentId);
      if (!note) return;
      note.assetIds = [...assetBox.querySelectorAll("[data-asset-pick]:checked")]
        .map((i) => i.value);
      stamp(note);
      touch(true);
    };
    assetBox.addEventListener("change", (e) => {
      if (e.target.closest("[data-asset-pick]")) write();
    });
    assetBox.addEventListener("click", (e) => {
      if (!e.target.closest("[data-asset-new]")) return;
      // 建完重画一次，新素材马上能勾
      openAssetDialog(null, { after: () => touch(true) });
    });
  }
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
      <button class="link" data-act="note-preview">${preview ? "收起预览" : "预览"}</button>
      <button class="link danger" data-act="note-del">删除</button>
    </div>
    <div class="note-body${preview ? " with-preview" : ""}">
      <textarea id="note-body" class="note-text"
        placeholder="写点什么…（支持 Markdown：标题 #、列表 -、加粗 **、代码块 三个反引号）">${esc(cur.body || "")}</textarea>
      ${preview ? `<div class="note-render md-body">${renderMarkdown(cur.body)}</div>` : ""}
    </div>
    <div class="note-meta">
      <label class="note-tags-label" for="note-tags">标签</label>
      <input id="note-tags" class="grow" maxlength="200" autocomplete="off"
        placeholder="逗号分开，比如：想法、开发" value="${esc(tagsOfRow(cur).join(", "))}">
    </div>
    <div class="attach-host" id="note-attach"></div>
    ${attach && attach.files.length
      ? `<button class="link" data-act="note-save-img">保存图片（${attach.files.length} 张还没存）</button>`
      : ""}
    <label class="fin-label">素材</label>
    <div class="dlg-assets" data-assets="note-assets">
      ${assetPickBoxHtml(assetsOf(store.data),
        new Set(Array.isArray(cur.assetIds) ? cur.assetIds : []))}
    </div>
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
async function onChange(e) {
  const note = findNote(currentId);
  if (!note) return;
  if (e.target.id === "note-title") note.title = e.target.value;
  else if (e.target.id === "note-body") note.body = e.target.value;
  else if (e.target.id === "note-tags") {
    const err = tagInputError(e.target.value);
    if (err) {
      toast(err, "err");
      return;
    }
    note.tags = normalizeTags(e.target.value);
  } else return;
  stamp(note);
  touch(true);
  // 离开输入框时顺手把待存的图存掉（贴完图直接点别处也不会丢）
  if (attach && attach.files.length) await saveImages();
}

/** 把待存的那几张图真写进 附件目录/note/，再记到这条笔记上 */
async function saveImages() {
  const note = findNote(currentId);
  if (!note || !attach || !attach.files.length) return;
  let uploaded = [];
  try {
    uploaded = await uploadPending(attach);
  } catch (err) {
    toast("图片没存下：" + err.message, "err");
    return;
  }
  commitUploads(attach, uploaded);
  note.imagePaths = attach.paths.slice();
  stamp(note);
  touch(true);
  toast("图片已存下");
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
  if (act === "note-preview") {
    preview = !preview;
    touch();       // 只重画，不落盘
    return;
  }
  if (act === "note-save-img") {
    await saveImages();
    return;
  }
  if (act === "note-del") {
    const note = findNote(currentId);
    if (note) await deleteNote(note);
  }
}
