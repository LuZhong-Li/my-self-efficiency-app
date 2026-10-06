/* 自绘的确认框和轻提示。
 *
 * 不用浏览器自带的 confirm()/alert()：它们长得和界面不是一个世界，
 * 而且会阻塞页面；应用内浏览器里 prompt() 甚至直接不支持。
 * 这个是自己的：居中卡片、Esc 关、点遮罩关、Tab 在按钮间绕圈。
 */

import { esc } from "./store.js";
import { icon } from "./icons.js";

let backdrop = null;
let resolveFn = null;

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
  backdrop = null;
  resolveFn = null;
  document.removeEventListener("keydown", onKey, true);
  el.remove();
  if (fn) fn(result);
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
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Tab" || !buttons.length) return;
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });
    document.addEventListener("keydown", onKey, true);
  });
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
