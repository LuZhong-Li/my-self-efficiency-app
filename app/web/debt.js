/* 债务欠款：记账模块里的子页面。
 * 布局和账目记录一样是双栏（左月历、右总览 + 列表），共用 .fin-layout 那套宽度规则。 */

import { table, todayStr, nowText, uid, touch, esc, moveToTrash } from "./store.js";
import { bindFresh, emptyState } from "./ui.js";
import { askConfirm, toast, openDialog } from "./dialog.js";
import { yuanToCents, centsToYuan, fmtMoney } from "./money.js";
import { financeOf, accountOptionsHtml } from "./finance-shared.js";
import { remainCents, isSettled, dueState, daysUntil, splitBySettled } from "./debt-calc.js";

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
        <section class="card" id="debt-list">${debtListCard(open, done)}</section>
      </div>
    </div>
  `;

  bindFresh(root, { click: onClick, submit: onSubmit });
}

/** 债务列表：未结清在上（按到期日近的在前），已结清折叠在下面。 */
function debtListCard(open, done) {
  return `
    <div class="card-head">
      <h2>债务列表</h2>
      <span class="hint">未结清 ${open.length} 笔${done.length ? ` · 已结清 ${done.length} 笔` : ""}</span>
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
    bodyHtml: debtFormHtml(v, type),
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
    dlg.el.querySelector(".dlg-form").innerHTML = debtFormHtml({ ...keep, type }, type);
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

function redraw() {
  renderDebtPage(document.getElementById("debt-host"));
}

function onClick(e) {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  const li = btn.closest("[data-id]");
  const id = li ? li.dataset.id : "";
  const item = table("debt.items").find((x) => x.id === id);

  if (act === "debt-edit") { if (item) openDebtDialog(item); return; }
}

function onSubmit() {}
