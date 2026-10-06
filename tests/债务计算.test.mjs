/* 债务模块的纯逻辑测试。
 * 跑法：node tests\债务计算.test.mjs   （本机 Node v24，不需要 package.json） */

import {
  remainCents, isSettled, daysUntil, dueState, totals, upcoming, splitBySettled,
} from "../app/web/debt-calc.js";

let pass = 0;
let fail = 0;

function eq(actual, expected, label) {
  if (actual === expected) { pass++; console.log("  ok   " + label); }
  else {
    fail++;
    console.log("  FAIL " + label + "：期望 " + JSON.stringify(expected) +
      "，实际 " + JSON.stringify(actual));
  }
}

function deep(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deep(a[k], b[k]));
}

function eqDeep(actual, expected, label) {
  if (deep(actual, expected)) { pass++; console.log("  ok   " + label); }
  else {
    fail++;
    console.log("  FAIL " + label + "：期望 " + JSON.stringify(expected) +
      "，实际 " + JSON.stringify(actual));
  }
}

const TODAY = "2026-10-07";

const HUABEI = {
  id: "d1", name: "花呗", type: "oweOthers", totalCents: 350000,
  creditor: "支付宝", dueDate: "2026-10-20", note: "", status: "pending",
  repayments: [{ date: "2026-09-20", amountCents: 230000, txId: "tx-1" }],
};
const LEND = {
  id: "d2", name: "借给同事", type: "othersOweMe", totalCents: 80000,
  creditor: "小张", dueDate: "2026-11-05", note: "", status: "pending", repayments: [],
};
const OLD = {
  id: "d3", name: "旧账", type: "oweOthers", totalCents: 10000,
  creditor: "", dueDate: "2026-09-01", note: "", status: "done",
  repayments: [{ date: "2026-08-30", amountCents: 10000, txId: "" }],
};
const SOON = {
  id: "d4", name: "信用卡", type: "oweOthers", totalCents: 50000,
  creditor: "招行", dueDate: "2026-10-10", note: "", status: "pending", repayments: [],
};
const LATE = {
  id: "d5", name: "欠朋友", type: "oweOthers", totalCents: 20000,
  creditor: "老王", dueDate: "2026-10-01", note: "", status: "pending", repayments: [],
};
const ALL = [HUABEI, LEND, OLD, SOON, LATE];

console.log("debt-calc.js：");
eq(remainCents(HUABEI), 120000, "剩余 = 总额 − 已还（3500 − 2300）");
eq(remainCents(LEND), 80000, "没还过就是总额");
eq(remainCents({ totalCents: 10000 }), 10000, "结构缺字段也不炸");
eq(remainCents(OLD), 0, "还完了剩余是 0");

eq(isSettled(HUABEI), false, "还有剩余就是没结清");
eq(isSettled(OLD), true, "手动标 done 就是结清");
eq(isSettled({ totalCents: 0, status: "pending", repayments: [] }), true, "剩余 0 也算结清");

eq(daysUntil("2026-10-20", TODAY), 13, "到期还有 13 天");
eq(daysUntil("2026-10-07", TODAY), 0, "今天到期是 0");
eq(daysUntil("2026-10-01", TODAY), -6, "已经过了 6 天");
eq(daysUntil("", TODAY), null, "没填到期日返回 null");
eq(daysUntil("2026-11-05", "2026-10-31"), 5, "跨月也算得对");

eq(dueState(OLD, TODAY), "done", "结清了就是 done");
eq(dueState(LATE, TODAY), "overdue", "过了日子还没还 → overdue");
eq(dueState(SOON, TODAY), "soon", "3 天后到期 → soon");
eq(dueState(HUABEI, TODAY), "normal", "13 天后到期 → normal");
eq(dueState({ status: "pending", totalCents: 1000, dueDate: "" }, TODAY), "none", "没到期日 → none");

eqDeep(totals(ALL), { oweCents: 190000, owedCents: 80000, netCents: 110000 },
  "合计只算未结清：我欠 1200+500+200，别人欠我 800，净负债 1100");
eqDeep(totals([]), { oweCents: 0, owedCents: 0, netCents: 0 }, "一笔都没有时全是 0");

// 10-07 看：欠朋友 -6 天、信用卡 +3 天、花呗 +13 天、借给同事 +29 天
eqDeep(upcoming(ALL, TODAY, 30).map((it) => it.id), ["d5", "d4", "d1", "d2"],
  "30 天内到期的四笔：逾期的最前，然后按到期日排");
eqDeep(upcoming(ALL, TODAY, 3).map((it) => it.id), ["d5", "d4"],
  "3 天内：逾期那笔 + 刚好第 3 天那笔（边界是「小于等于」）");
eqDeep(upcoming(ALL, TODAY, 30).some((it) => it.id === "d3"), false, "结清的不进提醒");

const split = splitBySettled(ALL, TODAY);
eq(split.open.length, 4, "未结清 4 笔");
eq(split.done.length, 1, "已结清 1 笔");
eqDeep(split.open.map((it) => it.id), ["d5", "d4", "d1", "d2"], "未结清按到期日从近到远");

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
