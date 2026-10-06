/* 记账：记一笔（支出 / 收入）、月历上看每天花了多少、当月概览与总预算、
 * 分类环形图、当日明细、一小份账户列表。
 *
 * 布局照设计文档走：左栏月历 + 环形图，右栏概览 / 明细 / 账户（方案乙）。
 * 计算全在 money.js 和 finance-calc.js 里，这个文件只管画和接事件。
 */

import { table, todayStr } from "./store.js";
import { pageHeader, bindFresh } from "./ui.js";
import { icon } from "./icons.js";

let selected = null; // 月历上选中的那天

export function renderFinance(root) {
  if (!selected) selected = todayStr();
  const txs = table("finance.transactions");

  root.innerHTML = `
    ${pageHeader("finance", `<button class="btn primary" data-act="add">${icon("plus", 16)}记一笔</button>`)}
    <div class="fin-layout">
      <div class="fin-main">
        <section class="card" id="fin-calendar"></section>
        <section class="card" id="fin-ring"></section>
      </div>
      <div class="fin-side">
        <section class="card" id="fin-overview"></section>
        <section class="card" id="fin-day"></section>
        <section class="card" id="fin-accounts"></section>
      </div>
    </div>
  `;

  bindFresh(root, { click: onClick, submit: onSubmit, change: onChange });
}

function redraw() {
  renderFinance(document.getElementById("view"));
}

function onClick() {}
function onSubmit() {}
function onChange() {}
