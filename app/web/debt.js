/* 债务欠款：记账模块里的子页面。
 * 布局和账目记录一样是双栏（左月历、右总览 + 列表），共用 .fin-layout 那套宽度规则。 */

import { table, todayStr, nowText, uid, touch, esc, moveToTrash } from "./store.js";
import { bindFresh, emptyState } from "./ui.js";
import { askConfirm, toast, openDialog } from "./dialog.js";
import { yuanToCents, centsToYuan, fmtMoney, fmtMoneyShort } from "./money.js";
import { financeOf, accountOptionsHtml } from "./finance-shared.js";
import { monthGridHtml, calendarAction, dayLabel } from "./calendar.js";
import {
  remainCents, isSettled, dueState, daysUntil, totals, upcoming, splitBySettled,
} from "./debt-calc.js";

let selected = null; // 债务页月历上选中的那天

export function renderDebtPage(root) {
  if (!root) return;
  if (!selected) selected = todayStr();
  const items = table("debt.items");
  const { open, done } = splitBySettled(items, todayStr());
  const dueThatDay = items.filter((it) => !isSettled(it) && it.dueDate === selected);

  root.innerHTML = `
    <div class="fin-layout">
      <div class="fin-main">
        <section class="card" id="debt-calendar">${debtCalendarCard(items)}</section>
      </div>
      <div class="fin-side">
        <section class="card" id="debt-overview">${debtOverviewCard(items)}</section>
        <section class="card" id="debt-list">${debtListCard(open, done, dueThatDay)}</section>
      </div>
    </div>
  `;

  bindFresh(root, { click: onClick, submit: onSubmit });
}

/** 右栏第一张：我欠 / 别人欠我 / 净额 + 近 30 天到期。 */
function debtOverviewCard(items) {
  const today = todayStr();
  const t = totals(items);
  const soon = upcoming(items, today, 30);
  const netLabel = t.netCents >= 0 ? "净负债" : "净债权";
  return `
    <div class="card-head"><h2>债务总览</h2><span class="hint">只算没结清的</span></div>
    <div class="fin-sum">
      <div class="fin-sum-item"><span>我欠别人</span>
        <strong class="fin-amount expense">${fmtMoney(t.oweCents)}</strong></div>
      <div class="fin-sum-item"><span>别人欠我</span>
        <strong class="fin-amount income">${fmtMoney(t.owedCents)}</strong></div>
      <div class="fin-sum-item fin-total"><span>${netLabel}</span>
        <strong class="fin-amount ${t.netCents > 0 ? "expense" : "income"}">${fmtMoney(Math.abs(t.netCents))}</strong></div>
    </div>
    <div class="fin-catbudget">
      <div class="fin-catbudget-head">近 30 天到期</div>
      ${
        soon.length
          ? `<ul class="items">${soon
              .map((it) => {
                const state = dueState(it, today);
                const days = daysUntil(it.dueDate, today);
                const tag = state === "overdue"
                  ? `已逾期 ${-days} 天`
                  : days === 0 ? "今天到期" : `${days} 天后`;
                return `<li class="item fin-debt st-${state}" data-id="${esc(it.id)}">
                  <span class="fin-debt-name">${esc(it.name)}</span>
                  <span class="fin-debt-due">${esc(tag)} · 剩余 ${fmtMoney(remainCents(it))}</span>
                </li>`;
              })
              .join("")}</ul>`
          : `<p class="hint">30 天内没有要到期的。</p>`
      }
    </div>`;
}

/** 债务列表：未结清在上（按到期日近的在前），已结清折叠在下面。 */
function debtListCard(open, done, dueThatDay = []) {
  return `
    <div class="card-head">
      <h2>债务列表</h2>
      <span class="hint">${
        dueThatDay.length
          ? `${dayLabel(selected)} · 到期 ${dueThatDay.length} 笔`
          : `未结清 ${open.length} 笔${done.length ? ` · 已结清 ${done.length} 笔` : ""}`
      }</span>
    </div>
    ${
      open.length
        ? `<ul class="items">${open.map((it) => debtRow(it)).join("")}</ul>`
        : emptyState("没有待还的债务", "右上角「加一笔债务」记上第一笔。", "", "debt")
    }
    ${
      done.length
        ? `<details class="fin-archive">
             <summary>已结清 · ${done.length} 笔</summary>
             <ul class="items">${done.map((it) => debtRow(it)).join("")}</ul>
           </details>`
        : ""
    }`;
}

function debtRow(it) {
  const today = todayStr();
  const remain = remainCents(it);
  const state = dueState(it, today);
  const days = daysUntil(it.dueDate, today);
  const isIncome = it.type === "othersOweMe";
  const dueText =
    days === null ? "没填到期日"
      : state === "done" ? `到期 ${mdText(it.dueDate)}`
      : days < 0 ? `已逾期 ${-days} 天`
      : days === 0 ? "今天到期"
      : days <= 7 ? `${days} 天后到期`
      : `到期 ${mdText(it.dueDate)}`;
  return `
    <li class="item fin-debt st-${state}" data-id="${esc(it.id)}">
      <span class="fin-debt-name">${isIncome ? "💰" : "💳"} ${esc(it.name)}</span>
      <span class="fin-debt-type">${isIncome ? "别人欠我" : "我欠别人"}${it.creditor ? ` · ${esc(it.creditor)}` : ""}</span>
      <span class="fin-debt-remain">剩余 ${fmtMoney(remain)}</span>
      <span class="fin-debt-due">${esc(dueText)}</span>
      <span class="i-actions">
        <button class="link" data-act="debt-edit">编辑</button>
        <button class="link" data-act="debt-pay">记录还款</button>
        <button class="link" data-act="debt-settle">${isSettled(it) ? "恢复待还" : "结清"}</button>
      </span>
    </li>`;
}

/** "2026-10-20" → "10月20日" */
function mdText(date) {
  const [, m, d] = String(date).split("-").map(Number);
  return `${m}月${d}日`;
}

/** 新增或编辑一笔债务。传 item 就是改。
 *  「记录还款 / 结清」两个按钮和事件在 Task 6 补（那会儿才有对应的函数）。 */
export function openDebtDialog(item) {
  const editing = Boolean(item);
  const v = editing
    ? {
        type: item.type, name: item.name, total: centsToYuan(item.totalCents),
        creditor: item.creditor || "", dueDate: item.dueDate || "", note: item.note || "",
      }
    : { type: "oweOthers", name: "", total: "", creditor: "", dueDate: "", note: "" };

  let type = v.type;
  const dlg = openDialog({
    title: editing ? "改一笔债务" : "加一笔债务",
    bodyHtml: debtFormHtml(v, type) + (editing ? repaymentsHtml(item) : ""),
    buttons: [
      ...(editing ? [{ id: "delete", label: "删除", kind: "danger" }] : []),
      { id: "cancel", label: "取消" },
      { id: "save", label: "保存", kind: "primary" },
    ],
    onAction: (act, el) => {
      if (act === "cancel") return true;
      if (act === "delete") {
        (async () => {
          const ok = await askConfirm({
            title: `删除「${item.name}」？`,
            message: "会放进回收站；已经记过的还款账目不受影响。",
            confirmLabel: "删除", danger: true,
          });
          if (!ok) return;
          moveToTrash("debt.items", item, item.name);
          touch(true);
          toast("已移入回收站");
        })();
        return true;
      }
      if (act !== "save") return true;

      const read = () => ({
        name: el.querySelector("#debt-name").value.trim(),
        total: el.querySelector("#debt-total").value,
        creditor: el.querySelector("#debt-creditor").value.trim(),
        dueDate: el.querySelector("#debt-due").value,
        note: el.querySelector("#debt-note").value.trim(),
      });
      const next = read();
      if (!next.name) { toast("名称不能是空的", "err"); return false; }
      const totalCents = yuanToCents(next.total);
      if (totalCents === null) { toast("金额要填一个正数，最多两位小数", "err"); return false; }
      if (editing) {
        const paidCents = (item.repayments || []).reduce(
          (s, r) => s + (Number(r.amountCents) || 0), 0);
        if (totalCents < paidCents) {
          toast("总额不能小于已经还掉的金额", "err");
          return false;
        }
        Object.assign(item, {
          type, name: next.name, totalCents, creditor: next.creditor,
          dueDate: next.dueDate, note: next.note,
        });
        // 总额改了，状态跟着重算（剩余可能刚好变成 0）
        item.status = remainCents(item) <= 0 ? "done" : "pending";
      } else {
        table("debt.items").push({
          id: uid(), name: next.name, type, totalCents,
          creditor: next.creditor, dueDate: next.dueDate, note: next.note,
          status: "pending", repayments: [],
        });
      }
      touch(true);
      toast(editing ? "已保存" : "债务已添加");
      return true;
    },
  });

  dlg.el.addEventListener("click", (e) => {
    if (e.target.closest('[data-act="repay-del"]')) {
      const row = (item.repayments || [])[Number(e.target.closest("[data-index]").dataset.index)];
      if (!row) return;
      (async () => {
        const after = remainCents(item) + row.amountCents; // 删掉之后剩余会变成多少
        const ok = await askConfirm({
          title: "删除这笔还款记录？",
          message: `剩余金额将恢复 ${fmtMoney(after)}。\n\n对应的账目不会被删掉（账目是独立的记录）。`,
          confirmLabel: "删除", danger: true,
        });
        if (!ok) return;
        item.repayments.splice(item.repayments.indexOf(row), 1);
        item.status = remainCents(item) <= 0 ? "done" : "pending";
        touch(true);
        toast("已删除这条还款记录");
        redraw();
        openDebtDialog(item); // 重新打开，还款记录跟着刷新
      })();
      return;
    }
    const btn = e.target.closest('[data-act="debt-type"]');
    if (!btn) return;
    const keep = {
      name: dlg.el.querySelector("#debt-name").value,
      total: dlg.el.querySelector("#debt-total").value,
      creditor: dlg.el.querySelector("#debt-creditor").value,
      dueDate: dlg.el.querySelector("#debt-due").value,
      note: dlg.el.querySelector("#debt-note").value,
    };
    type = btn.dataset.type;
    dlg.el.querySelector(".dlg-form").innerHTML =
      debtFormHtml({ ...keep, type }, type) + (editing ? repaymentsHtml(item) : "");
  });
  setTimeout(() => dlg.el.querySelector("#debt-name").focus(), 0);
  return dlg;
}

function debtFormHtml(v, type) {
  return `
    <div class="fin-tabs">
      <button type="button" class="fin-tab${type === "oweOthers" ? " active" : ""}"
              data-act="debt-type" data-type="oweOthers">我欠别人</button>
      <button type="button" class="fin-tab${type === "othersOweMe" ? " active" : ""}"
              data-act="debt-type" data-type="othersOweMe">别人欠我</button>
    </div>
    <label class="fin-label" for="debt-name">名称</label>
    <input id="debt-name" type="text" maxlength="30" placeholder="花呗 / 借给同事的钱" value="${esc(v.name)}">
    <div class="fin-two">
      <div><label class="fin-label" for="debt-total">总金额</label>
        <input id="debt-total" inputmode="decimal" maxlength="12" placeholder="0.00" value="${esc(v.total)}"></div>
      <div><label class="fin-label" for="debt-due">到期日</label>
        <input id="debt-due" type="date" value="${esc(v.dueDate)}"></div>
    </div>
    <label class="fin-label" for="debt-creditor">${type === "othersOweMe" ? "谁欠我" : "欠谁的"}</label>
    <input id="debt-creditor" type="text" maxlength="30" placeholder="支付宝 / 小张" value="${esc(v.creditor)}">
    <label class="fin-label" for="debt-note">备注</label>
    <input id="debt-note" type="text" maxlength="60" placeholder="比如：每月 20 号还款" value="${esc(v.note)}">`;
}

/** 记录还款：一个动作做三件事——写还款记录、生成一笔账目、重算状态。
 *  债务只认自己的还款记录，那笔账目只是凭证（删了不影响债务）。 */
function openPayDialog(item) {
  const isIncome = item.type === "othersOweMe";
  const remain = remainCents(item);
  const dlg = openDialog({
    title: `${item.name} · ${isIncome ? "记录收款" : "记录还款"}`,
    bodyHtml: `
      <label class="fin-label" for="pay-amount">${isIncome ? "收到金额" : "还款金额"}</label>
      <div class="fin-amount-input"><i>¥</i>
        <input id="pay-amount" type="text" inputmode="decimal" maxlength="12" value="${centsToYuan(remain)}">
      </div>
      <div class="fin-two">
        <div><label class="fin-label" for="pay-date">日期</label>
          <input id="pay-date" type="date" value="${todayStr()}"></div>
        <div><label class="fin-label" for="pay-account">${isIncome ? "收到哪个账户" : "从哪个账户还"}</label>
          <select id="pay-account">${accountOptionsHtml("")}</select></div>
      </div>
      <label class="fin-label" for="pay-note">备注</label>
      <input id="pay-note" type="text" maxlength="60" value="${esc(item.name + (isIncome ? "收款" : "还款"))}">
      <p class="fin-help">保存后会${isIncome ? "记一笔收入" : "记一笔支出"}（分类「${isIncome ? "债务收款" : "债务还款"}」），
        留在账目记录里；之后删那笔账目不会影响这里的剩余金额。</p>`,
    buttons: [
      { id: "cancel", label: "取消" },
      { id: "save", label: isIncome ? "收下了" : "还了", kind: "primary" },
    ],
    onAction: (act, el) => {
      if (act !== "save") return true;
      const cents = yuanToCents(el.querySelector("#pay-amount").value);
      if (cents === null) { toast("金额要填一个正数，最多两位小数", "err"); return false; }
      const left = remainCents(item);
      if (cents > left) {
        toast(`最多还能${isIncome ? "收" : "还"} ${fmtMoney(left)}`, "err");
        return false;
      }
      recordRepayment(item, {
        amountCents: cents,
        date: el.querySelector("#pay-date").value || todayStr(),
        accountId: el.querySelector("#pay-account").value,
        note: el.querySelector("#pay-note").value.trim(),
      });
      return true;
    },
  });
  setTimeout(() => dlg.el.querySelector("#pay-amount").select?.(), 0);
  return dlg;
}

function recordRepayment(item, { amountCents, date, accountId, note }) {
  const isIncome = item.type === "othersOweMe";
  const tx = {
    id: uid(),
    type: isIncome ? "income" : "expense",
    amountCents,
    date,
    category: isIncome ? "债务收款" : "债务还款",
    accountId,
    note,
    createdAt: nowText(),
  };
  table("finance.transactions").push(tx);
  if (!Array.isArray(item.repayments)) item.repayments = [];
  item.repayments.push({ date, amountCents, txId: tx.id });
  item.status = remainCents(item) <= 0 ? "done" : "pending";
  touch(true);
  toast(`${isIncome ? "已收" : "已还"} ${fmtMoney(amountCents)}，${isIncome ? "记了一笔收入" : "记了一笔支出"}`);
}

/** 手动结清 / 恢复待还。结清不生成任何账目（本来就没钱流动）。 */
function toggleSettle(item) {
  const settled = isSettled(item);
  (async () => {
    const ok = await askConfirm(
      settled
        ? { title: `把「${item.name}」恢复成待还？`, message: "它会被挪回未结清那一组。", confirmLabel: "恢复" }
        : {
            title: `把「${item.name}」标记为已结清？`,
            message: "用在「这笔钱不用还了」这种时候——不会生成任何账目。",
            confirmLabel: "标记结清",
          }
    );
    if (!ok) return;
    item.status = settled ? "pending" : "done";
    touch(true);
    toast(settled ? "已恢复待还" : "已标记结清");
  })();
}

/** 编辑弹窗下半部分的还款记录。txId 有值但账目找不到时标一句。 */
function repaymentsHtml(item) {
  if (!item) return "";
  const list = item.repayments || [];
  const txIds = new Set(table("finance.transactions").map((t) => t.id));
  return `
    <div class="fin-repay">
      <div class="fin-catbudget-head">还款记录</div>
      ${
        list.length
          ? `<ul class="items">
               ${list
                 .map(
                   (r, i) => `<li class="item fin-repay-row" data-index="${i}">
                     <span class="i-title">${esc(r.date)} 还了 ${fmtMoney(r.amountCents)}</span>
                     ${r.txId && !txIds.has(r.txId) ? `<span class="i-meta">对应账目已删除</span>` : ""}
                     ${!r.txId ? `<span class="i-meta">没有对应账目</span>` : ""}
                     <span class="i-actions">
                       <button class="link danger" data-act="repay-del">删除</button>
                     </span>
                   </li>`
                 )
                 .join("")}
             </ul>`
          : `<p class="hint">还没还过。</p>`
      }
    </div>`;
}

/** 左栏：月历。只标没结清债务的到期日——那天一个红点，格子里写「到期 ¥350.00」。
 *  kinds 只给这一页用「到期」这一种，不改全站的 ALL_KINDS，别的页面图例一动不动。 */
function debtCalendarCard(items) {
  const live = items.filter((it) => !isSettled(it) && it.dueDate);
  const byDay = new Map();
  for (const it of live) {
    const cur = byDay.get(it.dueDate) || [];
    cur.push(it);
    byDay.set(it.dueDate, cur);
  }
  return monthGridHtml({
    selected,
    kinds: [["debt", "到期"]],
    marksOf: (date) => (byDay.has(date) ? [{ kind: "debt" }] : []),
    dayExtraOf: (date) => {
      const list = byDay.get(date);
      if (!list) return null;
      const sum = list.reduce((s, it) => s + remainCents(it), 0);
      return {
        lines: [{ text: `到期 ${fmtMoneyShort(sum)}`, tone: "expense" }],
        title: list.map((it) => `${it.name} ${fmtMoney(remainCents(it))}`).join(" · "),
      };
    },
  });
}

function redraw() {
  renderDebtPage(document.getElementById("debt-host"));
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
  const item = table("debt.items").find((x) => x.id === id);

  if (act === "debt-edit") { if (item) openDebtDialog(item); return; }
  if (act === "debt-pay") { if (item) openPayDialog(item); return; }
  if (act === "debt-settle") { if (item) toggleSettle(item); return; }
}

function onSubmit() {}
