/* 记账模块的纯逻辑测试：只测不碰 DOM 的那两个模块。
 * 跑法：node tests\记账计算.test.mjs   （本机 Node v24，不需要 package.json）
 * 说明：这个测试不进「自检.cmd」——自检是给用户一键跑的，保持纯 Python。 */

import { yuanToCents, yuanToCentsNonNeg, centsToYuan, fmtMoney, fmtMoneyShort } from "../app/web/money.js";
import {
  monthKey, daysInMonth, dayTotals, monthTotals, monthByDay,
  categoryTotals, budgetState, overDays, byCreatedAt,
  accountBalanceCents, balanceTotals,
} from "../app/web/finance-calc.js";

let pass = 0;
let fail = 0;

function eq(actual, expected, label) {
  if (actual === expected) {
    pass++;
    console.log("  ok   " + label);
  } else {
    fail++;
    console.log("  FAIL " + label + "：期望 " + JSON.stringify(expected) +
      "，实际 " + JSON.stringify(actual));
  }
}

/* 对象和数组不能用 === 比（比的是引用，永远不等），所以另给一个深比较。
 * 不引 assert 库：这个文件要能直接 node 跑起来，零依赖。 */
function deep(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deep(a[k], b[k]));
}

function eqDeep(actual, expected, label) {
  if (deep(actual, expected)) {
    pass++;
    console.log("  ok   " + label);
  } else {
    fail++;
    console.log("  FAIL " + label + "：期望 " + JSON.stringify(expected) +
      "，实际 " + JSON.stringify(actual));
  }
}

console.log("money.js：");
eq(yuanToCents("25.5"), 2550, "25.5 → 2550 分");
eq(yuanToCents("25.50"), 2550, "25.50 → 2550 分");
eq(yuanToCents("1000"), 100000, "1000 → 100000 分");
eq(yuanToCents("0.05"), 5, "0.05 → 5 分");
eq(yuanToCents("999999.99"), 99999999, "上限刚好收下");
eq(yuanToCents("0"), null, "0 不收");
eq(yuanToCents("0.00"), null, "0.00 不收");
eq(yuanToCents("1.234"), null, "三位小数不收");
eq(yuanToCents("1000000"), null, "超过上限不收");
eq(yuanToCents("-5"), null, "负数不收");
eq(yuanToCents("abc"), null, "非数字不收");
eq(yuanToCents(""), null, "空字符串不收");

eq(centsToYuan(2550), "25.50", "2550 → 25.50");
eq(centsToYuan(5), "0.05", "5 → 0.05");
eq(centsToYuan(100000), "1000.00", "100000 → 1000.00");

eq(fmtMoney(2550), "¥25.50", "带货币符号");
eq(fmtMoney(1234567), "¥12,345.67", "带千分位");
eq(fmtMoney(-2550), "-¥25.50", "负号在符号前面");

eq(fmtMoneyShort(2550), "25.50", "不足 1000 元给两位小数");
eq(fmtMoneyShort(300000), "3k", "3000 元 → 3k");
eq(fmtMoneyShort(125000), "1.2k", "1250 元 → 1.2k（截断，不四舍五入）");
eq(fmtMoneyShort(99900), "999.00", "差一分不到 1000 元，仍按原数显示");

// 期初余额允许 0（甚至必须能填 0），所以另有一个「允许 0」的解析
eq(yuanToCentsNonNeg("0"), 0, "期初余额可以填 0");
eq(yuanToCentsNonNeg("0.00"), 0, "0.00 也是 0");
eq(yuanToCentsNonNeg("1826.3"), 182630, "1826.3 → 182630 分");
eq(yuanToCentsNonNeg("999999.99"), 99999999, "上限照样收下");
eq(yuanToCentsNonNeg("1000000"), null, "超过上限不收");
eq(yuanToCentsNonNeg("-1"), null, "负数不收");
eq(yuanToCentsNonNeg("1.234"), null, "三位小数不收");
eq(yuanToCentsNonNeg("abc"), null, "非数字不收");

// 一份固定的小数据，所有断言都围着它
const TX = [
  { id: "a", type: "expense", amountCents: 2550, date: "2026-10-07", category: "餐饮", createdAt: "2026-10-07 12:30" },
  { id: "b", type: "expense", amountCents: 1200, date: "2026-10-07", category: "交通", createdAt: "2026-10-07 08:00" },
  { id: "c", type: "income",  amountCents: 300000, date: "2026-10-07", category: "工资", createdAt: "2026-10-07 09:00" },
  { id: "d", type: "expense", amountCents: 80000, date: "2026-10-12", category: "购物", createdAt: "2026-10-12 20:00" },
  { id: "e", type: "expense", amountCents: 5000, date: "2026-11-03", category: "餐饮", createdAt: "2026-11-03 12:00" },
];

console.log("\nfinance-calc.js：");
eq(monthKey("2026-10-07"), "2026-10", "取月份");
eq(daysInMonth("2026-10"), 31, "十月 31 天");
eq(daysInMonth("2026-02"), 28, "二月 28 天");
eq(daysInMonth("2024-02"), 29, "闰年二月 29 天");

eqDeep(dayTotals(TX, "2026-10-07"), { expenseCents: 3750, incomeCents: 300000 }, "某天收支合计");
eqDeep(dayTotals(TX, "2026-10-08"), { expenseCents: 0, incomeCents: 0 }, "没账的那天是 0");

eqDeep(monthTotals(TX, "2026-10"), { expenseCents: 83750, incomeCents: 300000, balanceCents: 216250 },
  "某月合计与结余（结余 = 收入 − 支出）");
eqDeep(monthTotals(TX, "2026-11"), { expenseCents: 5000, incomeCents: 0, balanceCents: -5000 },
  "只有支出的那个月结余是负的");

const byDay = monthByDay(TX, "2026-10");
eq(byDay.size, 2, "十月只有两天有账");
eqDeep(byDay.get("2026-10-07"), { expenseCents: 3750, incomeCents: 300000 }, "按天汇总");
eq(byDay.has("2026-11-03"), false, "别的月份不会混进来");

const cats = categoryTotals(TX, "2026-10");
eq(cats.length, 3, "十月三个支出分类");
eq(cats[0].category, "购物", "按金额降序，购物最多");
eq(Math.round(cats[0].ratio * 1000), 955, "占比 = 该类 ÷ 本月支出（800.00 / 837.50）");
eq(categoryTotals(TX, "2026-09").length, 0, "没账的月份是空数组");

eqDeep(budgetState(0, 0), { usedCents: 0, budgetCents: 0, ratio: 0, level: "none" }, "没设预算");
eq(budgetState(50000, 200000).level, "ok", "用了 25% → ok");
eq(budgetState(160000, 200000).level, "warn", "用了 80% → warn");
eq(budgetState(200000, 200000).level, "warn", "刚好 100% 还是 warn");
eq(budgetState(200001, 200000).level, "over", "超一分钱就是 over");
eq(budgetState(50000, 200000).ratio, 0.25, "ratio 不封顶，交给画的时候 Math.min");

eqDeep([...overDays(TX, "2026-10", 50000)], ["2026-10-12"],
  "累计超预算之后、还有支出的那天才算超支");
eq([...overDays(TX, "2026-10", 0)].length, 0, "没设预算就没有超支日");
eq([...overDays(TX, "2026-10", 1000000)].length, 0, "预算够花就没有超支日");

const shuffled = [TX[2], TX[0], TX[1]];
eqDeep(shuffled.slice().sort(byCreatedAt).map((t) => t.id), ["b", "c", "a"], "按记入时间从早到晚");

// 账户余额：期初 + 收入 − 支出（实时算，不存）
const ACC = [
  { id: "a1", name: "微信", initialBalanceCents: 100000 },
  { id: "a2", name: "银行卡", initialBalanceCents: 0 },
  { id: "a3", name: "现金", initialBalanceCents: 0 },
];
const ACC_TX = [
  { id: "x1", type: "expense", amountCents: 2550, date: "2026-10-07", category: "餐饮", accountId: "a1" },
  { id: "x2", type: "income", amountCents: 300000, date: "2026-10-07", category: "工资", accountId: "a1" },
  { id: "x3", type: "expense", amountCents: 80000, date: "2026-10-12", category: "购物", accountId: "a4" },
];

eq(accountBalanceCents(ACC[0], ACC_TX), 397450, "微信：期初 1000 + 收 3000 − 支 25.50");
eq(accountBalanceCents(ACC[1], ACC_TX), 0, "没动过的账户就是期初那么多");
eq(accountBalanceCents({ id: "a9", name: "新的", initialBalanceCents: 0 }, ACC_TX), 0, "没有账目时是 0");

const BT = balanceTotals(ACC, ACC_TX);
eq(BT.listedCents, 397450, "列表里三个账户的合计");
eq(BT.deletedCents, -80000, "挂在已删账户上的账，单独算出来");
eq(BT.deletedCount, 1, "已删账户的个数按「有账目引用、但账户不在列表里」数");
eq(BT.totalCents, 317450, "总余额 = 列表合计 + 已删账户的净额（默认含已删）");
// 账户列表空了，那三笔账就全都算「已删账户」的：3000 − 25.50 − 800 = 2174.50
eq(balanceTotals([], ACC_TX).totalCents, 217450, "一个账户都没有时，全部账目都归到已删那一份");
eq(balanceTotals([], ACC_TX).deletedCount, 2, "按 accountId 数出 2 个已删账户");

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
