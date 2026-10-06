/* 几个模块共用的小零件，省得每个文件各写一遍 */

import { esc } from "./store.js";
import { icon } from "./icons.js";
import { moduleOf } from "./modules.js";

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
