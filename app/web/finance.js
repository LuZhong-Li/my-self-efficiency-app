/* 记账：记一笔（支出 / 收入）、月历上看每天花了多少、当月概览与总预算、
 * 分类环形图、当日明细、一小份账户列表。
 *
 * 布局照设计文档走：左栏月历 + 环形图，右栏概览 / 明细 / 账户（方案乙）。
 * 计算全在 money.js 和 finance-calc.js 里，这个文件只管画和接事件。
 */

import { store, table, todayStr } from "./store.js";
import { pageHeader, bindFresh } from "./ui.js";
import { icon } from "./icons.js";
import { monthGridHtml, calendarAction } from "./calendar.js";
import { fmtMoneyShort } from "./money.js";
import { monthKey, monthByDay, overDays } from "./finance-calc.js";

let selected = null; // 月历上选中的那天

/** 记账的数据都嵌在 finance 这一个键里；老数据可能还没有它，
 *  这里顺手补上空壳（和 store.js 的 table() 一个脾气）。 */
function finance() {
  if (!store.data.finance || typeof store.data.finance !== "object") store.data.finance = {};
  return store.data.finance;
}

function accountsOf() {
  return table("finance.accounts");
}

function budgetOf() {
  const f = finance();
  if (!f.budget || typeof f.budget !== "object") f.budget = { monthlyTotalCents: 0, categoryCents: {} };
  return f.budget;
}

/** 左栏：月历。格子里画当天的支出（红）和收入（绿），超支的日子套一圈红边。 */
function calendarCard(txs) {
  const month = monthKey(selected);
  const byDay = monthByDay(txs, month);
  const over = overDays(txs, month, budgetOf().monthlyTotalCents);
  return monthGridHtml({
    selected,
    kinds: [], // 记账的格子里画的是金额，不用圆点，所以也不要图例
    marksOf: () => [],
    dayExtraOf: (date) => {
      const d = byDay.get(date);
      const isOver = over.has(date);
      if (!d) return isOver ? { lines: [], over: true } : null;
      const lines = [];
      if (d.expenseCents) lines.push({ text: "-" + fmtMoneyShort(d.expenseCents), tone: "expense" });
      if (d.incomeCents) lines.push({ text: "+" + fmtMoneyShort(d.incomeCents), tone: "income" });
      return { lines, over: isOver };
    },
  });
}

export function renderFinance(root) {
  if (!selected) selected = todayStr();
  const txs = table("finance.transactions");

  root.innerHTML = `
    ${pageHeader("finance", `<button class="btn primary" data-act="add">${icon("plus", 16)}记一笔</button>`)}
    <div class="fin-layout">
      <div class="fin-main">
        <section class="card" id="fin-calendar">${calendarCard(txs)}</section>
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

function onClick(e) {
  const cal = calendarAction(e);
  if (cal.handled) {
    if (cal.selected) selected = cal.selected;
    redraw();
  }
}
function onSubmit() {}
function onChange() {}
