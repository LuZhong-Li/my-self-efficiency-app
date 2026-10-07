/* 开发工作：项目列表 → 点进项目看待办 / 问题 / 进展 */

import { touch, uid, table, esc, todayStr, nowText, moveToTrash } from "./store.js";
import { emptyLine, emptyState, chip, options, bindFresh, pageHeader } from "./ui.js";
import { askConfirm, toast, openDialog } from "./dialog.js";
import { icon } from "./icons.js";
import {
  createAttach, mountAttach, disposeAttach, uploadPending, commitUploads,
  purgeRowAttachments, thumbsHtml, rowPaths, imgBadge,
} from "./attachment.js";
import { openItemDialog } from "./item-dialog.js";
import {
  SEVERITY, ISSUE_STATUS, ISSUE_MODULES, DEFAULT_ISSUE_MODULE,
  normalizeIssue, normalizeProgress, isIssueClosed, issueStats, matchIssue,
  cycleDays, progressSorted,
} from "./dev-calc.js";

const PROJECT_STATUS = ["进行中", "已完成"];

let editProject = false;
let sorter = null;  // 项目卡片的拖拽实例（每次重画都要重建）
let hostRoot = null;
let editSnapshot = null; // 进编辑时拍的快照，点「取消」用它真正回滚

// 筛选状态：只影响显示，不动数据
let filterText = "";
let filterStatus = "all";
let issueFilter = { status: "all", severity: "all", module: "all" };
// 展开了哪一条（点条目本身展开详情，图片在详情里看）
let openIssueId = "";
let openProgressId = "";

export function renderDev(root, sub) {
  hostRoot = root;
  const project = table("projects").find((p) => p.id === sub);
  if (sub && project) renderDetail(root, project);
  else renderList(root);

  bindFresh(root, { submit: onSubmit, click: onClick, change: onChange, input: onInput });
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
    animation: 180,          // 其余卡片平滑让位的时长
    ghostClass: "card-ghost",   // 原位留下的占位（透明，只留一条缝）
    chosenClass: "card-chosen", // 被按住的那张
    dragClass: "card-follow",       // 跟着光标走的那张
    fallbackClass: "card-follow",   // forceFallback 模式下跟手的是克隆
    // 关键：桌面浏览器默认用 HTML5 原生拖拽，跟手的是浏览器自己截的图（天生半透明），
    // 样式管不了。forceFallback 让 Sortable 用自己的克隆来跟手，才能做到"手里这张不虚化"。
    forceFallback: true,
    fallbackOnBody: true,    // 克隆挂在 body 上，不会被卡片容器裁掉
    fallbackTolerance: 4,
    filter: "input, textarea, select", // 卡片里要是将来放了输入框，从输入框上按住不触发拖拽
    distance: 5,             // 手抖 5 像素算点击（卡片本身是个链接，别把点击吃掉）
    onEnd() {
      // 拖完把 DOM 顺序读回来，重排 projects 数组，整份落盘
      const ids = [...grid.querySelectorAll("[data-id]")].map((el) => el.dataset.id);
      const all = table("projects");
      const byId = new Map(all.map((p) => [p.id, p]));
      const visible = ids.map((id) => byId.get(id)).filter(Boolean);
      const visibleIds = new Set(visible.map((p) => p.id));
      // 按位置合并：看得见的按新顺序填回去，被筛掉的留在原位不动
      const merged = [];
      let i = 0;
      for (const p of all) {
        if (visibleIds.has(p.id)) merged.push(visible[i++]);
        else merged.push(p);
      }
      for (const p of all) if (!merged.includes(p)) merged.push(p); // 兜底：一条都不能丢
      all.length = 0;
      all.push(...merged);
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
  return progressSorted(table("progress").filter((p) => p.projectId === projectId));
}

/* ---------------- 项目列表 ---------------- */

function renderList(root) {
  const all = table("projects");
  const list = visibleProjects();
  const filtering = Boolean(filterText.trim()) || filterStatus !== "all";
  root.innerHTML = `
    ${pageHeader("dev", `<span class="date-chip">${all.length} 个项目</span>`)}
    <section class="card">
      <form class="add-form" id="add-project" autocomplete="off">
        <input name="name" class="grow" maxlength="80" required placeholder="项目名…">
        <select name="status" title="状态">${options(PROJECT_STATUS)}</select>
        <input name="intro" class="grow-note" maxlength="120" placeholder="一句话简介">
        <input name="startDate" type="date" title="开始日期">
        <button class="btn primary" type="submit">添加项目</button>
      </form>

      ${
        all.length
          ? `<div class="filter-bar">
               <input id="project-filter" class="grow" maxlength="60" autocomplete="off"
                      placeholder="筛选项目名 / 简介…" value="${esc(filterText)}">
               <select id="project-status-filter" title="按状态筛选">
                 <option value="all"${filterStatus === "all" ? " selected" : ""}>全部状态</option>
                 ${PROJECT_STATUS.map(
                   (s) => `<option value="${esc(s)}"${filterStatus === s ? " selected" : ""}>${esc(s)}</option>`
                 ).join("")}
               </select>
               <button class="btn small" data-act="filter-clear">清空筛选</button>
               <span class="hint" id="filter-count">${filtering ? `筛出 ${list.length} / ${all.length} 个` : ""}</span>
             </div>`
          : ""
      }

      <div id="proj-grid-host">${gridHtml()}</div>
    </section>
  `;
}

/** 按关键词 + 状态筛出要显示的项目（只读，不动数据） */
function visibleProjects() {
  const kw = filterText.trim().toLowerCase();
  return table("projects").filter((p) => {
    if (filterStatus !== "all" && p.status !== filterStatus) return false;
    if (!kw) return true;
    return [p.name, p.intro, p.status].some((v) => String(v || "").toLowerCase().includes(kw));
  });
}

function gridHtml() {
  const all = table("projects");
  if (!all.length) return emptyState("还没有项目", "每个项目一条线：待办、问题、进展。", "", "dev");
  const list = visibleProjects();
  if (!list.length) return emptyState("没有匹配的项目", "换个关键词，或者点「清空筛选」。", "", "dev");
  return `<div class="proj-grid">${list.map(projCard).join("")}</div>`;
}

/** 只重画卡片区，不动上面的输入框——否则边打字边重画会把光标弄丢 */
function applyFilter() {
  if (!hostRoot) return;
  const host = hostRoot.querySelector("#proj-grid-host");
  if (!host) return;
  host.innerHTML = gridHtml();
  const count = hostRoot.querySelector("#filter-count");
  if (count) {
    const filtering = Boolean(filterText.trim()) || filterStatus !== "all";
    count.textContent = filtering ? `筛出 ${visibleProjects().length} / ${table("projects").length} 个` : "";
  }
  setupDragSort(hostRoot);
}

function projCard(p) {
  const openTodos = todoList(p.id).filter((t) => !t.done).length;
  const bugs = issueList(p.id).filter((i) => !isIssueClosed(i.status)).length;
  return `
    <!-- draggable="false" 很关键：这是个链接，浏览器默认允许原生拖拽，
         一旦原生拖拽被触发，页面就收不到 mousemove，Sortable 的 forceFallback 会卡住不跟手。 -->
    <a class="proj-card" data-id="${esc(p.id)}" draggable="false" href="#dev/${esc(p.id)}">
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
  const progress = progressList(p.id);
  const st = issueStats(issues);

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
        <div class="card-tools">
          <span class="hint">未完成 ${todos.filter((t) => !t.done).length} 条</span>
          <button class="btn primary small" data-act="todo-add">${icon("plus", 14)}添加待办</button>
        </div>
      </div>
      ${
        todos.length
          ? `<ul class="tasks">${todos.map(todoRow).join("")}</ul>`
          : emptyLine("还没有待办，点右上角「添加待办」加一条。")
      }
    </section>

    <section class="card">
      <div class="card-head">
        <h2>问题 / bug</h2>
        <div class="card-tools">
          <span class="dev-stats" title="未解决 = 待处理 + 进行中 + 已复现">
            <i>未解决 ${st.open}</i>
            <i>进行中 ${st.doing}</i>
            <i>已修复 ${st.fixed}</i>
          </span>
          <button class="btn primary small" data-act="issue-add">${icon("plus", 14)}记一个问题</button>
        </div>
      </div>
      ${issues.length ? issueFilterBar() : ""}
      <div id="issue-list-host">${issueListHtml(issues)}</div>
    </section>

    <section class="card">
      <div class="card-head">
        <h2>最近进展</h2>
        <div class="card-tools">
          <span class="hint">按日期从新到旧</span>
          <button class="btn primary small" data-act="prog-add">${icon("plus", 14)}记一笔进展</button>
        </div>
      </div>
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
  return `
    <li class="task${t.done ? " done" : ""}" data-id="${esc(t.id)}">
      <label class="check" title="${t.done ? "取消完成" : "标记完成"}">
        <input type="checkbox" data-act="todo-toggle" ${t.done ? "checked" : ""}>
      </label>
      <span class="t-text">${esc(t.text)}</span>
      ${t.priority ? `<span class="chip">${esc(t.priority)}</span>` : ""}
      ${imgBadge(t.imagePaths, "图")}
      <span class="t-note">${esc(t.note || "")}</span>
      <span class="t-actions">
        <button class="link" data-act="todo-edit">编辑</button>
        <button class="link danger" data-act="todo-del">删除</button>
      </span>
    </li>`;
}

/** 问题 / bug 的筛选条：状态 / 优先级 / 关联模块。只影响显示，不动数据。 */
function issueFilterBar() {
  const sel = (id, list, current, allLabel) => `
    <select id="${id}" title="${esc(allLabel)}">
      <option value="all"${current === "all" ? " selected" : ""}>${esc(allLabel)}</option>
      ${list
        .map((v) => `<option value="${esc(v)}"${current === v ? " selected" : ""}>${esc(v)}</option>`)
        .join("")}
    </select>`;
  return `
    <div class="filter-bar">
      ${sel("issue-filter-status", ISSUE_STATUS, issueFilter.status, "全部状态")}
      ${sel("issue-filter-severity", SEVERITY, issueFilter.severity, "全部优先级")}
      ${sel("issue-filter-module", ISSUE_MODULES, issueFilter.module, "全部模块")}
      <button class="btn small" data-act="issue-filter-clear">清空筛选</button>
    </div>`;
}

function issueListHtml(issues) {
  if (!issues.length) return emptyLine("还没有记录问题。");
  const shown = issues.filter((i) => matchIssue(i, issueFilter));
  if (!shown.length) {
    return emptyState("没有符合筛选的问题", "换个条件，或者点「清空筛选」。", "", "bug");
  }
  return `<ul class="items">${shown.map(issueRow).join("")}</ul>`;
}

function issueRow(i) {
  const it = normalizeIssue(i);
  const closed = isIssueClosed(it.status);
  const open = openIssueId === it.id;
  return `
    <li class="item issue-row${closed ? " done" : ""}${open ? " open" : ""}"
        data-id="${esc(it.id)}" data-expand="issue" title="${open ? "收起详情" : "点开看详细描述和截图"}">
      ${chip(it.severity)}
      <span class="issue-main">
        <span class="i-title">${esc(it.title)}</span>
      </span>
      ${imgBadge(it.imagePaths, "截图")}
      ${chip(it.status)}
      <span class="i-actions">
        ${closed ? "" : `<button class="link" data-act="issue-done">标记已修复</button>`}
        <button class="link" data-act="issue-edit">编辑</button>
        <button class="link danger" data-act="issue-del">删除</button>
      </span>
    </li>
    ${open ? issueDetail(i) : ""}`;
}

/** 展开后的详情：完整描述 + 几个时间字段 + 截图 */
function issueDetail(i) {
  const it = normalizeIssue(i);
  const days = cycleDays(i);
  return `
    <li class="item issue-detail" data-id="${esc(it.id)}">
      ${
        it.desc
          ? `<p class="issue-desc">${esc(it.desc)}</p>`
          : `<p class="issue-desc empty">（还没写详细描述，点「编辑」把复现步骤补上）</p>`
      }
      <dl class="facts issue-facts">
        <dt>关联模块</dt><dd>${esc(it.module)}</dd>
        <dt>记录于</dt><dd>${esc(it.createdAt || "—")}</dd>
        <dt>修复于</dt><dd>${esc(it.fixedAt || "—")}</dd>
        ${days === null ? "" : `<dt>迭代周期</dt><dd>${days} 天</dd>`}
      </dl>
      ${thumbsHtml(it.imagePaths)}
    </li>`;
}

function progRow(p) {
  const item = normalizeProgress(p);
  const open = openProgressId === item.id;
  const hasImg = item.imagePaths.length > 0;
  // 没有图就没有可展开的东西，点一下别装作能展开
  return `
    <li class="${open ? "open" : ""}${hasImg ? " tl-toggle" : ""}" data-id="${esc(item.id)}"
        ${hasImg ? `data-expand="progress" title="${open ? "收起图片" : "点开看图片"}"` : ""}>
      <span class="tl-date">${esc(item.date || "")}</span>
      <span class="tl-text">${esc(item.text)}</span>
      ${imgBadge(item.imagePaths, "图")}
      <span class="i-actions">
        <button class="link" data-act="prog-edit">编辑</button>
        <button class="link danger" data-act="prog-del">删除</button>
      </span>
    </li>
    ${open && hasImg ? `<li class="tl-detail" data-id="${esc(item.id)}">${thumbsHtml(item.imagePaths)}</li>` : ""}`;
}

/* ---------------- 事件 ---------------- */

function currentProjectId() {
  return location.hash.split("/")[1] || "";
}

/** 点「取消」时把记录退回进编辑前的样子（因为编辑期间是自动保存的） */
function restoreSnapshot() {
  if (!editSnapshot || !editSnapshot.id) return;
  const row = table("projects").find((x) => x.id === editSnapshot.id);
  if (row) {
    Object.assign(row, editSnapshot);
  }
}

/**
 * 输入框边打边存。
 * - 筛选框：只重画卡片区，不动输入框（否则光标会跳）
 * - 行内编辑：静默保存（touch(false, true) 只写数据不重画），
 *   所以关窗口、断电都不会丢；想反悔就点「取消」，那里有快照可以退回。
 */
function onInput(e) {
  const el = e.target;

  if (el.id === "project-filter") {
    filterText = el.value;
    applyFilter();
    return;
  }

  const form = el.closest("#edit-project");
  if (form) {
    const p = table("projects").find((x) => x.id === currentProjectId());
    if (!p) return;
    const name = form.querySelector('[name="name"]').value.trim();
    if (!name) return; // 名字不能是空的，这一次先不存
    p.name = name;
    p.status = form.querySelector('[name="status"]').value;
    p.intro = form.querySelector('[name="intro"]').value.trim();
    p.startDate = form.querySelector('[name="startDate"]').value || "";
    touch(false, true);
    return;
  }

  // 现在只剩「编辑项目」还是边打字边静默保存（待办、问题、进展都走弹窗了，
  // 弹窗里是「点保存才写」，不会边打字边落盘）
}

function findTodo(id) {
  return table("tasks").find((t) => t.id === id) || null;
}

function findIssue(id) {
  return table("issues").find((i) => i.id === id) || null;
}

/* ---------------- 弹窗：问题 / bug ----------------
 * 和「记一笔」一个规矩：Esc 关、点遮罩关、回车保存、Tab 在弹窗里绕圈；
 * 图片点「保存」才写进 数据\attachments\buglog\，点「取消」一个字节都不留。
 */

function issueFormHtml(v) {
  return `
    <label class="dlg-label" for="issue-title">问题是什么</label>
    <input id="issue-title" type="text" maxlength="120" autocomplete="off"
           placeholder="一句话说清是什么问题" value="${esc(v.title)}">
    <div class="dlg-two">
      <div>
        <label class="dlg-label" for="issue-severity">优先级</label>
        <select id="issue-severity">${options(SEVERITY, v.severity)}</select>
      </div>
      <div>
        <label class="dlg-label" for="issue-status">状态</label>
        <select id="issue-status">${options(ISSUE_STATUS, v.status)}</select>
      </div>
    </div>
    <label class="dlg-label" for="issue-module">关联模块</label>
    <select id="issue-module">${options(ISSUE_MODULES, v.module)}</select>
    <label class="dlg-label" for="issue-desc">详细描述</label>
    <textarea id="issue-desc" rows="5" maxlength="2000"
      placeholder="复现步骤 / 预期行为 / 实际现象（可留空）">${esc(v.desc)}</textarea>
    <div class="attach-host" id="issue-attach"></div>`;
}

/** 打开「记一个问题 / 改一个问题」。传 issue 就是改，不传就是新增。 */
function openIssueDialog(issue) {
  const editing = Boolean(issue);
  const v = editing
    ? normalizeIssue(issue)
    : { title: "", desc: "", severity: "中", status: "待处理", module: DEFAULT_ISSUE_MODULE };
  const attach = createAttach({ module: "buglog", paths: v.imagePaths });
  const dlg = openDialog({
    title: editing ? "改一个问题" : "记一个问题",
    bodyHtml: issueFormHtml(v),
    buttons: [
      ...(editing ? [{ id: "delete", label: "删除", kind: "danger" }] : []),
      { id: "cancel", label: "取消" },
      { id: "save", label: "保存", kind: "primary" },
    ],
    onClose: () => disposeAttach(attach),
    onAction: (act, el) => {
      if (act === "cancel") return true;
      if (act === "delete") {
        (async () => {
          const ok = await askConfirm({
            title: `删除问题「${issue.title}」？`,
            message: "会放进回收站，误删可以去「数据与设置」找回。",
            confirmLabel: "删除",
            danger: true,
          });
          if (!ok) return;
          moveToTrash("issues", issue, issue.title);
          if (openIssueId === issue.id) openIssueId = "";
          touch(true);
          dlg.close();
          toast("已移入回收站");
        })();
        return false;   // 确认框接管了这里，别把弹窗先关了
      }
      if (act !== "save") return;
      // 保存分两步（先写图片、再动 JSON），异步的，所以先留住弹窗做完再关
      (async () => {
        const next = {
          title: el.querySelector("#issue-title").value.trim(),
          desc: el.querySelector("#issue-desc").value.trim(),
          severity: el.querySelector("#issue-severity").value,
          status: el.querySelector("#issue-status").value,
          module: el.querySelector("#issue-module").value,
        };
        if (!next.title) {
          toast("标题不能是空的", "err");
          return;
        }
        let uploaded = [];
        try {
          uploaded = await uploadPending(attach);
        } catch (err) {
          toast("图片没存下：" + err.message, "err");
          return;
        }
        commitUploads(attach, uploaded);
        const imagePaths = attach.paths.slice();
        if (editing) {
          const before = rowPaths(issue);
          Object.assign(issue, next, { imagePaths });
          // 修复时间自动记：修好了写上（已经是修复态就不覆盖），退回去就清掉
          issue.fixedAt = next.status === "已修复" ? (issue.fixedAt || nowText()) : "";
          touch(true);
          dlg.close();
          toast("已保存");
          const removed = before.filter((p) => !imagePaths.includes(p));
          if (removed.length) purgeRowAttachments({ imagePaths: removed });
        } else {
          table("issues").push({
            id: uid(),
            projectId: currentProjectId(),
            ...next,
            imagePaths,
            createdAt: nowText(),
            fixedAt: next.status === "已修复" ? nowText() : "",
          });
          touch(true);
          dlg.close();
          toast(uploaded.length ? `已记一个问题（带 ${uploaded.length} 张图）` : "已记一个问题");
        }
      })();
      return false;
    },
  });

  mountAttach(dlg.el.querySelector("#issue-attach"), attach);
  bindDialogEnter(dlg, "#issue-title");
  return dlg;
}

/* ---------------- 弹窗：最近进展 ---------------- */

function progressFormHtml(v) {
  return `
    <label class="dlg-label" for="prog-date">日期</label>
    <input id="prog-date" type="date" value="${esc(v.date)}">
    <label class="dlg-label" for="prog-text">今天推进了什么</label>
    <textarea id="prog-text" rows="5" maxlength="1000"
      placeholder="比如：首页改版做完，顺手把月历的圆点换成低饱和那套">${esc(v.text)}</textarea>
    <div class="attach-host" id="prog-attach"></div>`;
}

/** 打开「记一笔进展 / 改一笔进展」 */
function openProgressDialog(row) {
  const editing = Boolean(row);
  const v = editing
    ? normalizeProgress(row)
    : { date: todayStr(), text: "", imagePaths: [] };
  const attach = createAttach({ module: "progress", paths: v.imagePaths });
  const dlg = openDialog({
    title: editing ? "改一笔进展" : "记一笔进展",
    bodyHtml: progressFormHtml(v),
    buttons: [
      ...(editing ? [{ id: "delete", label: "删除", kind: "danger" }] : []),
      { id: "cancel", label: "取消" },
      { id: "save", label: "保存", kind: "primary" },
    ],
    onClose: () => disposeAttach(attach),
    onAction: (act, el) => {
      if (act === "cancel") return true;
      if (act === "delete") {
        (async () => {
          const ok = await askConfirm({
            title: "删除这条进展记录？",
            message: "会放进回收站，误删可以去「数据与设置」找回。",
            confirmLabel: "删除",
            danger: true,
          });
          if (!ok) return;
          moveToTrash("progress", row, row.text);
          if (openProgressId === row.id) openProgressId = "";
          touch(true);
          dlg.close();
          toast("已移入回收站");
        })();
        return false;
      }
      if (act !== "save") return;
      (async () => {
        const next = {
          date: el.querySelector("#prog-date").value || todayStr(),
          text: el.querySelector("#prog-text").value.trim(),
        };
        if (!next.text) {
          toast("内容不能是空的", "err");
          return;
        }
        let uploaded = [];
        try {
          uploaded = await uploadPending(attach);
        } catch (err) {
          toast("图片没存下：" + err.message, "err");
          return;
        }
        commitUploads(attach, uploaded);
        const imagePaths = attach.paths.slice();
        if (editing) {
          const before = rowPaths(row);
          Object.assign(row, next, { imagePaths });
          touch(true);
          dlg.close();
          toast("已保存");
          const removed = before.filter((p) => !imagePaths.includes(p));
          if (removed.length) purgeRowAttachments({ imagePaths: removed });
        } else {
          table("progress").push({
            id: uid(), projectId: currentProjectId(), ...next, imagePaths,
          });
          touch(true);
          dlg.close();
          toast(uploaded.length ? `已记一笔进展（带 ${uploaded.length} 张图）` : "已记一笔进展");
        }
      })();
      return false;
    },
  });

  mountAttach(dlg.el.querySelector("#prog-attach"), attach);
  bindDialogEnter(dlg, "#prog-date");
  return dlg;
}

/** 回车 = 保存。只在输入框 / 下拉里按回车才算（在描述框里回车要能换行）。 */
function bindDialogEnter(dlg, focusSel) {
  dlg.el.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const tag = e.target.tagName;
    if (tag !== "INPUT" && tag !== "SELECT") return;
    e.preventDefault();
    dlg.el.querySelector('[data-dlg-act="save"]')?.click();
  });
  if (focusSel) {
    const el = dlg.el.querySelector(focusSel);
    if (el) setTimeout(() => el.focus(), 0);
  }
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
  }
}

async function onClick(e) {
  const btn = e.target.closest("[data-act]");
  if (!btn) {
    // 点条目本身 = 展开 / 收起详情（详情里看完整描述和截图）
    const row = e.target.closest("[data-expand]");
    if (!row) return;
    const id = row.dataset.id;
    if (row.dataset.expand === "issue") openIssueId = openIssueId === id ? "" : id;
    else openProgressId = openProgressId === id ? "" : id;
    redraw();
    return;
  }
  const act = btn.dataset.act;
  if (act === "todo-toggle") return; // 走 change
  const li = btn.closest("[data-id]");
  const id = li ? li.dataset.id : "";
  const pid = currentProjectId();

  if (act === "p-edit") {
    editSnapshot = JSON.parse(JSON.stringify(table("projects").find((x) => x.id === pid) || {}));
    editProject = true;
    redraw();
  } else if (act === "p-cancel") {
    restoreSnapshot();
    editProject = false;
    touch(true); // 退回也要落盘，否则界面回去了、磁盘还留着改后的值
  } else if (act === "filter-clear") {
    filterText = "";
    filterStatus = "all";
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
    const t = findTodo(id);
    if (t) openItemDialog("devTodo", t, { pid });
  } else if (act === "todo-add") {
    openItemDialog("devTodo", null, { pid });
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
  } else if (act === "issue-add") {
    openIssueDialog(null);
  } else if (act === "issue-edit") {
    const i = findIssue(id);
    if (i) openIssueDialog(i);
  } else if (act === "issue-done") {
    const i = findIssue(id);
    if (!i) return;
    i.status = "已修复";        // 「已解决」2026-10-07 改了名，顺手把修复时间记上
    i.fixedAt = nowText();
    touch(true);
    toast("已标记修复");
  } else if (act === "issue-filter-clear") {
    issueFilter = { status: "all", severity: "all", module: "all" };
    redraw();
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
    if (openIssueId === id) openIssueId = "";
    touch(true);
    toast("已移入回收站");
  } else if (act === "prog-add") {
    openProgressDialog(null);
  } else if (act === "prog-edit") {
    const row = table("progress").find((x) => x.id === id);
    if (row) openProgressDialog(row);
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
    if (openProgressId === id) openProgressId = "";
    touch(true);
    toast("已移入回收站");
  }
}

function onChange(e) {
  if (e.target.id === "project-status-filter") {
    filterStatus = e.target.value;
    applyFilter();
    return;
  }
  // 问题 / bug 的三个筛选：只影响显示，筛完停在这一页
  if (e.target.id === "issue-filter-status") {
    issueFilter.status = e.target.value;
    redraw();
    return;
  }
  if (e.target.id === "issue-filter-severity") {
    issueFilter.severity = e.target.value;
    redraw();
    return;
  }
  if (e.target.id === "issue-filter-module") {
    issueFilter.module = e.target.value;
    redraw();
    return;
  }
  const box = e.target.closest('[data-act="todo-toggle"]');
  if (!box) return;
  const li = box.closest("[data-id]");
  const t = li ? findTodo(li.dataset.id) : null;
  if (!t) return;
  t.done = box.checked;
  t.doneAt = box.checked ? new Date().toISOString() : null;
  touch();
}
