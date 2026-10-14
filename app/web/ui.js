/* 几个模块共用的小零件，省得每个文件各写一遍 */

import { esc } from "./store.js";
import { icon } from "./icons.js";
import { moduleOf } from "./modules.js";
import {
  priorityClass, taskSourceLabel, taskOwnerOf, subtaskProgress, subTasksOf,
} from "./task-calc.js";
import { tagsOfRow, tagColor, visibleTags } from "./tag-calc.js";

/** 一段小标题 + 右侧说明，用来分隔同一张卡片里的几个区块 */
export function sectionHead(title, count, extra = "") {
  const left = count === undefined ? title : `${title}（${count}）`;
  return `<div class="list-head"><span>${esc(left)}</span><span class="hint">${esc(extra)}</span></div>`;
}

export function emptyLine(text) {
  return `<p class="empty">${esc(text)}</p>`;
}

/** 小圆角标签，用来显示平台、状态、分类这类短词 */
export function chip(text) {
  if (!text) return "";
  return `<span class="chip">${esc(text)}</span>`;
}

/** 优先级胶囊（高 / 中 / 低，各有自己的颜色）。没标优先级的返回空串，不画。 */
export function priorityChip(priority) {
  const cls = priorityClass(priority);
  if (!cls) return "";
  return `<span class="chip ${cls}" title="优先级：${esc(priority)}">${esc(priority)}</span>`;
}

/** 来源标签：这条待办是从哪个模块进来的（开发待办 / 健身目标任务…）。
 *  今日计划自己的任务不挂这个标签，所以返回空串。 */
export function sourceTag(task) {
  const text = taskSourceLabel(task);
  if (!text) return "";
  const dev = taskOwnerOf(task) === "dev";
  const tip = dev
    ? "这条待办挂在开发工作的项目上：状态和正文两边同步，删除要回项目里删"
    : "这条是从别的模块加进来的，正文照样能改";
  return `<span class="t-src${dev ? " neutral" : ""}" title="${esc(tip)}">${esc(text)}</span>`;
}

/**
 * 素材标记：这条记录挂了 N 份素材（2026-10-14 全站版加的）。
 * 只报个数，不查素材表 —— 行渲染不该为了一个小标记去读另一张表；
 * 想知道具体是哪几份，点开弹窗（或去素材库看「被 N 处引用」）。
 */
export function assetBadge(row) {
  const list = row && Array.isArray(row.assetIds) ? row.assetIds : [];
  const n = list.filter(Boolean).length;
  if (!n) return "";
  return `<span class="chip asset-chip" title="这条挂了 ${n} 份素材，点弹窗里的「素材」看">素材 ${n}</span>`;
}

/**
 * 标签胶囊：一条记录贴的标签画成小胶囊，最多画 max 个，剩下的收成 +N
 * （鼠标移上去 title 里能看到全部）。没标签就返回空串，不占位。
 * 颜色由名字哈希取（tag-calc.js 的 tagColor），不落盘、不用配。
 */
export function tagChips(row, max = 3) {
  const tags = tagsOfRow(row);
  if (!tags.length) return "";
  const { shown, rest } = visibleTags(tags, max);
  return (
    shown
      .map((name) => `<span class="chip tag-chip" data-c="${tagColor(name)}">${esc(name)}</span>`)
      .join("") +
    (rest > 0
      ? `<span class="chip tag-chip tag-more" title="${esc(tags.join("、"))}">+${rest}</span>`
      : "")
  );
}

/**
 * 子任务标记：一枚「2/5」的小胶囊 + 就地展开的那份清单（藏在同一个 li 里）。
 * 今日计划 / 首页 / 项目详情三处共用这一份零件（和 priorityChip / sourceTag 摆一起），
 * 所以三处的样子和口径天生一致。没子任务的返回空串，不占地方。
 * 展开 / 收起靠 li 上的 .sub-open（CSS 管显隐），事件走 task-actions.js 那两个助手。
 */
export function subtaskBadge(task) {
  const list = subTasksOf(task);
  if (!list.length) return "";
  const p = subtaskProgress(task);
  const allDone = p.done === p.total;
  const chip =
    `<button class="link sub-chip${allDone ? " sub-done" : ""}" data-act="sub-open"` +
    ` title="子任务 ${p.done}/${p.total}，点这里就地展开">${p.done}/${p.total}</button>`;
  const items = list
    .map(
      (s) =>
        `<li class="subtask${s.done ? " done" : ""}">` +
        `<label class="check"><input type="checkbox" data-act="sub" data-sub="${esc(s.id)}"` +
        `${s.done ? " checked" : ""}></label>` +
        `<span class="sub-text">${esc(s.text)}</span></li>`
    )
    .join("");
  return chip + `<ul class="subtasks">${items}</ul>`;
}

/** 把 <select> 的选项拼出来 */
export function options(list, current) {
  return list
    .map((v) => `<option${v === current ? " selected" : ""}>${esc(v)}</option>`)
    .join("");
}

/**
 * 把刚画出来的内容包进一层新容器，事件挂在这层上。
 *
 * 为什么不用「第一次渲染时挂在公共容器上」那种写法：公共容器不会换，
 * 于是切到别的模块后，上一个模块的事件还留着——两个模块要是用了同样的
 * 表单 id 或同样的按钮名，就会互相触发（踩过：自媒体和今日计划的表单
 * 都叫 add-form，提交一个会让另一个去读不存在的字段而报错）。
 * 每次渲染都新建容器，旧容器的监听随旧 DOM 一起丢掉，互不干扰。
 */
export function bindFresh(root, handlers) {
  const wrap = document.createElement("div");
  while (root.firstChild) wrap.appendChild(root.firstChild);
  root.appendChild(wrap);
  for (const [type, fn] of Object.entries(handlers)) wrap.addEventListener(type, fn);
  return wrap;
}

/** 给刚画好的内容加一下「进入了」的淡入。
 *  只在真的换页面时叫；勾选、增删这种重画别叫，否则每点一下就闪一下。 */
export function markEnter(root) {
  const wrap = root && root.firstElementChild;
  if (!wrap) return;
  wrap.classList.remove("view-enter");
  void wrap.offsetWidth; // 让浏览器认账，动画才会重播
  wrap.classList.add("view-enter");
}

/** 每个模块页顶部那条：图标 + 标题 + 一句说明 + 右侧操作。
 *  （参考木子工作台的 PageHeader：页面一进来就知道这是哪儿、能干什么） */
export function pageHeader(id, action = "") {
  const m = moduleOf(id);
  return `
    <header class="page-header">
      <span class="page-icon">${icon(m.icon, 22)}</span>
      <div class="page-copy">
        <h1>${esc(m.name)}</h1>
        <p>${esc(m.desc || "")}</p>
      </div>
      ${action ? `<div class="page-actions">${action}</div>` : ""}
    </header>`;
}

/** 空状态：一个淡色小标记 + 标题 + 说明 + 可选的行动按钮。
 *  比光秃秃一句「还没有内容」友好一点。 */
export function emptyState(title, description = "", action = "", iconName = "list") {
  return `
    <div class="empty-state">
      <span class="empty-mark">${icon(iconName, 20)}</span>
      <strong>${esc(title)}</strong>
      ${description ? `<p>${esc(description)}</p>` : ""}
      ${action ? `<div class="empty-action">${action}</div>` : ""}
    </div>`;
}
