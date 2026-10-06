/* 开发工作：项目列表 → 点进项目看待办 / 问题 / 进展 */

import { touch, uid, table, esc, todayStr, moveToTrash } from "./store.js";
import { sectionHead, emptyLine, emptyState, chip, options, bindFresh, pageHeader } from "./ui.js";
import { askConfirm, toast } from "./dialog.js";

const PROJECT_STATUS = ["进行中", "已完成"];
const SEVERITY = ["高", "中", "低"];
const ISSUE_STATUS = ["待处理", "处理中", "已解决", "已关闭"];
const CLOSED = ["已解决", "已关闭"];

let editProject = false;
let editing = null; // {kind: "todo"|"issue", id}
let sorter = null;  // 项目卡片的拖拽实例（每次重画都要重建）

export function renderDev(root, sub) {
  const project = table("projects").find((p) => p.id === sub);
  if (sub && project) renderDetail(root, project);
  else renderList(root);

  bindFresh(root, { submit: onSubmit, click: onClick, change: onChange });
  setupDragSort(root);
}

/**
 * 项目卡片拖拽排序（只在这个页面启用）。
 * 用的是本地的 SortableJS（vendor/Sortable.min.js，MIT，不联网）。
 * 库没加载成功也不影响别的功能，只是拖不动而已。
 */
function setupDragSort(root) {
  if (sorter) {
    try {
      sorter.destroy();
    } catch {
      /* 旧元素已经不在页面上了，忽略 */
    }
    sorter = null;
  }
  if (typeof window.Sortable !== "function") return;

  const grid = root.querySelector(".proj-grid");
  if (!grid || grid.children.length < 2) return;

  sorter = new window.Sortable(grid, {
    animation: 180,          // 回弹动画，配液态玻璃的柔和手感
    ghostClass: "card-ghost",
    chosenClass: "card-chosen",
    dragClass: "card-drag",
    distance: 5,             // 手抖 5 像素算点击（卡片本身是个链接，别把点击吃掉）
    onEnd() {
      // 拖完把 DOM 顺序读回来，重排 projects 数组，整份落盘
      const ids = [...grid.querySelectorAll("[data-id]")].map((el) => el.dataset.id);
      const all = table("projects");
      const ordered = ids.map((id) => all.find((p) => p.id === id)).filter(Boolean);
      for (const p of all) if (!ordered.includes(p)) ordered.push(p); // 兜底：一个都不能丢
      all.length = 0;
      all.push(...ordered);
      touch(true);
      toast("顺序已保存");
    },
  });
  grid.dataset.sortable = "on"; // 给外面（和自检）一个"拖拽已启用"的标记
}

function redraw() {
  renderDev(document.getElementById("view"), (location.hash.split("/")[1] || ""));
}

function todoList(projectId) {
  return table("tasks").filter((t) => t.belong === "dev:" + projectId);
}

function issueList(projectId) {
  return table("issues").filter((i) => i.projectId === projectId);
}

function progressList(projectId) {
  return table("progress")
    .filter((p) => p.projectId === projectId)
    .sort((a, b) => ((a.date || "") < (b.date || "") ? 1 : -1));
}

/* ---------------- 项目列表 ---------------- */

function renderList(root) {
  const projects = table("projects");
  root.innerHTML = `
    ${pageHeader("dev", `<span class="date-chip">${projects.length} 个项目</span>`)}
    <section class="card">
      <form class="add-form" id="add-project" autocomplete="off">
        <input name="name" class="grow" maxlength="80" required placeholder="项目名…">
        <select name="status" title="状态">${options(PROJECT_STATUS)}</select>
        <input name="intro" class="grow-note" maxlength="120" placeholder="一句话简介">
        <input name="startDate" type="date" title="开始日期">
        <button class="btn primary" type="submit">添加项目</button>
      </form>

      ${
        projects.length
          ? `<div class="proj-grid">${projects.map(projCard).join("")}</div>`
          : emptyState("还没有项目", "每个项目一条线：待办、问题、进展。", "", "dev")
      }
    </section>
  `;
}

function projCard(p) {
  const openTodos = todoList(p.id).filter((t) => !t.done).length;
  const bugs = issueList(p.id).filter((i) => !CLOSED.includes(i.status)).length;
  return `
    <a class="proj-card" data-id="${esc(p.id)}" href="#dev/${esc(p.id)}">
      <div class="proj-top">
        <span class="proj-name">${esc(p.name)}</span>
        ${chip(p.status)}
      </div>
      <div class="proj-intro">${esc(p.intro || "（还没有简介）")}</div>
      <div class="proj-counts">待办 ${openTodos} 条 · 未解决 bug ${bugs} 条</div>
      ${p.startDate ? `<div class="proj-meta">开始于 ${esc(p.startDate)}</div>` : ""}
    </a>`;
}

/* ---------------- 项目详情 ---------------- */

function renderDetail(root, p) {
  const todos = todoList(p.id);
  const issues = issueList(p.id);
  const openIssues = issues.filter((i) => !CLOSED.includes(i.status)).length;
  const progress = progressList(p.id);

  root.innerHTML = `
    ${pageHeader("dev", `<a class="link" href="#dev">← 返回项目列表</a>`)}
    <section class="card">
      <div class="card-head">
        <h2>${esc(p.name)}</h2>
        <span class="date-chip">${esc(p.status || "进行中")}</span>
      </div>

      ${
        editProject
          ? `<form class="add-form" id="edit-project" autocomplete="off">
               <input name="name" class="grow" maxlength="80" required value="${esc(p.name)}">
               <select name="status">${options(PROJECT_STATUS, p.status)}</select>
               <input name="intro" class="grow-note" maxlength="120" placeholder="一句话简介" value="${esc(p.intro || "")}">
               <input name="startDate" type="date" value="${esc(p.startDate || "")}">
               <button class="btn primary" type="submit">保存</button>
               <button class="btn" type="button" data-act="p-cancel">取消</button>
             </form>`
          : `<dl class="facts">
               <dt>状态</dt><dd>${esc(p.status || "—")}</dd>
               <dt>简介</dt><dd>${esc(p.intro || "—")}</dd>
               <dt>开始日期</dt><dd>${esc(p.startDate || "—")}</dd>
             </dl>
             <div class="row">
               <button class="btn small" data-act="p-edit">编辑项目</button>
               <button class="btn small danger" data-act="p-delete">删除项目</button>
             </div>`
      }
    </section>

    <section class="card">
      <div class="card-head">
        <h2>待办</h2>
        <span class="hint">未完成 ${todos.filter((t) => !t.done).length} 条</span>
      </div>
      <form class="add-form" id="add-todo" autocomplete="off">
        <input name="text" class="grow" maxlength="200" required placeholder="这个项目要做什么…">
        <input name="note" class="grow-note" maxlength="200" placeholder="备注（可不填）">
        <button class="btn primary" type="submit">添加</button>
      </form>
      ${todos.length ? `<ul class="tasks">${todos.map(todoRow).join("")}</ul>` : emptyLine("还没有待办。")}
    </section>

    <section class="card">
      <div class="card-head">
        <h2>问题 / bug</h2>
        <span class="hint">未解决 ${openIssues} 条</span>
      </div>
      <form class="add-form" id="add-issue" autocomplete="off">
        <input name="title" class="grow" maxlength="120" required placeholder="问题是什么…">
        <select name="severity" title="严重程度">${options(SEVERITY, "中")}</select>
        <select name="status" title="状态">${options(ISSUE_STATUS)}</select>
        <button class="btn primary" type="submit">添加</button>
      </form>
      ${issues.length ? `<ul class="items">${issues.map(issueRow).join("")}</ul>` : emptyLine("还没有记录问题。")}
    </section>

    <section class="card">
      <div class="card-head">
        <h2>最近进展</h2>
        <span class="hint">按日期从新到旧</span>
      </div>
      <form class="add-form" id="add-progress" autocomplete="off">
        <input name="date" type="date" value="${todayStr()}">
        <input name="text" class="grow" maxlength="200" required placeholder="今天推进了什么…">
        <button class="btn primary" type="submit">记一笔</button>
      </form>
      ${
        progress.length
          ? `<ul class="timeline">${progress.map(progRow).join("")}</ul>`
          : emptyLine("还没有进展记录。")
      }
    </section>

    ${
      editProject
        ? ""
        : `<p class="hint">项目待办不会出现在「今日计划」里，它们只属于这个项目。</p>`
    }
  `;
}

function todoRow(t) {
  if (editing && editing.kind === "todo" && editing.id === t.id) {
    return `
      <li class="task editing" data-id="${esc(t.id)}">
        <input data-field="text" class="grow" maxlength="200" value="${esc(t.text)}">
        <input data-field="note" class="grow-note" maxlength="200" placeholder="备注" value="${esc(t.note || "")}">
        <button class="btn primary small" data-act="todo-save">保存</button>
        <button class="btn small" data-act="todo-cancel">取消</button>
      </li>`;
  }
  return `
    <li class="task${t.done ? " done" : ""}" data-id="${esc(t.id)}">
      <label class="check" title="${t.done ? "取消完成" : "标记完成"}">
        <input type="checkbox" data-act="todo-toggle" ${t.done ? "checked" : ""}>
      </label>
      <span class="t-text">${esc(t.text)}</span>
      <span class="t-note">${esc(t.note || "")}</span>
      <span class="t-actions">
        <button class="link" data-act="todo-edit">编辑</button>
        <button class="link danger" data-act="todo-del">删除</button>
      </span>
    </li>`;
}

function issueRow(i) {
  if (editing && editing.kind === "issue" && editing.id === i.id) {
    return `
      <li class="item editing" data-id="${esc(i.id)}">
        <input data-field="title" class="grow" maxlength="120" value="${esc(i.title)}">
        <select data-field="severity">${options(SEVERITY, i.severity)}</select>
        <select data-field="status">${options(ISSUE_STATUS, i.status)}</select>
        <button class="btn primary small" data-act="issue-save">保存</button>
        <button class="btn small" data-act="issue-cancel">取消</button>
      </li>`;
  }
  const closed = CLOSED.includes(i.status);
  return `
    <li class="item${closed ? " done" : ""}" data-id="${esc(i.id)}">
      ${chip(i.severity)}
      <span class="i-title">${esc(i.title)}</span>
      ${chip(i.status)}
      <span class="i-actions">
        ${closed ? "" : `<button class="link" data-act="issue-done">标记已解决</button>`}
        <button class="link" data-act="issue-edit">编辑</button>
        <button class="link danger" data-act="issue-del">删除</button>
      </span>
    </li>`;
}

function progRow(p) {
  return `
    <li data-id="${esc(p.id)}">
      <span class="tl-date">${esc(p.date || "")}</span>
      <span class="tl-text">${esc(p.text)}</span>
      <button class="link danger" data-act="prog-del">删除</button>
    </li>`;
}

/* ---------------- 事件 ---------------- */

function currentProjectId() {
  return location.hash.split("/")[1] || "";
}

function findTodo(id) {
  return table("tasks").find((t) => t.id === id) || null;
}

function findIssue(id) {
  return table("issues").find((i) => i.id === id) || null;
}

function onSubmit(e) {
  const form = e.target;
  const pid = currentProjectId();
  if (form.id === "add-project") {
    e.preventDefault();
    const name = form.name.value.trim();
    if (!name) return;
    table("projects").push({
      id: uid(),
      name,
      status: form.status.value,
      intro: form.intro.value.trim(),
      startDate: form.startDate.value || "",
    });
    touch(true);
  } else if (form.id === "edit-project") {
    e.preventDefault();
    const p = table("projects").find((x) => x.id === pid);
    if (!p) return;
    const name = form.name.value.trim();
    if (!name) return;
    p.name = name;
    p.status = form.status.value;
    p.intro = form.intro.value.trim();
    p.startDate = form.startDate.value || "";
    editProject = false;
    touch(true);
  } else if (form.id === "add-todo") {
    e.preventDefault();
    const text = form.text.value.trim();
    if (!text) return;
    table("tasks").push({
      id: uid(),
      date: "",
      text,
      time: "",
      category: "工作",
      done: false,
      note: form.note.value.trim(),
      belong: "dev:" + pid,
      createdAt: new Date().toISOString(),
    });
    touch(true);
  } else if (form.id === "add-issue") {
    e.preventDefault();
    const title = form.title.value.trim();
    if (!title) return;
    table("issues").push({
      id: uid(),
      projectId: pid,
      title,
      severity: form.severity.value,
      status: form.status.value,
    });
    touch(true);
  } else if (form.id === "add-progress") {
    e.preventDefault();
    const text = form.text.value.trim();
    if (!text) return;
    table("progress").push({
      id: uid(),
      projectId: pid,
      date: form.date.value || todayStr(),
      text,
    });
    touch(true);
  }
}

async function onClick(e) {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === "todo-toggle") return; // 走 change
  const li = btn.closest("[data-id]");
  const id = li ? li.dataset.id : "";
  const pid = currentProjectId();

  if (act === "p-edit") {
    editProject = true;
    redraw();
  } else if (act === "p-cancel") {
    editProject = false;
    redraw();
  } else if (act === "p-delete") {
    const p = table("projects").find((x) => x.id === pid);
    if (!p) return;
    const ok = await askConfirm({
      title: `删除项目「${p.name}」？`,
      message: "它的待办、问题和进展也一起进回收站。",
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    moveToTrash("projects", p, p.name);
    for (const t of table("tasks").filter((x) => x.belong === "dev:" + pid)) {
      moveToTrash("tasks", t, t.text);
    }
    for (const i of issueList(pid)) moveToTrash("issues", i, i.title);
    for (const g of progressList(pid)) moveToTrash("progress", g, g.text);
    location.hash = "#dev";
    touch(true);
    toast("项目已移入回收站");
  } else if (act === "todo-edit") {
    editing = { kind: "todo", id };
    redraw();
  } else if (act === "todo-cancel") {
    editing = null;
    redraw();
  } else if (act === "todo-save") {
    const t = findTodo(id);
    if (!t) return;
    const text = li.querySelector('[data-field="text"]').value.trim();
    if (!text) {
      toast("内容不能是空的", "err");
      return;
    }
    t.text = text;
    t.note = li.querySelector('[data-field="note"]').value.trim();
    editing = null;
    touch(true);
  } else if (act === "todo-del") {
    const t = findTodo(id);
    if (!t) return;
    const ok = await askConfirm({
      title: `删除待办「${t.text}」？`,
      message: "会放进回收站。",
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    moveToTrash("tasks", t, t.text);
    touch(true);
    toast("已移入回收站");
  } else if (act === "issue-edit") {
    editing = { kind: "issue", id };
    redraw();
  } else if (act === "issue-cancel") {
    editing = null;
    redraw();
  } else if (act === "issue-save") {
    const i = findIssue(id);
    if (!i) return;
    const title = li.querySelector('[data-field="title"]').value.trim();
    if (!title) {
      toast("问题标题不能是空的", "err");
      return;
    }
    i.title = title;
    i.severity = li.querySelector('[data-field="severity"]').value;
    i.status = li.querySelector('[data-field="status"]').value;
    editing = null;
    touch(true);
  } else if (act === "issue-done") {
    const i = findIssue(id);
    if (!i) return;
    i.status = "已解决";
    touch(true);
  } else if (act === "issue-del") {
    const i = findIssue(id);
    if (!i) return;
    const ok = await askConfirm({
      title: `删除问题「${i.title}」？`,
      message: "会放进回收站。",
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    moveToTrash("issues", i, i.title);
    touch(true);
    toast("已移入回收站");
  } else if (act === "prog-del") {
    const row = table("progress").find((x) => x.id === id);
    if (!row) return;
    const ok = await askConfirm({
      title: "删除这条进展记录？",
      message: "会放进回收站。",
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    moveToTrash("progress", row, row.text);
    touch(true);
    toast("已移入回收站");
  }
}

function onChange(e) {
  const box = e.target.closest('[data-act="todo-toggle"]');
  if (!box) return;
  const li = box.closest("[data-id]");
  const t = li ? findTodo(li.dataset.id) : null;
  if (!t) return;
  t.done = box.checked;
  t.doneAt = box.checked ? new Date().toISOString() : null;
  touch();
}
