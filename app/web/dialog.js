/* 自绘的确认框和轻提示。
 *
 * 不用浏览器自带的 confirm()/alert()：它们长得和界面不是一个世界，
 * 而且会阻塞页面；应用内浏览器里 prompt() 甚至直接不支持。
 * 这个是自己的：居中卡片、Esc 关、点遮罩关、Tab 在按钮间绕圈。
 */

import { esc } from "./store.js";
import { icon } from "./icons.js";

let backdrop = null;
let resolveFn = null;   // askConfirm 用
let extraClose = null;  // openDialog 用（关的时候做点收尾）

function onKey(e) {
  if (!backdrop) return;
  if (e.key === "Escape") {
    e.preventDefault();
    closeDialog(false);
  }
}

function closeDialog(result) {
  if (!backdrop) return;
  const el = backdrop;
  const fn = resolveFn;
  const extra = extraClose;
  backdrop = null;
  resolveFn = null;
  extraClose = null;
  document.removeEventListener("keydown", onKey, true);
  el.remove();
  if (fn) fn(result);
  if (extra) extra();
}

/** 弹窗里能被 Tab 到的元素，按出现顺序排（灰掉的按钮不算） */
const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])';

/** Tab 在弹窗内部绕圈，别跑到背后的页面上去。
 *  连输入框也一起圈：只圈 .btn 的话，在弹窗的输入框之间按 Tab 会溜到背景页，
 *  而且焦点回不来（「记一笔」和账户弹窗里都有输入框）。 */
function bindTabTrap(el) {
  el.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const items = [...el.querySelectorAll(FOCUSABLE)].filter(
      (n) => !n.disabled && n.offsetParent !== null
    );
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    // 焦点已经在背景页上时也拉回来（比如从别的弹窗留下来的那种情形）
    const outside = !el.contains(active);
    if (e.shiftKey && (active === first || outside)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || outside)) {
      e.preventDefault();
      first.focus();
    }
  });
}

/** 返回 Promise<boolean>：用户点了确认就是 true */
export function askConfirm({
  title,
  message = "",
  confirmLabel = "确认",
  cancelLabel = "取消",
  danger = false,
}) {
  return new Promise((resolve) => {
    closeDialog(false); // 同时只留一个
    resolveFn = resolve;

    const el = document.createElement("div");
    el.className = "dlg-backdrop";
    el.innerHTML = `
      <div class="dlg" role="dialog" aria-modal="true">
        <div class="dlg-body">
          <span class="dlg-icon${danger ? " danger" : ""}">${icon(danger ? "warning" : "bulb", 20)}</span>
          <div class="dlg-copy">
            <h3>${esc(title)}</h3>
            ${message ? `<p>${esc(message)}</p>` : ""}
          </div>
        </div>
        <div class="dlg-actions">
          <button class="btn" data-dlg="no">${esc(cancelLabel)}</button>
          <button class="btn ${danger ? "danger" : "primary"}" data-dlg="yes">${esc(confirmLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    backdrop = el;

    const buttons = [...el.querySelectorAll(".btn")];
    setTimeout(() => (buttons[buttons.length - 1] || el).focus?.(), 0);

    el.addEventListener("click", (e) => {
      if (e.target === el) return closeDialog(false);
      const btn = e.target.closest("[data-dlg]");
      if (btn) closeDialog(btn.dataset.dlg === "yes");
    });
    bindTabTrap(el);
    document.addEventListener("keydown", onKey, true);
  });
}

/**
 * 通用弹窗：内容自己拼、按钮自己定。askConfirm 的兄弟，共用同一套
 * .dlg-backdrop / .dlg 样式与行为（Esc 关、点遮罩关、Tab 在按钮间绕圈、
 * 同一时间只留一个）。记账的「记一笔」用的就是它。
 *
 * @param {{title: string, bodyHtml?: string,
 *          buttons?: {id: string, label: string, kind?: string}[],
 *          onAction?: (id: string, el: HTMLElement) => (boolean | void)}} options
 *        onAction 返回 false 表示别关；返回别的（或什么都不返回）就关掉。
 * @returns {{ el: HTMLElement, close: () => void }}
 */
export function openDialog({ title, bodyHtml = "", buttons = [], onAction }) {
  closeDialog(null); // 同时只留一个
  const el = document.createElement("div");
  el.className = "dlg-backdrop";
  el.innerHTML = `
    <div class="dlg" role="dialog" aria-modal="true">
      <h3 class="dlg-title">${esc(title)}</h3>
      <div class="dlg-form">${bodyHtml}</div>
      <div class="dlg-actions">
        ${buttons
          .map((b) => `<button class="btn ${b.kind || ""}" data-dlg-act="${esc(b.id)}">${esc(b.label)}</button>`)
          .join("")}
      </div>
    </div>`;
  document.body.appendChild(el);
  backdrop = el;
  extraClose = null;

  const close = () => closeDialog(null);
  el.addEventListener("click", (e) => {
    if (e.target === el) return close();
    const btn = e.target.closest("[data-dlg-act]");
    if (!btn) return;
    if (onAction && onAction(btn.dataset.dlgAct, el) === false) return;
    close();
  });
  bindTabTrap(el);
  document.addEventListener("keydown", onKey, true);
  return { el, close };
}

/** 右下角浮一下的小提示，2 秒后自己消失 */
export function toast(text, kind = "ok") {
  let box = document.getElementById("toast-box");
  if (!box) {
    box = document.createElement("div");
    box.id = "toast-box";
    document.body.appendChild(box);
  }
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.innerHTML = `${icon(kind === "err" ? "warning" : "check", 16)}<span>${esc(text)}</span>`;
  box.appendChild(el);
  setTimeout(() => el.classList.add("show"), 10);
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 250);
  }, 2200);
}
