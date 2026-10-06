/* 记账页和债务页都要用的那几个小东西。
 * 单独一个文件是为了不让 finance.js 和 debt.js 互相 import（会成环）。 */

import { store, table, esc } from "./store.js";

export const EXPENSE_ICON = {
  餐饮: "🍜", 交通: "🚌", 购物: "🛒", 学习: "📚", 娱乐: "🎮",
  住房: "🏠", 医疗: "💊", 债务还款: "💳", 其他: "📦",
};

export const INCOME_ICON = {
  工资: "💰", 兼职: "💼", 红包: "🧧", 退款: "↩️", 债务收款: "💰", 其他: "📦",
};

export function catIcon(type, category) {
  return (type === "income" ? INCOME_ICON : EXPENSE_ICON)[category] || "📦";
}

/** 记账的数据嵌在 finance 一个键里；老数据可能还没有它，顺手补空壳
 *  （和 store.js 的 table() 一个脾气）。 */
export function financeOf() {
  if (!store.data.finance || typeof store.data.finance !== "object") store.data.finance = {};
  return store.data.finance;
}

export function accountsOf() {
  return table("finance.accounts");
}

export function budgetOf() {
  const f = financeOf();
  if (!f.budget || typeof f.budget !== "object") {
    f.budget = { monthlyTotalCents: 0, categoryCents: {} };
  }
  return f.budget;
}

/** 账户下拉的选项串。账户列表为空时给一条占位的，免得下拉是空的；
 *  当前值指向一个已经删掉的账户时，补一个「（账户已删）」并选中它。 */
export function accountOptionsHtml(current) {
  const list = accountsOf();
  const opts = [
    ...(current && !list.some((a) => a.id === current)
      ? [`<option value="${esc(current)}" selected>（账户已删）</option>`]
      : []),
    ...list.map(
      (a) => `<option value="${esc(a.id)}"${a.id === current ? " selected" : ""}>${esc(a.name)}</option>`
    ),
  ].join("");
  return opts || `<option value="">（还没建账户）</option>`;
}
