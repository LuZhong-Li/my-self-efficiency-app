/* 开发工作：项目列表 → 点进项目看待办 / 问题 / 进展 */

import {
  touch, uid, table, esc, todayStr, nowText, moveToTrash,
  autoArchiveTodoOf, autoArchiveIssueOf,
} from "./store.js";
import { emptyLine, emptyState, chip, options, bindFresh, pageHeader } from "./ui.js";
import { askConfirm, toast, openDialog } from "./dialog.js";
import { icon } from "./icons.js";
import {
  createAttach, mountAttach, disposeAttach, uploadPending, commitUploads,
  purgeRowAttachments, thumbsHtml, rowPaths, imgBadge, openPathViewer,
} from "./attachment.js";
import { openItemDialog, trashItem } from "./item-dialog.js";
import { PROJECT_STATUSES } from "./item-form.js";
import {
  SEVERITY, ISSUE_STATUS, ISSUE_MODULES, DEFAULT_ISSUE_MODULE,
  normalizeIssue, normalizeProgress, normalizeTodo,
  isIssueClosed, issueStats, matchIssue, archivedOf, splitByArchive,
  cycleDays, progressSorted,
} from "./dev-calc.js";

let sorter = null;  // 项目卡片的拖拽实例（每次重画都要重建）
let hostRoot = null;

// 筛选状态：只影响显示，不动数据
let filterText = "";
let filterStatus = "all";
let issueFilter = { status: "all", severity: "all", module: "all" };
// 待办主列表的活跃档位（全部 / 未完成 / 已完成）—— 只管没归档的那些
let todoState = "all";
// 展开了哪一条（点条目本身展开详情，图片在详情里看）
let openIssueId = "";
let openProgressId = "";

/* 归档侧边抽屉：待办归档 / Bug 归档两类共用一个抽屉。
 * 只活在这一次会话里（刷新页面回到关闭状态）；picked 是勾选待批量的那些 id。 */
const archive = {
  open: false,
  tab: "todo",       // "todo" | "issue"
  kw: "",
  severity: "all",
  from: "",
  to: "",
  picked: new Set(),
};

/** 待办主列表的活跃档位下拉 */
function todoStateOptions(current) {
  return [["all", "全部"], ["open", "未完成"], ["done", "已完成"]]
    .map(([v, text]) => `<option value="${v}"${v === current ? " selected" : ""}>${text}</option>`)
    .join("");
}

export function renderDev(root, sub) {
  hostRoot = root;
  const project = table("projects").find((p) => p.id === sub);
  if (sub && project) renderDetail(root, project);
  else {
    archive.open = false;   // 抽屉只属于项目详情页，回列表就收起来
    renderList(root);
  }

  bindFresh(root, { click: onClick, change: onChange, input: onInput });
  setupDragSort(root);
  bindArchiveEsc();
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
      <div class="card-head">
        <h2>项目</h2>
        <div class="card-tools">
          <button class="btn primary small" data-act="p-add">${icon("plus", 14)}添加项目</button>
        </div>
      </div>

      ${
        all.length
          ? `<div class="filter-bar">
               <input id="project-filter" class="grow" maxlength="60" autocomplete="off"
                      placeholder="筛选项目名 / 简介…" value="${esc(filterText)}">
               <select id="project-status-filter" title="按状态筛选">
                 <option value="all"${filterStatus === "all" ? " selected" : ""}>全部状态</option>
                 ${PROJECT_STATUSES.map(
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
  // 卡片上这两个数也不含归档的（归档的不占主列表，也就不该占这里的数）
  const openTodos = todoList(p.id).filter((t) => !t.done && !archivedOf(t)).length;
  const bugs = issueList(p.id).filter((i) => !isIssueClosed(i.status) && !archivedOf(i)).length;
  const paths = rowPaths(p);
  return `
    <!-- draggable="false" 很关键：这是个链接，浏览器默认允许原生拖拽，
         一旦原生拖拽被触发，页面就收不到 mousemove，Sortable 的 forceFallback 会卡住不跟手。 -->
    <a class="proj-card" data-id="${esc(p.id)}" draggable="false" href="#dev/${esc(p.id)}">
      <div class="proj-top">
        <span class="proj-name">${esc(p.name)}</span>
        <span class="proj-top-right">
          ${paths.length ? imgBadge(paths, "图", { act: "p-img", id: p.id, title: "点这里看项目截图" }) : ""}
          ${chip(p.status)}
        </span>
      </div>
      <div class="proj-intro">${esc(p.intro || "（还没有简介）")}</div>
      <div class="proj-counts">待办 ${openTodos} 条 · 未解决 bug ${bugs} 条</div>
      ${
        p.startDate || p.expectEndDate
          ? `<div class="proj-meta">${p.startDate ? `开始于 ${esc(p.startDate)}` : ""}${
              p.startDate && p.expectEndDate ? " · " : ""
            }${p.expectEndDate ? `预计 ${esc(p.expectEndDate)} 收尾` : ""}</div>`
          : ""
      }
    </a>`;
}

/* ---------------- 项目详情 ---------------- */

function renderDetail(root, p) {
  const todos = todoList(p.id).map(normalizeTodo);   // 画列表用的展示副本
  const issues = issueList(p.id);
  const progress = progressList(p.id);
  const st = issueStats(issues);                       // 默认不数归档的
  const activeTodos = splitByArchive(todos).active;
  const todoDone = activeTodos.filter((t) => t.done).length;
  const archivedTodos = todos.length - activeTodos.length;
  const archivedIssues = splitByArchive(issues).archived.length;

  root.innerHTML = `
    ${pageHeader("dev", `<a class="link" href="#dev">← 返回项目列表</a>`)}
    <section class="card">
      <div class="card-head">
        <h2>${esc(p.name)}</h2>
        <span class="date-chip">${esc(p.status || "进行中")}</span>
      </div>

      <dl class="facts">
        <dt>状态</dt><dd>${esc(p.status || "—")}</dd>
        <dt>简介</dt><dd>${esc(p.intro || "—")}</dd>
        <dt>开始日期</dt><dd>${esc(p.startDate || "—")}</dd>
        <dt>预计结束</dt><dd>${esc(p.expectEndDate || "—")}</dd>
      </dl>
      ${
        p.description
          ? `<p class="issue-desc">${esc(p.description)}</p>`
          : `<p class="issue-desc empty">（还没写详细描述，点「编辑项目」补上目标或规划）</p>`
      }
      ${thumbsHtml(rowPaths(p))}
      <div class="row">
        <button class="btn small" data-act="p-edit">编辑项目</button>
        <button class="btn small danger" data-act="p-delete">删除项目</button>
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <h2>待办</h2>
        <div class="card-tools">
          <span class="hint">未完成 ${activeTodos.length - todoDone} ｜ 已完成 ${todoDone}</span>
          <select id="todo-state-filter" title="主列表只看哪一档（归档的去「查看归档」）">${todoStateOptions(todoState)}</select>
          ${archiveBtn("todo", archivedTodos)}
          <button class="btn primary small" data-act="todo-add">${icon("plus", 14)}添加待办</button>
        </div>
      </div>
      ${todoSectionHtml(todos)}
    </section>

    <section class="card">
      <div class="card-head">
        <h2>问题 / bug</h2>
        <div class="card-tools">
          <span class="dev-stats" title="未解决 = 待处理 + 进行中 + 已复现；归档的不算在内">
            <i>未解决 ${st.open}</i>
            <i>进行中 ${st.doing}</i>
            <i>已修复 ${st.fixed}</i>
          </span>
          ${archiveBtn("issue", archivedIssues)}
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

    <p class="hint">项目待办不会出现在「今日计划」里，它们只属于这个项目。</p>
    ${archiveDrawerHtml(p)}
  `;
}

/** 卡片右上角那个入口：两个卡片长得一模一样，点开的是同一个侧边抽屉 */
function archiveBtn(tab, count) {
  return `<button class="btn small" data-act="arch-open" data-tab="${tab}"
    title="归档的记录不占主列表，收在侧边抽屉里，随时能恢复"
    >查看归档${count ? ` <span class="arch-count">${count}</span>` : ""}</button>`;
}

/** 待办卡片的内容：只画没归档的（归档的统一进侧边抽屉），再按活跃档位过一遍 */
function todoSectionHtml(todos) {
  const base = splitByArchive(todos).active;
  if (!base.length) {
    return emptyLine(
      todos.length ? "活跃待办都清空了，归档的在右上角「归档」里。" : "还没有待办，点右上角「添加待办」加一条。"
    );
  }
  const shown = base.filter((t) =>
    todoState === "open" ? !t.done : todoState === "done" ? t.done : true
  );
  if (!shown.length) {
    return emptyLine(todoState === "done" ? "还没有已完成的待办。" : "活跃待办都做完了，不错。");
  }
  return `<ul class="tasks">${shown.map(todoRow).join("")}</ul>`;
}

/** 主列表里的一条待办。归档了的不走这里（它在侧边抽屉里，见 archiveRowHtml）。 */
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
        ${t.done ? `<button class="link" data-act="todo-archive">归档</button>` : ""}
        <button class="link" data-act="todo-edit">编辑</button>
        <button class="link danger" data-act="todo-del">删除</button>
      </span>
    </li>`;
}

/* ---------------- 归档侧边抽屉 ----------------
 * 待办归档 / Bug 归档两类共用一个抽屉：从右边滑进来，标签切换，
 * 搜索 + 优先级 + 归档日期范围筛选，单条恢复 / 删除，也能勾一批一起处理。
 * 只画当前项目里归档了的那几条，主卡片一个字都不动。
 */

/** 当前项目里归档的原始记录（要改数据，所以给的是原对象不是规整后的副本） */
function archivedRowsOf(tab, projectId = currentProjectId()) {
  const rows = tab === "issue" ? issueList(projectId) : todoList(projectId);
  return splitByArchive(rows).archived;
}

/** 抽屉里一行：归档时间取到「天」，用来跟日期范围比 */
function archivedDay(row) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(row.archivedAt || ""));
  return m ? m[1] : "";
}

/** 归档条目按归档时间从新到旧（没记时间的排最后） */
function archiveSorted(rows) {
  return rows.slice().sort((a, b) => {
    const x = String(a.archivedAt || "");
    const y = String(b.archivedAt || "");
    if (x === y) return 0;
    if (!x) return 1;
    if (!y) return -1;
    return x < y ? 1 : -1;
  });
}

/** 当前标签下、过了筛选的归档条目 */
function archiveVisible() {
  const kw = archive.kw.trim().toLowerCase();
  const rows = archivedRowsOf(archive.tab).filter((row) => {
    if (archive.severity !== "all") {
      const v = archive.tab === "issue" ? normalizeIssue(row).severity : String(row.priority || "");
      if (v !== archive.severity) return false;
    }
    const day = archivedDay(row);
    if (archive.from && (!day || day < archive.from)) return false;
    if (archive.to && (!day || day > archive.to)) return false;
    if (!kw) return true;
    const text = archive.tab === "issue"
      ? [row.title, row.desc, row.module].join(" ")
      : [row.text, row.note].join(" ");
    return text.toLowerCase().includes(kw);
  });
  return archiveSorted(rows);
}

function archiveDrawerHtml(p) {
  if (!archive.open) return "";
  const tabs = [
    ["todo", "待办归档", splitByArchive(todoList(p.id)).archived.length],
    ["issue", "Bug 归档", splitByArchive(issueList(p.id)).archived.length],
  ];
  return `
    <div class="arch-backdrop" data-act="arch-close">
      <aside class="arch-drawer" role="dialog" aria-modal="true" aria-label="归档记录">
        <div class="arch-head">
          <div>
            <h2>归档记录</h2>
            <p class="hint">${esc(p.name)} · 归档只是挪出主列表，数据一个字节都没删</p>
          </div>
          <button class="btn small" data-act="arch-close" title="关闭（Esc）">关闭</button>
        </div>

        <div class="arch-tabs" role="tablist">
          ${tabs
            .map(
              ([id, text, n]) => `
            <button class="arch-tab${archive.tab === id ? " active" : ""}" role="tab"
              aria-selected="${archive.tab === id}" data-act="arch-tab" data-tab="${id}"
              >${text}${n ? ` <span class="arch-count">${n}</span>` : ""}</button>`
            )
            .join("")}
        </div>

        <div class="arch-filters">
          <input id="arch-search" type="search" autocomplete="off" placeholder="搜归档记录…"
                 value="${esc(archive.kw)}">
          <div class="row">
            <select id="arch-severity" title="按优先级筛">
              <option value="all"${archive.severity === "all" ? " selected" : ""}>全部优先级</option>
              ${["高", "中", "低"].map(
                (v) => `<option value="${v}"${archive.severity === v ? " selected" : ""}>${v}</option>`
              ).join("")}
              <option value=""${archive.severity === "" ? " selected" : ""}>未标优先级</option>
            </select>
            <label class="inline-field" for="arch-from">归档日期</label>
            <input id="arch-from" type="date" value="${esc(archive.from)}">
            <span class="hint">到</span>
            <input id="arch-to" type="date" value="${esc(archive.to)}">
            <button class="btn small" data-act="arch-filter-clear">清空筛选</button>
          </div>
        </div>

        <div class="arch-body" id="arch-body-host">${archiveBodyHtml()}</div>
      </aside>
    </div>`;
}

/** 批量条 + 列表：筛选项一变就只重画这一块，上面的输入框和下拉不会掉焦点 */
function archiveBodyHtml() {
  const rows = archiveVisible();
  const ids = rows.map((r) => r.id);
  const picked = ids.filter((id) => archive.picked.has(id));
  const allPicked = ids.length > 0 && picked.length === ids.length;
  if (!rows.length) {
    const anyArchived = archivedRowsOf(archive.tab).length;
    return emptyState(
      anyArchived ? "没有符合筛选的归档记录" : archive.tab === "issue" ? "还没有归档的 bug" : "还没有归档的待办",
      anyArchived
        ? "换个条件，或者点「清空筛选」。"
        : "做完的待办、修好的 bug 点「归档」就收到这里，随时能恢复。",
      "",
      archive.tab === "issue" ? "bug" : "list"
    );
  }
  return `
    <div class="arch-bulk">
      <label class="check" title="勾选当前筛选出来的全部条目">
        <input type="checkbox" id="arch-all" ${allPicked ? "checked" : ""}>
      </label>
      <span class="hint" id="arch-picked-info">${
        picked.length ? `已选 ${picked.length} / ${ids.length} 条` : `共 ${ids.length} 条`
      }</span>
      <span class="grow"></span>
      <button class="btn small" data-act="arch-restore-picked"${picked.length ? "" : " disabled"}>批量恢复</button>
      <button class="btn small danger" data-act="arch-delete-picked"${picked.length ? "" : " disabled"}>批量删除</button>
    </div>
    <ul class="items arch-list">
      ${rows.map((row) => archiveRowHtml(row, archive.tab)).join("")}
    </ul>`;
}

/** 抽屉里的一条归档记录：弱化样式 + 归档时间 + 恢复 / 删除 */
function archiveRowHtml(row, tab) {
  const id = esc(row.id);
  const isIssue = tab === "issue";
  const it = isIssue ? normalizeIssue(row) : normalizeTodo(row);
  const picked = archive.picked.has(row.id);
  return `
    <li class="item arch-row" data-id="${id}">
      <label class="check" title="${picked ? "取消勾选" : "勾选这一条（可以批量恢复 / 删除）"}">
        <input type="checkbox" data-act="arch-pick" ${picked ? "checked" : ""}>
      </label>
      ${chip(isIssue ? it.severity : it.priority)}
      <span class="arch-main">
        <span class="i-title">${esc(isIssue ? it.title : it.text)}</span>
        ${isIssue && it.module ? `<span class="arch-note">来源模块：${esc(it.module)}</span>` : ""}
        ${!isIssue && it.note ? `<span class="arch-note">${esc(it.note)}</span>` : ""}
      </span>
      <span class="i-meta">归档于 ${esc(row.archivedAt || "—")}</span>
      <span class="i-actions">
        <button class="link" data-act="arch-restore">恢复</button>
        <button class="link danger" data-act="arch-del">删除</button>
      </span>
    </li>`;
}

/** 问题 / bug 的筛选条：状态 / 优先级 / 关联模块。只影响显示，不动数据。
 *  （2026-10-08 改版：原来这里还有个「归档」下拉，现在归档统一进侧边抽屉，
 *   筛选条只管没归档的那些。） */
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
  const active = splitByArchive(issues).active;   // 主列表只放没归档的
  const shown = active.filter((i) => matchIssue(i, issueFilter));
  if (!shown.length) {
    const archivedCount = issues.length - active.length;
    return emptyState(
      active.length ? "没有符合筛选的问题" : "活跃的 bug 都清空了",
      active.length
        ? "换个条件，或者点「清空筛选」。"
        : archivedCount
          ? `归档的还有 ${archivedCount} 条，点右上角「查看归档」。`
          : "换个条件，或者点「清空筛选」。",
      "",
      "bug"
    );
  }
  return `<ul class="items">${shown.map(issueRow).join("")}</ul>`;
}

/** 主列表里的一条 bug。归档了的不走这里（它在侧边抽屉里，见 archiveRowHtml）。 */
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
        ${closed
          ? `<button class="link" data-act="issue-archive">归档</button>`
          : `<button class="link" data-act="issue-done">标记已修复</button>`}
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

/**
 * 输入框边打边存。
 * 现在只剩项目筛选框一处：只重画卡片区，不动输入框（否则光标会跳）。
 * 项目 / 待办 / 问题 / 进展的录入都走弹窗了，弹窗里是「点保存才写」。
 */
function onInput(e) {
  const el = e.target;

  if (el.id === "project-filter") {
    filterText = el.value;
    applyFilter();
    return;
  }
  // 抽屉里的搜索：边打边筛，只重画下半截 —— 输入框本身不动，光标不跳
  if (el.id === "arch-search") {
    archive.kw = el.value;
    refreshArchiveBody();
  }
}

function findTodo(id) {
  return table("tasks").find((t) => t.id === id) || null;
}

function findIssue(id) {
  return table("issues").find((i) => i.id === id) || null;
}

/* ---------------- 归档 / 恢复 ----------------
 * 归档只是把 isArchived 置上、记一下时刻：数据一个字节都不删，
 * 按地址还找得回来。主列表按它分流，统计和搜索默认不看归档。
 */

function archiveRow(row) {
  row.isArchived = true;
  row.archivedAt = nowText();
}

function unarchiveRow(row) {
  row.isArchived = false;
  row.archivedAt = "";
}

/** 归档一条（待办 / 问题共用）：写标记 + 落盘 + 提一句 */
function doArchive(row, what) {
  if (!row || archivedOf(row)) return false;
  archiveRow(row);
  touch(true);
  toast(`${what}已归档，在归档区点「恢复」就能回来`);
  return true;
}

function doUnarchive(row, what) {
  if (!row || !archivedOf(row)) return false;
  unarchiveRow(row);
  touch(true);
  toast(`${what}已恢复，回到主列表`);
  return true;
}

/* ---------------- 抽屉的开合与批量的收尾 ---------------- */

/** 记着按下过 Esc 的那次监听只挂一次（抽屉开开关关不用重复挂） */
let archEscBound = false;

function bindArchiveEsc() {
  if (archEscBound) return;
  archEscBound = true;
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || !archive.open) return;
      // 弹窗 / 全屏看图压在上面时，Esc 先关它们，别把抽屉一起关了
      if (document.querySelector(".dlg-backdrop") || document.querySelector(".viewer-backdrop")) return;
      closeArchive();
    },
    true
  );
}

/** 打开抽屉：tab 决定默认停在哪一类（点待办卡片的入口就停在待办归档） */
function openArchive(tab) {
  archive.open = true;
  archive.tab = tab === "issue" ? "issue" : "todo";
  archive.picked.clear();
  redraw();
  const box = document.getElementById("arch-search");
  if (box) setTimeout(() => box.focus(), 0);
}

function closeArchive() {
  archive.open = false;
  archive.kw = "";
  archive.severity = "all";
  archive.from = "";
  archive.to = "";
  archive.picked.clear();
  redraw();
}

/** 只重画抽屉下半截：筛选项边打边改时，上面的输入框和下拉不会掉焦点 */
function refreshArchiveBody() {
  const host = (hostRoot && hostRoot.querySelector("#arch-body-host")) || null;
  if (host) host.innerHTML = archiveBodyHtml();
}

/** 勾选里的 id 去掉已经不在此列的（恢复 / 删除之后会用到） */
function pruneArchivePicked() {
  const valid = new Set(archivedRowsOf(archive.tab).map((r) => r.id));
  for (const id of [...archive.picked]) if (!valid.has(id)) archive.picked.delete(id);
}

/** 批量恢复 / 批量删除：一次处理勾中的那些，二次确认只问一次 */
async function archiveBatch(mode) {
  const rows = archiveVisible().filter((r) => archive.picked.has(r.id));
  if (!rows.length) {
    toast("先勾几条", "err");
    return;
  }
  const what = archive.tab === "issue" ? "问题" : "待办";
  if (mode === "restore") {
    for (const row of rows) unarchiveRow(row);
    archive.picked.clear();
    touch(true);
    toast(`${rows.length} 条${what}已恢复，回到主列表`);
    return;
  }
  const ok = await askConfirm({
    title: `删除这 ${rows.length} 条${what}归档记录？`,
    message: "会放进回收站，误删可以去「数据与设置」找回。",
    confirmLabel: "删除",
    danger: true,
  });
  if (!ok) return;
  for (const row of rows) {
    moveToTrash(archive.tab === "issue" ? "issues" : "tasks", row, archive.tab === "issue" ? row.title : row.text);
  }
  archive.picked.clear();
  touch(true);
  toast(`${rows.length} 条已移入回收站`);
}

/** 抽屉里单条删除：和别处一样走回收站，不直接抹掉 */
async function archiveDeleteOne(row) {
  const what = archive.tab === "issue" ? "问题" : "待办";
  const label = archive.tab === "issue" ? row.title : row.text;
  const ok = await askConfirm({
    title: `删除这条${what}归档记录「${label}」？`,
    message: "会放进回收站，误删可以去「数据与设置」找回。",
    confirmLabel: "删除",
    danger: true,
  });
  if (!ok) return;
  moveToTrash(archive.tab === "issue" ? "issues" : "tasks", row, label);
  archive.picked.delete(row.id);
  touch(true);
  toast("已移入回收站");
}

/** 当前这条要处理的归档记录（从点到的按钮那一行往上找 id） */
function archiveRowOf(btn) {
  const li = btn.closest("[data-id]");
  if (!li) return null;
  return archivedRowsOf(archive.tab).find((r) => r.id === li.dataset.id) || null;
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
    ${
      v.isArchived
        ? `<p class="dlg-hint">这条已经归档（归档于 ${esc(v.archivedAt || "—")}）。
             归档不删数据，点「取消归档」就回到主列表；统计和全局搜索默认不看归档条目。</p>`
        : ""
    }
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
      ...(editing
        ? [{ id: v.isArchived ? "unarchive" : "archive",
             label: v.isArchived ? "取消归档" : "归档" }]
        : []),
      { id: "cancel", label: "取消" },
      { id: "save", label: "保存", kind: "primary" },
    ],
    onClose: () => disposeAttach(attach),
    onAction: (act, el) => {
      if (act === "cancel") return true;
      if (act === "archive" || act === "unarchive") {
        const want = act === "archive";
        if (want) doArchive(issue, "问题"); else doUnarchive(issue, "问题");
        dlg.close();     // 状态变了，弹窗先收起来；页面跟着重画
        return false;
      }
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
          // 「修好后自动归档」开着时，改成已修复就顺手归档（已经归档的不重复动）
          const autoArchived = next.status === "已修复" && autoArchiveIssueOf() && !issue.isArchived;
          if (autoArchived) archiveRow(issue);
          touch(true);
          dlg.close();
          toast(autoArchived ? "已保存，并按设置自动归档" : "已保存");
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
            isArchived: false,   // 「修好后自动归档」开着时，下面马上补上
            archivedAt: "",
          });
          // 修好一个就自动归档（设置里开着才这么做；新增时也照这个规矩）
          const created = table("issues")[table("issues").length - 1];
          if (created.status === "已修复" && autoArchiveIssueOf()) archiveRow(created);
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

/* ---------------- 弹窗：待办 ----------------
 * 待办的新增 / 编辑还是走那套通用弹窗（item-form.js 的 devTodo），
 * 只是编辑时多两样：已归档的显示归档时间，未归档的给一个「归档」按钮。
 * 弹窗体系本身没动，多出来的按钮由 openItemDialog 的 extraButtons 传进去。
 */

function openTodoDialog(todo, pid) {
  const archived = archivedOf(todo);
  return openItemDialog("devTodo", todo, {
    pid,
    extraHtml: archived
      ? `<p class="dlg-hint">这条已经归档（归档于 ${esc(todo.archivedAt || "—")}）。
           归档不删数据，点「取消归档」就回到主列表。</p>`
      : "",
    extraButtons: [
      { id: archived ? "unarchive" : "archive", label: archived ? "取消归档" : "归档" },
    ],
    onExtraAction: (act) => {
      if (act === "archive") return doArchive(todo, "待办");
      if (act === "unarchive") return doUnarchive(todo, "待办");
    },
  });
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

  if (act === "p-img") {
    // 卡片右上角那个图片标记：点它看截图，别跟着卡片跳进项目详情
    e.preventDefault();
    const p = table("projects").find((x) => x.id === btn.dataset.id);
    if (p) openPathViewer(rowPaths(p));
  } else if (act === "p-add") {
    openItemDialog("devProject", null, { defaults: { startDate: todayStr() } });
  } else if (act === "p-edit") {
    const p = table("projects").find((x) => x.id === pid);
    if (p) {
      openItemDialog("devProject", p, {
        // 正在看的这个项目被删掉之后，地址还指着它就不好看了，拉回项目列表
        onDeleted: () => {
          if (currentProjectId() === p.id) location.hash = "#dev";
        },
      });
    }
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
    trashItem("devProject", p);   // 连带规则和弹窗里的「删除」共用一个实现
    location.hash = "#dev";
    touch(true);
    toast("项目已移入回收站");
  } else if (act === "todo-edit") {
    const t = findTodo(id);
    if (t) openTodoDialog(t, pid);
  } else if (act === "todo-add") {
    openItemDialog("devTodo", null, { pid });
  } else if (act === "todo-archive") {
    doArchive(findTodo(id), "待办");
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
    const autoArchived = autoArchiveIssueOf() && !i.isArchived;
    if (autoArchived) archiveRow(i);
    touch(true);
    toast(autoArchived ? "已标记修复，并按设置自动归档" : "已标记修复");
  } else if (act === "issue-archive") {
    doArchive(findIssue(id), "问题");
  } else if (act === "issue-filter-clear") {
    issueFilter = { status: "all", severity: "all", module: "all" };
    redraw();
  } else if (act === "arch-open") {
    openArchive(btn.dataset.tab);
  } else if (act === "arch-close") {
    // 点遮罩也算关：但点抽屉里面的东西不该关，靠 target 判断
    if (e.target === btn) closeArchive();
  } else if (act === "arch-tab") {
    archive.tab = btn.dataset.tab === "issue" ? "issue" : "todo";
    archive.picked.clear();
    redraw();
  } else if (act === "arch-restore") {
    const row = archiveRowOf(btn);
    if (row) doUnarchive(row, archive.tab === "issue" ? "问题" : "待办");
  } else if (act === "arch-del") {
    const row = archiveRowOf(btn);
    if (row) await archiveDeleteOne(row);
  } else if (act === "arch-delete-picked") {
    await archiveBatch("delete");
  } else if (act === "arch-restore-picked") {
    await archiveBatch("restore");
  } else if (act === "arch-filter-clear") {
    archive.kw = "";
    archive.severity = "all";
    archive.from = "";
    archive.to = "";
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
  // 待办主列表的活跃档位（全部 / 未完成 / 已完成）
  if (e.target.id === "todo-state-filter") {
    todoState = e.target.value;
    redraw();
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
  // 归档抽屉：优先级 / 归档日期范围只重画下半截，输入框和下拉都不动
  if (e.target.id === "arch-severity") {
    archive.severity = e.target.value;
    refreshArchiveBody();
    return;
  }
  if (e.target.id === "arch-from") {
    archive.from = e.target.value;
    refreshArchiveBody();
    return;
  }
  if (e.target.id === "arch-to") {
    archive.to = e.target.value;
    refreshArchiveBody();
    return;
  }
  // 勾一条 / 全选：只更新批量条，列表不重画（复选框自己会亮）
  if (e.target.closest('[data-act="arch-pick"]')) {
    const li = e.target.closest("[data-id]");
    if (!li) return;
    if (e.target.checked) archive.picked.add(li.dataset.id);
    else archive.picked.delete(li.dataset.id);
    refreshArchiveBody();
    return;
  }
  if (e.target.id === "arch-all") {
    for (const row of archiveVisible()) {
      if (e.target.checked) archive.picked.add(row.id);
      else archive.picked.delete(row.id);
    }
    refreshArchiveBody();
    return;
  }
  const box = e.target.closest('[data-act="todo-toggle"]');
  if (!box) return;
  const li = box.closest("[data-id]");
  const t = li ? findTodo(li.dataset.id) : null;
  if (!t) return;
  t.done = box.checked;
  t.doneAt = box.checked ? new Date().toISOString() : null;
  // 设置里开着「勾选完成后自动归档」就顺手归档；关着就留在主列表等手动归档
  if (box.checked && autoArchiveTodoOf() && !archivedOf(t)) {
    archiveRow(t);
    touch(true);
    toast("已完成，并按设置自动归档");
    return;
  }
  touch();
}
