/* 自绘的确认框和轻提示。
 *
 * 不用浏览器自带的 confirm()/alert()：它们长得和界面不是一个世界，
 * 而且会阻塞页面；应用内浏览器里 prompt() 甚至直接不支持。
 * 这个是自己的：居中卡片、Esc 关、点遮罩关、Tab 在按钮间绕圈。
 *
 * 2026-10-10：「同时只留一个弹窗」改成「弹窗栈」。以前在编辑弹窗里点「删除」，
 * askConfirm 会先把编辑弹窗整个关掉再弹确认框 —— 点「取消」，编辑弹窗也回不来了
 * （记账、债务、问题、进展、自媒体几个弹窗都是这个毛病）。现在确认框叠在编辑
 * 弹窗上面（栈顶收 Esc / 点遮罩），取消只收掉确认框，编辑弹窗原样还在。
 * openDialog 开的是新表单，仍然先把旧的清干净，免得两个表单叠在一起。
 */

import { esc } from "./store.js";
import { icon } from "./icons.js";

// 从下到上的弹窗栈：{ el, kind, resolveFn, extraClose }
//   kind        "confirm" = askConfirm，叠在别的东西上面；"dialog" = openDialog 的表单
//   resolveFn   askConfirm 用的 promise 兑现函数
//   extraClose  openDialog 用的收尾（比如把占着的图片附件资源收回）
const stack = [];

function topEntry() {
  return stack[stack.length - 1] || null;
}

function onKey(e) {
  if (!stack.length) return;
  // 全屏看图盖在弹窗上面时，Esc 该关的是图，不是底下那个弹窗
  // （看图那层自己会处理 Esc，见 attachment.js 的 openViewer）
  if (e.key === "Escape" && document.querySelector(".viewer-backdrop")) return;
  if (e.key === "Escape") {
    e.preventDefault();
    closeDialog(false);
  }
}

/** 把一个弹窗从栈里摘掉，收尾。result 会传给它自己的 resolveFn（确认框用）。
 *  收掉栈顶后，如果下面还压着一个弹窗而焦点掉到了页面上，就把它接回来 ——
 *  不然「编辑 → 删除 → 取消」之后键盘没处落，得先点一下才能接着改。 */
function dispose(entry, result, refocus = true) {
  const i = stack.indexOf(entry);
  if (i >= 0) stack.splice(i, 1);
  if (!stack.length) document.removeEventListener("keydown", onKey, true);
  entry.el.remove();
  if (entry.resolveFn) entry.resolveFn(result);
  if (entry.extraClose) entry.extraClose();
  const below = topEntry();
  if (refocus && below && !below.el.contains(document.activeElement)) {
    const first = [...below.el.querySelectorAll(FOCUSABLE)].find(
      (n) => !n.disabled && n.offsetParent !== null
    );
    if (first) first.focus();
  }
}

/** 关掉最上面那个；不传 el 就关栈顶，传了就关那一个（表单自己的「关」按钮） */
function closeDialog(result, targetEl) {
  const entry = targetEl ? stack.find((s) => s.el === targetEl) : topEntry();
  if (entry) dispose(entry, result);
}

/** 压一个弹窗进栈，第一次压进去时挂上全局 Esc */
function pushDialog(entry) {
  stack.push(entry);
  if (stack.length === 1) document.addEventListener("keydown", onKey, true);
}

/** 全清：openDialog 开新表单之前用，把旧的（含确认框）都收掉 */
function clearDialogs() {
  while (stack.length) dispose(topEntry(), null, false);
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
    // 连点两下弹出来两个确认框的情形：上面那个确认框先收掉。
    // 底下要是开着编辑弹窗，是**不能**动的 —— 它就是留着让用户取消后接着改的。
    const top = topEntry();
    if (top && top.kind === "confirm") dispose(top, false);

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
    pushDialog({ el, kind: "confirm", resolveFn: resolve, extraClose: null });

    const buttons = [...el.querySelectorAll(".btn")];
    setTimeout(() => (buttons[buttons.length - 1] || el).focus?.(), 0);

    el.addEventListener("click", (e) => {
      if (e.target === el) return closeDialog(false, el);
      const btn = e.target.closest("[data-dlg]");
      if (btn) closeDialog(btn.dataset.dlg === "yes", el);
    });
    bindTabTrap(el);
  });
}

/**
 * 通用弹窗：内容自己拼、按钮自己定。askConfirm 的兄弟，共用同一套
 * .dlg-backdrop / .dlg 样式与行为（Esc 关、点遮罩关、Tab 在按钮间绕圈）。
 * 开之前会把旧的弹窗都收干净；记账的「记一笔」用的就是它。
 *
 * @param {{title: string, bodyHtml?: string,
 *          buttons?: {id: string, label: string, kind?: string}[],
 *          onAction?: (id: string, el: HTMLElement) => (boolean | void),
 *          onClose?: () => void}} options
 *        onAction 返回 false 表示别关；返回别的（或什么都不返回）就关掉。
 *        onClose 在弹窗关掉（不管怎么关的）之后叫一次，用来收回占着的东西。
 * @returns {{ el: HTMLElement, close: () => void }}
 */
export function openDialog({ title, bodyHtml = "", buttons = [], onAction, onClose }) {
  clearDialogs(); // 开新表单：旧的（包括还开着的确认框）先收干净
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
  pushDialog({
    el,
    kind: "dialog",
    resolveFn: null,
    extraClose: typeof onClose === "function" ? onClose : null,
  });

  const close = () => closeDialog(null, el);
  el.addEventListener("click", (e) => {
    if (e.target === el) return close();
    const btn = e.target.closest("[data-dlg-act]");
    if (!btn) return;
    if (onAction && onAction(btn.dataset.dlgAct, el) === false) return;
    close();
  });
  bindTabTrap(el);
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
