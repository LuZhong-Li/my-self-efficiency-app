/* 记账：记一笔（支出 / 收入）、月历上看每天花了多少、当月概览与总预算、
 * 分类环形图、当日明细、一小份账户列表。
 *
 * 布局照设计文档走：左栏月历 + 环形图，右栏概览 / 明细 / 账户（方案乙）。
 * 计算全在 money.js 和 finance-calc.js 里，这个文件只管画和接事件。
 */

import { store, table, todayStr, nowText, uid, touch, esc, moveToTrash } from "./store.js";
import { pageHeader, bindFresh, emptyState, options } from "./ui.js";
import { icon } from "./icons.js";
import { askConfirm, toast, openDialog } from "./dialog.js";
import { monthGridHtml, calendarAction, currentMonth, showMonth, dayLabel } from "./calendar.js";
import { yuanToCents, centsToYuan, fmtMoney, fmtMoneyShort } from "./money.js";
import {
  monthKey, dayTotals, monthTotals, monthByDay, categoryTotals, overDays, budgetState, byCreatedAt,
  accountBalanceCents, balanceTotals, categoryBudgetStates, validateAccountInput,
} from "./finance-calc.js";
import { financeOf, accountsOf, budgetOf, catIcon, accountOptionsHtml } from "./finance-shared.js";
import { renderDebtPage, openDebtDialog } from "./debt.js";
import { splitBySettled } from "./debt-calc.js";

let selected = null; // 月历上选中的那天
let ringPick = null; // 环形图上点开的分类（展开明细用）
let ringType = "expense"; // 环形图看哪一头：expense / income

/** 左栏：月历。格子里画当天的支出（红）和收入（绿），超支的日子套一圈红边。 */
function calendarCard(txs) {
  const month = currentMonth();
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
      // 收入在上、支出在下；缩写（1.2k）之外，悬浮时给出完整金额
      const lines = [];
      if (d.incomeCents) lines.push({ text: "+" + fmtMoneyShort(d.incomeCents), tone: "income" });
      if (d.expenseCents) lines.push({ text: "-" + fmtMoneyShort(d.expenseCents), tone: "expense" });
      const detail = [
        d.expenseCents ? `支出 ${fmtMoney(d.expenseCents)}` : "",
        d.incomeCents ? `收入 ${fmtMoney(d.incomeCents)}` : "",
      ].filter(Boolean).join(" · ");
      return { lines, over: isOver, title: `${dayLabel(date)} · ${detail}` };
    },
  });
}

/** 右栏第一张：本月支出 / 收入 / 结余 + 月度总预算进度条。 */
function overviewCard(txs) {
  const month = currentMonth();
  const totals = monthTotals(txs, month);
  const st = budgetState(totals.expenseCents, budgetOf().monthlyTotalCents);
  const balanceTone = totals.balanceCents < 0 ? "expense" : "income";
  const accounts = accountsOf();
  const bt = balanceTotals(accounts, txs);
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
      ${
        accounts.length
          ? `<div class="fin-sum-item fin-total">
               <span>账户总余额 <small>含期初</small></span>
               <strong class="fin-amount ${bt.totalCents < 0 ? "expense" : "income"}">${fmtMoney(bt.totalCents)}</strong>
             </div>`
          : ""
      }
    </div>
    <p class="fin-note">本月结余 = 本月收入 − 本月支出；账户总余额 = 期初 + 全部历史收支。</p>
    ${budgetBlock(st)}
    ${categoryBudgetBlock(txs)}
  `;
}

/** 本月概览里的分类预算：设了预算的分类各一条进度条，下面跟着一个设预算的小表单。
 *  超支只影响这一条（红），月历上的「超支日」还是按月度总预算算的。 */
function categoryBudgetBlock(txs) {
  const f = financeOf();
  const rows = categoryBudgetStates(txs, currentMonth(), budgetOf().categoryCents);
  const cats = ((f.categories || {}).expense || []).slice();
  return `
    <div class="fin-catbudget">
      <div class="fin-catbudget-head">分类预算</div>
      ${
        rows.length
          ? `<ul class="fin-catbudget-list">${rows.map(catBudgetRow).join("")}</ul>`
          : `<p class="hint">还没设分类预算。给餐饮、交通这类单独定个上限，超了它自己会标红。</p>`
      }
      <form class="add-form" id="add-cat-budget" autocomplete="off">
        <select name="category" title="分类">${options(cats)}</select>
        <input name="amount" inputmode="decimal" maxlength="10" placeholder="预算金额">
        <button class="btn small" type="submit">设预算</button>
      </form>
    </div>`;
}

function catBudgetRow(r) {
  const pct = Math.round(Math.min(1, r.ratio) * 100);
  const tail = r.level === "over"
    ? `<i class="over">超 ${fmtMoney(r.usedCents - r.budgetCents)}</i>`
    : `${pct}%`;
  return `
    <li class="fin-catbudget-item">
      <span class="fin-catbudget-name">${catIcon("expense", r.category)} ${esc(r.category)}</span>
      <span class="fin-catbudget-used">${fmtMoney(r.usedCents)} / ${fmtMoney(r.budgetCents)} · ${tail}</span>
      <button class="link danger" data-act="catbudget-del" data-cat="${esc(r.category)}">移除</button>
      <span class="progress-track fin-catbudget-bar">
        <span class="lv-${r.level}" style="width:${pct}%"></span>
      </span>
    </li>`;
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
  const overText = st.level === "over" ? `已超支 ${fmtMoney(st.usedCents - st.budgetCents)}` : `${pct}%`;
  return `
    <div class="fin-budget">
      ${head}
      <div class="fin-budget-bar">
        <div class="progress-track"><span class="lv-${st.level}" style="width:${pct}%"></span></div>
        <span class="fin-budget-num${st.level === "over" ? " over" : ""}">${overText}</span>
      </div>
      <p class="hint">已用 ${fmtMoney(st.usedCents)} / ${fmtMoney(st.budgetCents)}</p>
    </div>`;
}

/** "2026-10" → "2026年10月" */
function monthCN(month) {
  const [y, m] = month.split("-").map(Number);
  return `${y}年${m}月`;
}

/* 环形图的配色：跟月历圆点一样，是一小组固定的低饱和色。
 * 不放进 CSS 变量是因为 SVG 的 stroke 要一条一条上色，塞变量反而更绕。 */
const RING_COLORS = ["#5f7fe0", "#8b7cf0", "#34a884", "#dfa24b", "#429ed4", "#dd8a52", "#c86b8a", "#9aa6bb"];

/** 左栏第二张：本月支出（或收入）按分类的环形图 + 图例；
 *  点某一类展开它的明细，再点收起。 */
function ringCard(txs) {
  const month = currentMonth();
  const cats = categoryTotals(txs, month, ringType);
  const isIncome = ringType === "income";
  const head = `
    <div class="card-head"><h2>分类占比</h2><span class="hint">${esc(monthCN(month))}</span></div>
    <div class="fin-ring-tabs">
      <button class="fin-tab${isIncome ? "" : " active"}" data-act="ring-type" data-type="expense">支出</button>
      <button class="fin-tab${isIncome ? " active" : ""}" data-act="ring-type" data-type="income">收入</button>
    </div>`;
  if (!cats.length) {
    return `${head}${emptyState(
      isIncome ? "这个月还没有收入" : "这个月还没有支出",
      isIncome ? "记一笔收入，这里就会出现占比。" : "记一笔支出，这里就会出现占比。",
      "", "money")}`;
  }

  const total = cats.reduce((sum, c) => sum + c.cents, 0);
  const R = 52;
  const C = 2 * Math.PI * R;
  let acc = 0;
  const arcs = cats
    .map((c, i) => {
      const len = c.ratio * C;
      // 点了图例就把那一段加粗，其余压暗一点
      const cls = ringPick ? (c.category === ringPick ? " active" : " dim") : "";
      const seg = `<circle cx="60" cy="60" r="${R}" fill="none"
        class="ring-seg${cls}" stroke="${RING_COLORS[i % RING_COLORS.length]}" stroke-width="16"
        stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-acc}"
        transform="rotate(-90 60 60)"></circle>`;
      acc += len;
      return seg;
    })
    .join("");

  const picked = cats.find((c) => c.category === ringPick);
  const pickedList = picked
    ? txs
        .filter((t) => t.type === ringType && monthKey(t.date) === month && t.category === picked.category)
        .sort(byCreatedAt)
    : [];

  return `
    ${head}
    <div class="fin-ring-wrap">
      <svg class="fin-ring" viewBox="0 0 120 120" width="132" height="132" role="img"
           aria-label="本月${isIncome ? "收入" : "支出"}按分类占比">
        ${arcs}
        <text class="fin-ring-label" x="60" y="53" text-anchor="middle">${isIncome ? "总收入" : "总支出"}</text>
        <text class="fin-ring-total" x="60" y="68" text-anchor="middle">${fmtMoney(total)}</text>
      </svg>
      <ul class="fin-legend">
        ${cats
          .map(
            (c, i) => `<li class="fin-legend-item${c.category === ringPick ? " active" : ""}">
              <button class="fin-legend-btn" data-act="ring-pick" data-cat="${esc(c.category)}">
                <i class="fin-dot" style="background:${RING_COLORS[i % RING_COLORS.length]}"></i>
                <span class="fin-legend-name">${catIcon(ringType, c.category)} ${esc(c.category)}</span>
                <span class="fin-legend-num">${fmtMoney(c.cents)}</span>
                <span class="fin-legend-pct">${Math.round(c.ratio * 100)}%</span>
              </button>
              <span class="fin-legend-bar"><i style="width:${Math.round(c.ratio * 100)}%;background:${RING_COLORS[i % RING_COLORS.length]}"></i></span>
            </li>`
          )
          .join("")}
      </ul>
    </div>
    ${
      picked
        ? `<div class="fin-ring-detail">
             <div class="list-head"><span>${esc(picked.category)} 本月 ${pickedList.length} 笔</span>
               <span class="hint">${fmtMoney(picked.cents)}</span></div>
             <ul class="items">
               ${pickedList
                 .map(
                   (t) => `<li class="item fin-row" data-id="${esc(t.id)}">
                     <span class="i-meta">${esc(t.date.slice(5))}</span>
                     <span class="i-title">${esc(t.note || t.category)}</span>
                     <span class="fin-amount ${isIncome ? "income" : "expense"}">${isIncome ? "+" : "-"}${fmtMoney(t.amountCents)}</span>
                   </li>`
                 )
                 .join("")}
             </ul>
           </div>`
        : ""
    }`;
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
    <li class="item fin-row ${t.type === "income" ? "is-income" : "is-expense"}" data-id="${esc(t.id)}">
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

/** 右栏第三张：账户列表。余额是实时算出来的（期初 + 该账户的收支），
 *  不存字段——账目是唯一的可信来源。 */
function accountsCard(txs) {
  const list = accountsOf();
  const bt = balanceTotals(list, txs);
  // 删账户时整条记录连同 row 一起挪进了回收站，所以名字和期初都还在，
  // 能在这里把它们单独收成一组「已归档账户」。
  const archived = (store.data.trash || []).filter((e) => e.table === "finance.accounts" && e.row);
  return `
    <div class="card-head">
      <h2>账户</h2>
      <div class="card-tools">
        <span class="hint">共 ${list.length} 个</span>
        <button class="btn primary small" data-act="acc-add">${icon("plus", 14)}添加账户</button>
      </div>
    </div>
    ${
      list.length
        ? `<ul class="items">${list.map((a) => accountRow(a, txs)).join("")}</ul>`
        : emptyState("还没有账户", "加一个之后，记一笔时就能选它了。", "", "money")
    }
    ${
      archived.length
        ? `<details class="fin-archive">
             <summary>已归档账户 · ${archived.length} 个 · 合计 ${fmtMoney(bt.deletedCents)}</summary>
             <ul class="items">
               ${archived
                 .map(
                   (e) => `<li class="item fin-acc fin-acc-archived">
                     <span class="fin-acc-name">${esc(e.row.name || e.label || "（没写名字）")}</span>
                     <span class="fin-acc-sub">余额 ${fmtMoney(accountBalanceCents(e.row, txs))}
                       · ${txs.filter((t) => t.accountId === e.row.id).length} 笔账
                       · ${esc(e.deletedAt || "")} 删除</span>
                   </li>`
                 )
                 .join("")}
             </ul>
             <p class="fin-help">它们的账目还在（明细里显示「（账户已删）」），余额也照样算进「账户总余额」。</p>
           </details>`
        : ""
    }`;
}

function accountRow(a, txs) {
  const mine = txs.filter((t) => t.accountId === a.id);
  const balance = accountBalanceCents(a, txs);
  return `
    <li class="item fin-acc" data-id="${esc(a.id)}">
      <span class="fin-acc-name">${esc(a.name)}</span>
      <span class="fin-acc-sub">
        <span class="fin-amount ${balance < 0 ? "warn" : ""}">余额 ${fmtMoney(balance)}</span>
        · 共 ${mine.length} 笔账
      </span>
      <span class="i-actions">
        <button class="link" data-act="acc-edit">编辑</button>
        <button class="link danger" data-act="acc-del">删除</button>
      </span>
    </li>`;
}

/** 添加 / 编辑账户的弹窗表单（两处共用一套）。只有两个字段：
 *  名字（必填）+ 期初余额（可留空，按 0 算）。 */
function accountFormHtml(v) {
  return `
    <label class="fin-label" for="acc-name">账户名称</label>
    <input id="acc-name" type="text" maxlength="20" autocomplete="off"
           placeholder="微信 / 支付宝 / 银行卡 / 现金" value="${esc(v.name)}">
    <p class="fin-err" id="acc-name-err" hidden></p>
    <label class="fin-label" for="acc-init">期初余额（可留空）</label>
    <div class="fin-amount-input fin-init-input"><i>¥</i>
      <input id="acc-init" type="text" inputmode="decimal" maxlength="12"
             placeholder="0.00，留空按 0 记" value="${esc(v.init)}">
    </div>
    <p class="fin-err" id="acc-init-err" hidden></p>
    <p class="fin-help">期初余额 = 开始记账前这个账户已有的钱。改它不会动你已经录入的账目。</p>`;
}

/** 打开「添加账户 / 编辑账户」。传 account 就是编辑，不传就是新增。
 *
 *  和「记一笔」一个规矩：Esc 关、点遮罩关、Tab 在弹窗里绕圈、回车保存。
 *  不一样的地方是校验：错误写在字段下面（不飘走的 toast），
 *  填对之前「保存」是灰的。 */
function openAccountDialog(account) {
  const editing = Boolean(account);
  const selfId = editing ? account.id : "";
  const dlg = openDialog({
    title: editing ? "编辑账户" : "添加账户",
    bodyHtml: accountFormHtml({
      name: editing ? account.name : "",
      // 新增时留空：占位提示写着「留空按 0 记」，比预填一个 0.00 更省事
      init: editing ? centsToYuan(account.initialBalanceCents || 0) : "",
    }),
    buttons: [
      { id: "cancel", label: "取消" },
      { id: "save", label: "保存", kind: "primary" },
    ],
    onAction: (act, el) => {
      if (act !== "save") return true;
      const res = check();
      paint(res, { all: true });
      if (!res.ok) return false; // 留在弹窗里接着改
      if (editing) {
        // 只动名字和期初；历史账目一笔都不碰，余额是实时算出来的
        account.name = res.name;
        account.initialBalanceCents = res.initCents;
      } else {
        table("finance.accounts").push({
          id: uid(), name: res.name, initialBalanceCents: res.initCents,
        });
      }
      touch(true);
      toast(editing ? "账户已更新" : "账户已添加");
      return true;
    },
  });

  const nameEl = dlg.el.querySelector("#acc-name");
  const initEl = dlg.el.querySelector("#acc-init");
  const saveBtn = dlg.el.querySelector('[data-dlg-act="save"]');
  const touched = { name: false, init: false };

  function check() {
    return validateAccountInput({
      name: nameEl.value, initText: initEl.value, accounts: accountsOf(), selfId,
    });
  }

  // 错误只写在字段底下；没碰过的字段先不报错，免得一打开就红一片。
  // 「保存」灰不灰按整体校验来，跟单字段有没有碰过无关。
  function paint(res, { all = false } = {}) {
    for (const [errSel, inputSel, msg, seen] of [
      ["#acc-name-err", "#acc-name", res.nameErr, touched.name],
      ["#acc-init-err", "#acc-init", res.initErr, touched.init],
    ]) {
      const box = dlg.el.querySelector(errSel);
      const input = dlg.el.querySelector(inputSel);
      const text = all || seen ? msg : "";
      box.textContent = text;
      box.hidden = !text;
      if (text) input.setAttribute("aria-invalid", "true");
      else input.removeAttribute("aria-invalid");
    }
    saveBtn.disabled = !res.ok;
  }

  for (const [el, field] of [[nameEl, "name"], [initEl, "init"]]) {
    el.addEventListener("input", () => {
      touched[field] = true;
      paint(check());
    });
  }
  paint(check());

  // 打开就聚焦名字框并全选（编辑时多半是要改名）
  setTimeout(() => {
    nameEl.focus();
    nameEl.select?.();
  }, 0);

  // 回车 = 保存。只在输入框里按回车才算，跟「记一笔」一样
  dlg.el.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.target.tagName !== "INPUT") return;
    e.preventDefault();
    if (!saveBtn.disabled) saveBtn.click();
  });
  return dlg;
}

/** 弹窗里的表单。类型切换、分类格子都是按钮 —— 用 data-act 由弹窗自己
 *  的 click 处理，不经过 bindFresh（弹窗挂在 body 上，不在 #view 里）。 */
function txFormHtml(v, type, f) {
  const cats = (f.categories || {})[type] || [];
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
        <select id="tx-account">${accountOptionsHtml(v.accountId)}</select>
      </div>
    </div>
    <p class="fin-help">账户之间转钱暂时不能记，只能手动记一笔「A 账户支出」+ 一笔「B 账户收入」。</p>
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
  const f = financeOf();
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
        // 返回 false：确认框已经接管了这里，外层别再关一次（否则确认框一闪就没）
        return false;
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
        showMonth(monthKey(next.date)); // 补记到别的月份时，日历跟着翻过去
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

export function renderFinance(root, sub = "") {
  const onDebt = sub === "debt";
  if (!selected) selected = todayStr();
  const txs = table("finance.transactions");
  const unsettled = splitBySettled(table("debt.items"), todayStr()).open.length;

  root.innerHTML = `
    ${pageHeader(
      "finance",
      onDebt
        ? `<button class="btn primary" data-act="debt-add">${icon("plus", 16)}加一笔债务</button>`
        : `<button class="btn primary" data-act="add">${icon("plus", 16)}记一笔</button>`
    )}
    <div class="fin-subtabs">
      <a class="fin-subtab${onDebt ? "" : " active"}" href="#finance">${icon("list", 16)}账目记录</a>
      <a class="fin-subtab${onDebt ? " active" : ""}" href="#finance/debt">${icon("debt", 16)}债务欠款${
        unsettled ? `<span class="fin-badge">${unsettled}</span>` : ""
      }</a>
    </div>
    ${
      onDebt
        ? `<div id="debt-host"></div>`
        : `<div class="fin-layout">
             <div class="fin-main">
               <section class="card" id="fin-calendar">${calendarCard(txs)}</section>
               <section class="card" id="fin-ring">${ringCard(txs)}</section>
             </div>
             <div class="fin-side">
               <section class="card" id="fin-overview">${overviewCard(txs)}</section>
               <section class="card" id="fin-day">${dayCard(txs)}</section>
               <section class="card" id="fin-accounts">${accountsCard(txs)}</section>
             </div>
           </div>`
    }
  `;

  if (onDebt) {
    renderDebtPage(root.querySelector("#debt-host"));
    // 页头那个「加一笔债务」在 #debt-host 外面，所以在这里接一下
    bindFresh(root, {
      click: (e) => {
        if (e.target.closest('[data-act="debt-add"]')) openDebtDialog(null);
      },
    });
    return;
  }
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

  if (act === "ring-pick") {
    ringPick = ringPick === btn.dataset.cat ? null : btn.dataset.cat;
    redraw();
    return;
  }
  if (act === "ring-type") {
    ringType = btn.dataset.type;
    ringPick = null; // 换了一头，之前点开的那个分类就不在了
    redraw();
    return;
  }

  if (act === "catbudget-del") {
    const cat = btn.dataset.cat;
    const b = budgetOf();
    if (b.categoryCents) delete b.categoryCents[cat];
    touch(true);
    toast(`已移除「${cat}」的分类预算`);
    return;
  }

  if (act === "acc-add") {
    openAccountDialog(null);
    return;
  }
  if (act === "acc-edit") {
    const a = accountsOf().find((x) => x.id === id);
    if (a) openAccountDialog(a);
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
      touch(true);
      toast("已移入回收站");
    })();
  }
}

function onSubmit(e) {
  if (e.target.id !== "add-cat-budget") return;
  e.preventDefault();
  const amount = yuanToCents(e.target.amount.value);
  if (amount === null) {
    toast("分类预算要填一个正数，最多两位小数", "err");
    return;
  }
  const cat = e.target.category.value;
  const b = budgetOf();
  if (!b.categoryCents || typeof b.categoryCents !== "object") b.categoryCents = {};
  b.categoryCents[cat] = amount;
  touch(true);
  toast(`已设「${cat}」预算 ${fmtMoney(amount)}`);
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
