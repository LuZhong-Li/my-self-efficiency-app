/* 债务欠款：记账模块里的子页面。
 * 布局和账目记录一样是双栏（左月历、右总览 + 列表），共用 .fin-layout 那套宽度规则。 */

import { table, todayStr } from "./store.js";
import { bindFresh } from "./ui.js";
import { splitBySettled } from "./debt-calc.js";

let selected = null; // 债务页月历上选中的那天

export function renderDebtPage(root) {
  if (!root) return;
  if (!selected) selected = todayStr();
  const items = table("debt.items");
  const { open, done } = splitBySettled(items, todayStr());

  root.innerHTML = `
    <div class="fin-layout">
      <div class="fin-main">
        <section class="card" id="debt-calendar"></section>
      </div>
      <div class="fin-side">
        <section class="card" id="debt-overview"></section>
        <section class="card" id="debt-list"></section>
      </div>
    </div>
  `;

  bindFresh(root, { click: onClick, submit: onSubmit });
}

function redraw() {
  renderDebtPage(document.getElementById("debt-host"));
}

function onClick() {}
function onSubmit() {}
