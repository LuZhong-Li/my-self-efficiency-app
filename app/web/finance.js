/* 记账：记一笔（支出 / 收入）、月历上看每天花了多少、当月概览与总预算、
 * 分类环形图、当日明细、一小份账户列表。
 *
 * 布局照设计文档走：左栏月历 + 环形图，右栏概览 / 明细 / 账户（方案乙）。
 * 计算全在 money.js 和 finance-calc.js 里，这个文件只管画和接事件。
 */

import { store, table, todayStr, nowText, uid, touch, esc, moveToTrash } from "./store.js";
import { pageHeader, bindFresh, emptyState } from "./ui.js";
import { icon } from "./icons.js";
import { askConfirm, toast, openDialog } from "./dialog.js";
import { monthGridHtml, calendarAction, dayLabel } from "./calendar.js";
import { yuanToCents, centsToYuan, fmtMoney, fmtMoneyShort } from "./money.js";
import {
  monthKey, dayTotals, monthTotals, monthByDay, overDays, budgetState, byCreatedAt,
} from "./finance-calc.js";

let selected = null; // 月历上选中的那天
let editingAccount = null; // 正在改名的账户 id

const EXPENSE_ICON = { 餐饮: "🍜", 交通: "🚌", 购物: "🛒", 学习: "📚", 娱乐: "🎮", 住房: "🏠", 医疗: "💊", 其他: "📦" };
const INCOME_ICON = { 工资: "💰", 兼职: "💼", 红包: "🧧", 退款: "↩️", 其他: "📦" };

function catIcon(type, category) {
  return (type === "income" ? INCOME_ICON : EXPENSE_ICON)[category] || "📦";
}

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

/** 右栏第一张：本月支出 / 收入 / 结余 + 月度总预算进度条。 */
function overviewCard(txs) {
  const month = monthKey(selected);
  const totals = monthTotals(txs, month);
  const st = budgetState(totals.expenseCents, budgetOf().monthlyTotalCents);
  const balanceTone = totals.balanceCents < 0 ? "expense" : "income";
  return `
    <div class="card-head">
      <h2>本月概览</h2>
      <span class="hint">${esc(monthCN(month))}</span>
    </div>
    <div class="fin-sum">
      <div class="fin-sum-item"><span>本月支出</span>
        <strong class="fin-amount expense">${fmtMoney(totals.expenseCents)}</strong></div>
      <div class="fin-sum-item"><span>本月收入</span>
        <strong class="fin-amount income">${fmtMoney(totals.incomeCents)}</strong></div>
      <div class="fin-sum-item"><span>结余</span>
        <strong class="fin-amount ${balanceTone}">${fmtMoney(totals.balanceCents)}</strong></div>
    </div>
    ${budgetBlock(st)}
  `;
}

function budgetBlock(st) {
  const head = `
    <div class="fin-budget-head">
      <span>本月预算</span>
      <span class="fin-budget-input"><i>¥</i>
        <input id="budget-input" type="text" inputmode="decimal" maxlength="10"
               title="月度总预算，离开输入框才保存"
               value="${st.budgetCents ? centsToYuan(st.budgetCents) : ""}" placeholder="还没设">
      </span>
    </div>`;
  if (st.level === "none") {
    return `<div class="fin-budget">${head}
      <p class="hint">还没设本月预算，填一个数字就能看进度。</p></div>`;
  }
  const pct = Math.round(Math.min(1, st.ratio) * 100);
  return `
    <div class="fin-budget">
      ${head}
      <div class="fin-budget-bar">
        <div class="progress-track"><span class="lv-${st.level}" style="width:${pct}%"></span></div>
        <span class="fin-budget-num">${pct}%</span>
      </div>
      <p class="hint">已用 ${fmtMoney(st.usedCents)} / ${fmtMoney(st.budgetCents)}</p>
    </div>`;
}

/** "2026-10" → "2026年10月" */
function monthCN(month) {
  const [y, m] = month.split("-").map(Number);
  return `${y}年${m}月`;
}

/** 右栏第二张：选中那天的一笔笔账（点一行就能改）。 */
function dayCard(txs) {
  const list = txs.filter((t) => t.date === selected).sort(byCreatedAt);
  if (!list.length) {
    return `
      <div class="card-head"><h2>当日明细</h2><span class="hint">${esc(dayLabel(selected))}</span></div>
      ${emptyState("这天还没记账", "右上角「记一笔」记上第一笔。", "", "money")}`;
  }
  const totals = dayTotals(txs, selected);
  return `
    <div class="card-head">
      <h2>当日明细</h2>
      <span class="hint">${esc(dayLabel(selected))}</span>
    </div>
    <div class="fin-day-sum">
      <span class="fin-amount expense">-${fmtMoney(totals.expenseCents)}</span>
      <span class="fin-amount income">+${fmtMoney(totals.incomeCents)}</span>
    </div>
    <ul class="items">${list.map(txRow).join("")}</ul>`;
}

function txRow(t) {
  const account = accountsOf().find((a) => a.id === t.accountId);
  const accountName = t.accountId ? (account ? account.name : "（账户已删）") : "";
  const note = t.note || t.category;
  return `
    <li class="item fin-row" data-id="${esc(t.id)}">
      <span class="fin-cat">${catIcon(t.type, t.category)}</span>
      <span class="i-title">${esc(note)}</span>
      ${accountName ? `<span class="i-meta">${esc(accountName)}</span>` : ""}
      <span class="fin-amount ${t.type === "income" ? "income" : "expense"}">
        ${t.type === "income" ? "+" : "-"}${fmtMoney(t.amountCents)}
      </span>
      <span class="i-actions">
        <button class="link" data-act="tx-edit">编辑</button>
        <button class="link danger" data-act="tx-del">删除</button>
      </span>
    </li>`;
}

/** 右栏第三张：账户列表。第一版只有名字，余额和转账是第二版的事。 */
function accountsCard() {
  const list = accountsOf();
  return `
    <div class="card-head">
      <h2>账户</h2>
      <span class="hint">共 ${list.length} 个</span>
    </div>
    <form class="add-form" id="add-account" autocomplete="off">
      <input name="name" class="grow" maxlength="20" required placeholder="微信 / 支付宝 / 银行卡…">
      <button class="btn primary" type="submit">添加</button>
    </form>
    ${
      list.length
        ? `<ul class="items">${list.map(accountRow).join("")}</ul>`
        : emptyState("还没有账户", "加一个之后，记一笔时就能选它了。", "", "money")
    }`;
}

function accountRow(a) {
  if (a.id === editingAccount) {
    return `
      <li class="item editing" data-id="${esc(a.id)}">
        <input data-field="name" class="grow" maxlength="20" value="${esc(a.name)}">
        <button class="btn primary small" data-act="acc-save">保存</button>
        <button class="btn small" data-act="acc-cancel">取消</button>
      </li>`;
  }
  const used = table("finance.transactions").filter((t) => t.accountId === a.id).length;
  return `
    <li class="item" data-id="${esc(a.id)}">
      <span class="i-title">${esc(a.name)}</span>
      <span class="i-meta">${used ? `${used} 笔账在用它` : "还没用过"}</span>
      <span class="i-actions">
        <button class="link" data-act="acc-edit">改名</button>
        <button class="link danger" data-act="acc-del">删除</button>
      </span>
    </li>`;
}

/** 弹窗里的表单。类型切换、分类格子都是按钮 —— 用 data-act 由弹窗自己
 *  的 click 处理，不经过 bindFresh（弹窗挂在 body 上，不在 #view 里）。 */
function txFormHtml(v, type, f) {
  const cats = (f.categories || {})[type] || [];
  const accounts = f.accounts || [];
  const accOpts = [
    ...(v.accountId && !accounts.some((a) => a.id === v.accountId)
      ? [`<option value="${esc(v.accountId)}" selected>（账户已删）</option>`]
      : []),
    ...accounts.map(
      (a) => `<option value="${esc(a.id)}"${a.id === v.accountId ? " selected" : ""}>${esc(a.name)}</option>`
    ),
  ].join("");
  return `
    <div class="fin-tabs">
      <button type="button" class="fin-tab${type === "expense" ? " active" : ""}" data-act="tx-type" data-type="expense">支出</button>
      <button type="button" class="fin-tab${type === "income" ? " active" : ""}" data-act="tx-type" data-type="income">收入</button>
    </div>
    <label class="fin-label" for="tx-amount">金额</label>
    <div class="fin-amount-input"><i>¥</i>
      <input id="tx-amount" type="text" inputmode="decimal" maxlength="12" placeholder="0.00" value="${esc(v.amount)}">
    </div>
    <div class="fin-two">
      <div>
        <label class="fin-label" for="tx-date">日期</label>
        <input id="tx-date" type="date" value="${esc(v.date)}">
      </div>
      <div>
        <label class="fin-label" for="tx-account">账户</label>
        <select id="tx-account">${accOpts || `<option value="">（还没建账户）</option>`}</select>
      </div>
    </div>
    <label class="fin-label">分类</label>
    <div class="fin-cats">
      ${cats
        .map(
          (c) => `<button type="button" class="fin-cat-pick${c === v.category ? " active" : ""}"
                    data-act="tx-cat" data-cat="${esc(c)}">
                    <span>${catIcon(type, c)}</span>${esc(c)}</button>`
        )
        .join("")}
    </div>
    <label class="fin-label" for="tx-note">备注</label>
    <input id="tx-note" type="text" maxlength="60" placeholder="比如：午饭 黄焖鸡" value="${esc(v.note)}">`;
}

/** 打开「记一笔 / 改一笔」。传 tx 就是改，不传就是新增。 */
function openTxDialog(tx) {
  const editing = Boolean(tx);
  const f = finance();
  const type0 = editing ? tx.type : "expense";
  const v = editing
    ? {
        amount: centsToYuan(tx.amountCents), date: tx.date, category: tx.category,
        accountId: tx.accountId || "", note: tx.note || "",
      }
    : {
        amount: "", date: selected, category: "其他",
        accountId: (accountsOf()[0] || {}).id || "", note: "",
      };

  let type = type0;
  const dlg = openDialog({
    title: editing ? "改一笔" : "记一笔",
    bodyHtml: txFormHtml(v, type, f),
    buttons: [
      ...(editing ? [{ id: "delete", label: "删除", kind: "danger" }] : []),
      { id: "cancel", label: "取消" },
      { id: "save", label: "保存", kind: "primary" },
    ],
    onAction: (act, el) => {
      const read = () => ({
        amount: el.querySelector("#tx-amount").value,
        date: el.querySelector("#tx-date").value || selected,
        accountId: el.querySelector("#tx-account").value,
        note: el.querySelector("#tx-note").value.trim(),
      });

      // 类型切换和点分类是弹窗内部的按钮，不走 onAction（见下面那段 click），
      // 这里只会收到 save / cancel / delete 三个。
      if (act === "cancel") return true;
      if (act === "delete") {
        (async () => {
          const ok = await askConfirm({
            title: "删除这一笔？",
            message: `${tx.note || tx.category}\n\n会放进回收站。`,
            confirmLabel: "删除",
            danger: true,
          });
          if (!ok) return;
          moveToTrash("finance.transactions", tx, tx.note || tx.category);
          touch(true);
          toast("已移入回收站");
        })();
        return true;
      }
      if (act === "save") {
        const next = read();
        const cents = yuanToCents(next.amount);
        if (cents === null) {
          toast("金额要填一个正数，最多两位小数", "err");
          return false; // 留在弹窗里接着改
        }
        if (editing) {
          Object.assign(tx, {
            type, amountCents: cents, date: next.date, category: v.category,
            accountId: next.accountId, note: next.note,
          });
        } else {
          table("finance.transactions").push({
            id: uid(), type, amountCents: cents, date: next.date, category: v.category,
            accountId: next.accountId, note: next.note, createdAt: nowText(),
          });
        }
        selected = next.date; // 记完停在那一天，方便核对
        touch(true);
        toast(`已记一笔 ${fmtMoney(cents)}`);
        return true;
      }
    },
  });

  // 弹窗内部的交互（改类型、点分类）自己绑：openDialog 只认它自己的那几个按钮
  dlg.el.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    if (btn.dataset.act === "tx-type") {
      const before = {
        amount: dlg.el.querySelector("#tx-amount").value,
        date: dlg.el.querySelector("#tx-date").value,
        note: dlg.el.querySelector("#tx-note").value,
        accountId: dlg.el.querySelector("#tx-account").value,
      };
      type = btn.dataset.type;
      const cats = (f.categories || {})[type] || [];
      v.category = cats.includes(v.category) ? v.category : "其他";
      dlg.el.querySelector(".dlg-form").innerHTML = txFormHtml(
        { ...before, category: v.category }, type, f
      );
    } else if (btn.dataset.act === "tx-cat") {
      v.category = btn.dataset.cat;
      for (const b of dlg.el.querySelectorAll(".fin-cat-pick")) {
        b.classList.toggle("active", b.dataset.cat === v.category);
      }
    }
  });

  // 打开就聚焦金额，并全选（改一笔时通常是要改金额）
  const amount = dlg.el.querySelector("#tx-amount");
  setTimeout(() => {
    amount.focus();
    amount.select?.();
  }, 0);

  // 回车 = 保存。只在输入框里按回车才算——焦点要是在分类按钮上，
  // 回车应该是「选中这个分类」（按钮自己的默认行为），不该把人家的输入提交掉。
  dlg.el.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.target.tagName !== "INPUT") return;
    e.preventDefault();
    dlg.el.querySelector('[data-dlg-act="save"]')?.click();
  });
  return dlg;
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
        <section class="card" id="fin-overview">${overviewCard(txs)}</section>
        <section class="card" id="fin-day">${dayCard(txs)}</section>
        <section class="card" id="fin-accounts">${accountsCard()}</section>
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
    return;
  }

  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  const li = btn.closest("[data-id]");
  const id = li ? li.dataset.id : "";

  if (act === "add") {
    openTxDialog(null);
    return;
  }
  if (act === "tx-edit" || act === "tx-del") {
    const tx = table("finance.transactions").find((t) => t.id === id);
    if (!tx) return;
    if (act === "tx-edit") {
      openTxDialog(tx);
      return;
    }
    (async () => {
      const ok = await askConfirm({
        title: "删除这一笔？",
        message: `${tx.note || tx.category}\n\n会放进回收站，误删可以去「数据与设置」找回。`,
        confirmLabel: "删除",
        danger: true,
      });
      if (!ok) return;
      moveToTrash("finance.transactions", tx, tx.note || tx.category);
      touch(true);
      toast("已移入回收站");
    })();
    return;
  }

  if (act === "acc-edit") {
    editingAccount = id;
    redraw();
    return;
  }
  if (act === "acc-cancel") {
    editingAccount = null;
    redraw();
    return;
  }
  if (act === "acc-save") {
    const a = accountsOf().find((x) => x.id === id);
    if (!a) return;
    const name = li.querySelector('[data-field="name"]').value.trim();
    if (!name) {
      toast("名字不能是空的", "err");
      return;
    }
    a.name = name;
    editingAccount = null;
    touch(true);
    return;
  }
  if (act === "acc-del") {
    const a = accountsOf().find((x) => x.id === id);
    if (!a) return;
    const used = table("finance.transactions").filter((t) => t.accountId === a.id).length;
    (async () => {
      const ok = await askConfirm({
        title: `删除账户「${a.name}」？`,
        message: used
          ? `有 ${used} 笔账在用这个账户。删掉之后那些账还在，只是账户那一栏会显示「（账户已删）」。`
          : "会放进回收站。",
        confirmLabel: "删除",
        danger: true,
      });
      if (!ok) return;
      moveToTrash("finance.accounts", a, a.name);
      if (editingAccount === a.id) editingAccount = null;
      touch(true);
      toast("已移入回收站");
    })();
  }
}

function onSubmit(e) {
  if (e.target.id !== "add-account") return;
  e.preventDefault();
  const name = e.target.name.value.trim();
  if (!name) return;
  table("finance.accounts").push({ id: uid(), name, initialBalanceCents: 0 });
  touch(true);
  toast("账户已添加");
}

function onChange(e) {
  if (e.target.id !== "budget-input") return;
  const text = e.target.value.trim();
  const cents = text === "" ? 0 : yuanToCents(text);
  if (cents === null) {
    toast("预算要填一个正数，最多两位小数", "err");
    redraw(); // 重画一次，把填错的内容恢复成原来那个数
    return;
  }
  budgetOf().monthlyTotalCents = cents;
  touch(true); // 立刻落盘；app.js 会重画整页，进度条跟着变
}
