/* 记账模块的纯逻辑测试：只测不碰 DOM 的那两个模块。
 * 跑法：node tests\记账计算.test.mjs   （本机 Node v24，不需要 package.json）
 * 说明：这个测试不进「自检.cmd」——自检是给用户一键跑的，保持纯 Python。 */

import { yuanToCents, yuanToCentsNonNeg, centsToYuan, fmtMoney, fmtMoneyShort } from "../app/web/money.js";
import {
  monthKey, daysInMonth, dayTotals, monthTotals, monthByDay,
  categoryTotals, budgetState, overDays, byCreatedAt,
  accountBalanceCents, balanceTotals,
  categoryBudgetStates, validateAccountInput,
  ensureCategories, dayCategories, filterByCategory, DEFAULT_CATEGORIES,
  normalizeTransfer, transfersOfAccount, validateTransferInput,
  csvCell, financeRows, financeCsv, CSV_HEAD,
  budgetNotice,
  ledgerRange, rangeTotals, ledgerOf, LEDGER_SCOPES,
  TEMPLATE_LIMIT, normalizeTemplate, templatesOf, templateFromTx, templateLabel, addTemplate,
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
eq(categoryTotals(TX, "2026-10").length, 3, "不传 type 时默认只看支出");
eqDeep(categoryTotals(TX, "2026-10", "income").map((c) => [c.category, c.cents]),
  [["工资", 300000]], "传 income 时只看收入那一头");
eq(categoryTotals(TX, "2026-11", "income").length, 0, "那个月没有收入就是空数组");

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

// 账户表单的校验（添加 / 编辑共用）：名字 + 期初余额
eq(validateAccountInput({ name: "   ", initText: "", accounts: ACC }).nameErr, "账户名称不能为空",
  "空名字（纯空格也算空）不算过");
const V1 = validateAccountInput({ name: "   ", initText: "", accounts: ACC });
eq(V1.initCents, 0, "期初留空按 0 算");
eq(V1.ok, false, "名字不过整张表就不过");
eq(validateAccountInput({ name: " 微信 ", initText: "", accounts: ACC }).nameErr, "已经有同名账户了",
  "重名不算过（比对前先把首尾空白 trim 掉）");
eq(validateAccountInput({ name: "微信", initText: "", accounts: ACC, selfId: "a1" }).ok, true,
  "改自己不算跟自己重名");
eq(validateAccountInput({ name: " wechat ", initText: "", accounts: [{ id: "b1", name: "WeChat" }] }).nameErr,
  "已经有同名账户了", "重名不区分大小写");
eq(validateAccountInput({ name: "一".repeat(21), initText: "", accounts: [] }).nameErr,
  "账户名称最多 20 个字", "超过 20 个字不算过");
eq(validateAccountInput({ name: "一".repeat(20), initText: "", accounts: [] }).ok, true, "刚好 20 个字可以");

eq(validateAccountInput({ name: "工资卡", initText: "-5", accounts: [] }).initErr, "期初余额不能小于 0",
  "负数期初不算过");
eq(validateAccountInput({ name: "工资卡", initText: "12.345", accounts: [] }).initErr,
  "期初余额最多两位小数，只能填数字", "三位小数不算过");
eq(validateAccountInput({ name: "工资卡", initText: "abc", accounts: [] }).initErr,
  "期初余额最多两位小数，只能填数字", "非数字不算过");
eq(validateAccountInput({ name: "工资卡", initText: "1000000", accounts: [] }).initErr,
  "期初余额不能超过 999,999.99", "超过上限不算过");
const V2 = validateAccountInput({ name: "工资卡", initText: "999999.99", accounts: [] });
eq(V2.ok, true, "上限 999,999.99 可以");
eq(V2.initCents, 99999999, "999999.99 元 = 99999999 分");
const V3 = validateAccountInput({ name: "工资卡", initText: "1826.3", accounts: [] });
eq(V3.ok, true, "名字和期初都对 → 整张表算过");
eq(V3.initCents, 182630, "1826.3 元 = 182630 分");
eq(V3.name, "工资卡", "通过时把 trim 好的名字带出来");

// 分类预算：只列设了预算的，按用掉的钱从多到少排
const CBS = categoryBudgetStates(TX, "2026-10", { 餐饮: 50000, 交通: 10000, 购物: 0 });
eq(CBS.length, 2, "没设预算的分类（购物 0）不占地方");
eq(CBS[0].category, "餐饮", "用得多排前面：餐饮 25.50 > 交通 12.00");
eq(CBS[0].usedCents, 2550, "用掉多少照实算");
eq(CBS[0].budgetCents, 50000, "预算原样带出来");
eq(CBS[0].level, "ok", "用了 5% → ok");
eq(CBS[1].category, "交通", "第二个是交通");
eq(categoryBudgetStates(TX, "2026-10", { 交通: 1000 })[0].level, "over", "交通预算 10.00、花了 12.00 → over");
eq(categoryBudgetStates(TX, "2026-09", { 餐饮: 50000 })[0].usedCents, 0, "那个月没花，就是 0");
eq(categoryBudgetStates(TX, "2026-10", {}).length, 0, "没设任何分类预算就是空数组");

// 分类兜底：老数据缺 finance.categories 时前端自己补一套默认分类
// （服务端也会补，但它那个进程还停在旧版本上时，就指望这一份了）
const F1 = {};
eq(ensureCategories(F1), true, "整块 categories 都没有 → 补一套");
eqDeep(F1.categories.expense, DEFAULT_CATEGORIES.expense, "支出那边补成默认的一套");
eqDeep(F1.categories.income, DEFAULT_CATEGORIES.income, "收入那边补成默认的一套");
eq(ensureCategories(F1), false, "补过一次之后再调就不算改动（不会反复落盘）");

const F2 = { categories: { expense: ["我自己的分类"], income: [] } };
eq(ensureCategories(F2), true, "只有一边空也算补过");
eqDeep(F2.categories.expense, ["我自己的分类"], "已经有分类的那一边一个人都不动");
eqDeep(F2.categories.income, DEFAULT_CATEGORIES.income, "空的那一边补默认");

const F3 = { categories: { expense: ["a"], income: ["b"] } };
eq(ensureCategories(F3), false, "两边都有就什么都不做");
eqDeep(F3.categories, { expense: ["a"], income: ["b"] }, "已有的分类原样留着");
eq(ensureCategories(null), false, "没有 finance 对象也不炸");

// 当日明细的分类筛选：只列这天真有的分类，按当天条目的先后顺序
const DAY7 = TX.filter((t) => t.date === "2026-10-07");
eqDeep(dayCategories(DAY7), ["餐饮", "交通", "工资"], "去重，且保持当天出现的先后");
eq(dayCategories([]).length, 0, "没条目就没有分类");
eq(dayCategories([{ category: "" }, { category: null }]).length, 0, "空分类名不算一个分类");
eq(filterByCategory(DAY7, "").length, 3, "空串 = 全部");
eq(filterByCategory(DAY7, "餐饮").length, 1, "只看餐饮就剩一笔");
eq(filterByCategory(DAY7, "餐饮")[0].id, "a", "剩下的是那一笔餐饮");
eq(filterByCategory(DAY7, "没有这个分类").length, 0, "对不上的分类就是空列表");
eq(filterByCategory(DAY7, "") === DAY7, false, "返回的是拷贝，不动传进来的数组");

/* ---------------- 账户转账（2026-10-12 加的） ----------------
   转账单独一张表：读出来先规整，余额多算它一项，
   收支统计那几处（monthTotals / categoryTotals / 环形图 / 预算 / 月历）
   只收 transactions，压根收不到转账 —— 所以那半边不用测「排除」。 */

const ACC_A = { id: "a1", name: "微信", initialBalanceCents: 100000 };   // 期初 1000.00
const ACC_B = { id: "a2", name: "银行卡", initialBalanceCents: 0 };

eqDeep(normalizeTransfer({ amountCents: "1000", fromAccountId: " a1 ", toAccountId: "a2",
  imagePaths: ["x.png", 3, ""] }),
  { id: "", amountCents: 1000, date: "", fromAccountId: "a1", toAccountId: "a2",
    note: "", createdAt: "", imagePaths: ["x.png"] },
  "规整：金额取整、账户 id 去空白、图片里夹的非字符串丢掉");
eq(normalizeTransfer({ amountCents: -500 }).amountCents, 500, "金额取绝对值（负数当手滑）");
eq(normalizeTransfer(null).amountCents, 0, "整条是空的也不炸");

const TFS = [
  { id: "tf1", amountCents: 30000, date: "2026-10-12", fromAccountId: "a1", toAccountId: "a2", note: "还信用卡" },
  { id: "tf2", amountCents: 5000, date: "2026-10-12", fromAccountId: "a2", toAccountId: "a1", note: "退回来一点" },
  { id: "tf3", amountCents: 2000, date: "2026-10-12", fromAccountId: "a1", toAccountId: "zz", note: "转到已删账户" },
];

eqDeep(transfersOfAccount(TFS, "a1"), { inCents: 5000, outCents: 32000, netCents: -27000 },
  "a1 的转入 50、转出 320（转给已删账户的那笔也算转出）");
eqDeep(transfersOfAccount(TFS, "a2"), { inCents: 30000, outCents: 5000, netCents: 25000 },
  "a2 反过来：转入 300、转出 50");
eqDeep(transfersOfAccount(TFS, "没有这个账户"), { inCents: 0, outCents: 0, netCents: 0 },
  "不认识的账户一分钱都不动");
eqDeep(transfersOfAccount([], "a1"), { inCents: 0, outCents: 0, netCents: 0 }, "没有转账时干净地给 0");
eqDeep(transfersOfAccount(null, "a1"), { inCents: 0, outCents: 0, netCents: 0 }, "传 null 也不炸");

const TXS = [
  { id: "t1", type: "expense", amountCents: 1000, date: "2026-10-12", accountId: "a1" },
  { id: "t2", type: "income", amountCents: 200, date: "2026-10-12", accountId: "a1" },
];
eq(accountBalanceCents(ACC_A, TXS), 100000 - 1000 + 200, "老口径没动：期初 + 收入 − 支出");
eq(accountBalanceCents(ACC_A, TXS, TFS), 100000 - 1000 + 200 - 27000,
  "加上转账：a1 净转出 270，余额跟着少 270");
eq(accountBalanceCents(ACC_B, TXS, TFS), 25000, "a2 只有转账：净转入 250");
eq(accountBalanceCents(ACC_A, TXS, []), accountBalanceCents(ACC_A, TXS),
  "不传转账 = 空转账，老调用点一个字都不用改");

const TOTAL = balanceTotals([ACC_A, ACC_B], TXS, TFS);
eq(TOTAL.listedCents, accountBalanceCents(ACC_A, TXS, TFS) + accountBalanceCents(ACC_B, TXS, TFS),
  "账户总余额 = 各账户余额之和（含转账）");
// 转出方（a1）那 −20 已经算在「在用账户」里了，所以「已删账户」这一桶要 +20，
// 两边一抵，钱没凭空多也没凭空少。
eq(TOTAL.deletedCents, 2000, "转给已删账户那 20 块落到「已删账户」那一桶（+20）");
eq(TOTAL.totalCents, TOTAL.listedCents + TOTAL.deletedCents, "总余额 = 在用 + 已删");
eq(TOTAL.totalCents, balanceTotals([ACC_A, ACC_B], TXS).totalCents,
  "转账不改总余额（钱只是换个账户待着）—— 这条是守恒，算错了上面几条也跑不掉");

const TWO = [{ id: "a1", name: "微信" }, { id: "a2", name: "银行卡" }];
eq(validateTransferInput({ amount: "100", date: "2026-10-12", fromAccountId: "a1",
  toAccountId: "a2", accounts: TWO }).ok, true, "正常的一笔转账放行");
eq(validateTransferInput({ amount: "100", date: "2026-10-12", fromAccountId: "a1",
  toAccountId: "a2", accounts: TWO }).amountCents, 10000, "金额换算成分");
eq(validateTransferInput({ amount: "0", date: "2026-10-12", fromAccountId: "a1",
  toAccountId: "a2", accounts: TWO }).ok, false, "金额 0 不行");
eq(validateTransferInput({ amount: "-5", date: "2026-10-12", fromAccountId: "a1",
  toAccountId: "a2", accounts: TWO }).ok, false, "金额负数不行");
eq(validateTransferInput({ amount: "1.234", date: "2026-10-12", fromAccountId: "a1",
  toAccountId: "a2", accounts: TWO }).ok, false, "三位小数不行");
eq(validateTransferInput({ amount: "1000000", date: "2026-10-12", fromAccountId: "a1",
  toAccountId: "a2", accounts: TWO }).ok, false, "超过 999,999.99 不行");
eq(validateTransferInput({ amount: "100", date: "", fromAccountId: "a1",
  toAccountId: "a2", accounts: TWO }).ok, false, "没填日期不行");
eq(validateTransferInput({ amount: "100", date: "2026-10-12", fromAccountId: "a1",
  toAccountId: "a1", accounts: TWO }).toErr, "「从」和「到」不能是同一个账户",
  "转给自己要单独说清楚");
eq(validateTransferInput({ amount: "100", date: "2026-10-12", fromAccountId: "",
  toAccountId: "a2", accounts: TWO }).fromErr !== "", true, "没选「从」要报错");
eq(validateTransferInput({ amount: "100", date: "2026-10-12", fromAccountId: "a1",
  toAccountId: "删掉的账户", accounts: TWO }).toErr !== "", true, "选了一个不在账户表里的要报错");
const FEW = validateTransferInput({ amount: "100", date: "2026-10-12", fromAccountId: "a1",
  toAccountId: "a1", accounts: [{ id: "a1", name: "微信" }] });
eq(FEW.ok, false, "只有一个账户时存不了");
eq(FEW.hint.indexOf("第二个账户") >= 0, true, "并且明说「先加第二个账户」");
eq(FEW.amountErr, "", "账户不够时不去挑金额的毛病（先说清最要紧的那件事）");

/* ---------------- CSV 导出（2026-10-13 加的） ----------------
   一行一条记录，账目和转账都在一份里：金额一律正数，方向看「类型」那一列。
   分隔符是逗号，所以备注里的逗号 / 引号 / 换行都得裹起来 —— 备注是能换行写的。 */

eq(csvCell("普通"), "普通", "普通文字原样");
eq(csvCell("有,逗号"), '"有,逗号"', "带逗号的裹引号");
eq(csvCell('有"引号'), '"有""引号"', "引号翻倍再裹");
eq(csvCell("两\n行"), '"两\n行"', "换行（备注能换行）也裹起来");
eq(csvCell(""), "", "空串还是空串");
eq(csvCell(null), "", "null 当空");
eq(csvCell(2550), "2550", "数字转成文本");

eqDeep(CSV_HEAD, ["日期", "类型", "分类", "金额", "账户", "到账账户", "备注"],
  "表头七列（转账多的那两列账目留空）");

const ACCS = [{ id: "a1", name: "微信" }, { id: "a2", name: "招行卡" }];
const EXP = [
  { id: "e1", type: "expense", amountCents: 2550, date: "2026-10-05", category: "餐饮",
    accountId: "a1", note: "午饭 黄焖鸡", createdAt: "2026-10-05 12:30" },
  { id: "e2", type: "income", amountCents: 200000, date: "2026-10-01", category: "工资",
    accountId: "a2", note: "", createdAt: "2026-10-01 09:00" },
  { id: "e3", type: "expense", amountCents: 100, date: "2026-09-30", category: "其他",
    accountId: "", note: "", createdAt: "2026-09-30 08:00" },
];
const TFS2 = [
  { id: "tf1", amountCents: 25000, date: "2026-10-12", fromAccountId: "a1", toAccountId: "a2",
    note: "还信用卡", createdAt: "2026-10-12 10:00" },
];

const ROWS = financeRows(EXP, TFS2, { accounts: ACCS });
eq(ROWS.length, 4, "三笔账 + 一条转账 = 四行数据");
eqDeep(ROWS[0], ["2026-09-30", "支出", "其他", "1.00", "", "", ""], "日期最早的排最前；账户空着就留空");
eqDeep(ROWS[1], ["2026-10-01", "收入", "工资", "2000.00", "招行卡", "", ""], "收入：账户那一列写账户名");
eqDeep(ROWS[2], ["2026-10-05", "支出", "餐饮", "25.50", "微信", "", "午饭 黄焖鸡"],
  "支出：金额是正数，方向看类型列");
eqDeep(ROWS[3], ["2026-10-12", "转账", "", "250.00", "微信", "招行卡", "还信用卡"],
  "转账：分类留空，「账户」是转出、「到账账户」是转入");

const ROWS_OLD = financeRows(
  [{ id: "e4", type: "expense", amountCents: 100, date: "2026-10-01", category: "其他",
     accountId: "删掉的", note: "" }],
  [], { accounts: ACCS }
);
eq(ROWS_OLD[0][4], "（账户已删）", "账户不在列表里就写「（账户已删）」，不写一个认不出的 id");

const MONTH = financeRows(EXP, TFS2, { accounts: ACCS, month: "2026-10" });
eq(MONTH.length, 3, "只看这个月：9 月那笔不在里面");
eq(MONTH.every((r) => r[0].startsWith("2026-10")), true, "剩下的都是 10 月的");
eq(financeRows(EXP, TFS2, { accounts: ACCS, month: "2026-08" }).length, 0, "没有的月份就是空的");
eq(financeRows(EXP, TFS2, {}).length, 4, "不传账户也能导（账户名留空，不抛错）");
eq(financeRows(null, null, { accounts: ACCS }).length, 0, "没有数据就是没有行");

const CSV = financeCsv(financeRows(EXP, TFS2, { accounts: ACCS }));
eq(CSV.charCodeAt(0), 0xfeff, "开头是 BOM（不然 Excel 打开中文乱码）");
eq(CSV.slice(1).split("\r\n")[0], CSV_HEAD.join(","), "第一行是表头");
eq(CSV.slice(1).split("\r\n").length, 6, "表头 + 四行 + 末尾那个换行；行尾用 \\r\\n");
eq(CSV.indexOf(",25.50,") >= 0, true, "金额是两位小数的元，不带货币符号");
eq(CSV.indexOf("¥") >= 0, false, "货币符号不进 CSV（要不 Excel 认成文本）");
eq(CSV.indexOf("微信,招行卡") >= 0, true, "转账那行：转出、转入两列挨着");
eq(financeCsv([]), "\ufeff" + CSV_HEAD.join(",") + "\r\n", "一条数据都没有时只剩表头");

const CSV_NOTE = financeCsv(financeRows(
  [{ id: "e5", type: "expense", amountCents: 100, date: "2026-10-01", category: "其他",
     accountId: "", note: '买了 "A, B" 两样\n第二行', createdAt: "" }],
  [], { accounts: ACCS }
));
eq(CSV_NOTE.indexOf('"买了 ""A, B"" 两样\n第二行"') >= 0, true,
  "备注里的引号、逗号、换行都照顾到了");

/* ---------------- 预算提醒（2026-10-13 加的） ----------------
   档位本来就有（budgetState 的 ok / warn / over），这一版补的是「用一句话说出来」：
   80% 起提醒、正好用满和超支各说各的，文案里带真实数字。 */

eq(budgetNotice(budgetState(1000, 10000)), null, "用了 10%：不提醒");
eq(budgetNotice(budgetState(7999, 10000)), null, "79.99%：也还不提醒");
eq(budgetNotice(budgetState(8000, 10000)).level, "warn", "到 80%：该说一句了");
eq(budgetNotice(budgetState(8000, 10000)).long, "已用 80%，快到预算了", "文案带真实百分比");
eq(budgetNotice(budgetState(8500, 10000)).short, "已用 85%", "短文案给列表行用");
eq(budgetNotice(budgetState(9999, 10000)).level, "warn", "99.99% 还是「快到了」");
eq(budgetNotice(budgetState(10000, 10000)).short, "已用完",
  "正好用满：不是「快到了」，也还没超（预算就是上限）");
eq(budgetNotice(budgetState(10000, 10000)).overCents, 0, "用满时超额是 0");
eq(budgetNotice(budgetState(10500, 10000)).level, "over", "过了 100% 就是超支档");
eq(budgetNotice(budgetState(10500, 10000)).long, "已超 ¥5.00", "超支文案写清超了多少");
eq(budgetNotice(budgetState(10500, 10000)).short, "超 ¥5.00", "短文案同一个数");
eq(budgetNotice(budgetState(10500, 10000)).pct, 105, "百分比照实给（画条时自己封顶）");
eq(budgetNotice(budgetState(5000, 0)), null, "没设预算：没什么好提醒的");
eq(budgetNotice(null), null, "什么都没传也不炸");

/* ---------------- 明细的筛选：时间段 + 账户（2026-10-13 加的） ----------------
   明细卡片原来只看「选中的那一天」，这一版能切「本月 / 自定义时间段」再叠一个账户。
   纯逻辑只负责把条件归一成一段时间 + 一个账户，再筛出这批账（转账另外给一份）。 */

eqDeep(LEDGER_SCOPES, ["day", "month", "range"], "三种范围：当天 / 本月 / 自定义");

const LEDGER_CTX = { selected: "2026-10-08", month: "2026-10" };
eqDeep(ledgerRange({ scope: "day" }, LEDGER_CTX),
  { scope: "day", from: "2026-10-08", to: "2026-10-08", accountId: "" },
  "当天：两头都是选中的那天");
eqDeep(ledgerRange({ scope: "month" }, LEDGER_CTX),
  { scope: "month", from: "2026-10-01", to: "2026-10-31", accountId: "" },
  "本月：整个月那一头到尾");
eqDeep(ledgerRange({ scope: "range", from: "2026-10-01", to: "2026-10-05" }, LEDGER_CTX),
  { scope: "range", from: "2026-10-01", to: "2026-10-05", accountId: "" },
  "自定义：两头照填的来");
eqDeep(ledgerRange({ scope: "range", from: "2026-10-09", to: "2026-10-01" }, LEDGER_CTX),
  { scope: "range", from: "2026-10-01", to: "2026-10-09", accountId: "" },
  "自定义：起止填反了自动换过来（不是筛出一片空）");
eqDeep(ledgerRange({ scope: "range", from: "", to: "2026-10-05" }, LEDGER_CTX),
  { scope: "range", from: "2026-10-05", to: "2026-10-05", accountId: "" },
  "自定义只填了一头：另一头补上（当那天）");
eqDeep(ledgerRange({ scope: "range" }, LEDGER_CTX),
  { scope: "range", from: "2026-10-08", to: "2026-10-08", accountId: "" },
  "自定义两头都空：当回选中的那天，别把整本账都倒出来");
eqDeep(ledgerRange({ scope: "没有这种", accountId: "a1" }, LEDGER_CTX),
  { scope: "day", from: "2026-10-08", to: "2026-10-08", accountId: "a1" },
  "范围认不出来就当「当天」（老数据 / 手改过不至于白屏）");
eqDeep(ledgerRange(null, LEDGER_CTX).accountId, "", "什么都没传也不炸");

const RANGE_TX = [
  { id: "r1", type: "expense", amountCents: 1000, date: "2026-10-03", accountId: "a1", category: "餐饮", createdAt: "2026-10-03 08:00" },
  { id: "r2", type: "income", amountCents: 5000, date: "2026-10-05", accountId: "a2", category: "工资", createdAt: "2026-10-05 08:00" },
  { id: "r3", type: "expense", amountCents: 300, date: "2026-09-30", accountId: "a1", category: "其他", createdAt: "2026-09-30 08:00" },
];
eqDeep(rangeTotals(RANGE_TX, "2026-10-01", "2026-10-05"),
  { expenseCents: 1000, incomeCents: 5000, balanceCents: 4000 },
  "一段时间里的合计：结余 = 收入 − 支出");
eqDeep(rangeTotals(RANGE_TX, "", ""), { expenseCents: 1300, incomeCents: 5000, balanceCents: 3700 },
  "两头都不限就是全部");
eqDeep(rangeTotals([], "2026-10-01", "2026-10-31"), { expenseCents: 0, incomeCents: 0, balanceCents: 0 },
  "一笔都没有时干净地给 0");

const RANGE_TFS = [
  { id: "rt1", amountCents: 2000, date: "2026-10-04", fromAccountId: "a1", toAccountId: "a2", note: "转一笔", createdAt: "2026-10-04 08:00" },
  { id: "rt2", amountCents: 900, date: "2026-09-01", fromAccountId: "a1", toAccountId: "a2", note: "上月的", createdAt: "2026-09-01 08:00" },
];

const MONTH_LEDGER = ledgerOf(RANGE_TX, RANGE_TFS, { scope: "month" }, LEDGER_CTX);
eq(MONTH_LEDGER.scope, "month", "归一后的范围也带出来（界面靠它决定标题和说明）");
eq(MONTH_LEDGER.from + "~" + MONTH_LEDGER.to, "2026-10-01~2026-10-31", "顺带把时间段给出来");
eqDeep(MONTH_LEDGER.rows.map((t) => t.id), ["r1", "r2"], "本月：10 月那两笔（9 月的不进来）");
eqDeep(MONTH_LEDGER.transfers.map((t) => t.id), ["rt1"], "转账也照同一段时间筛");
eq(MONTH_LEDGER.totals.expenseCents, 1000, "合计只算筛出来的这几笔");
eq(MONTH_LEDGER.count, 2, "条数是账目的条数（转账单算）");

const ACC_LEDGER = ledgerOf(RANGE_TX, RANGE_TFS, { scope: "month", accountId: "a2" }, LEDGER_CTX);
eqDeep(ACC_LEDGER.rows.map((t) => t.id), ["r2"], "只看 a2：账目只剩工资那笔");
eqDeep(ACC_LEDGER.transfers.map((t) => t.id), ["rt1"],
  "转账：钱从 a2 出或进 a2 都算（这条是从 a1 到 a2）");
eq(ledgerOf(RANGE_TX, RANGE_TFS, { scope: "month", accountId: "没有这个账户" }, LEDGER_CTX).rows.length, 0,
  "账户选了个不存在的：空列表（不是整本账）");

const RANGE_LEDGER = ledgerOf(RANGE_TX, RANGE_TFS, { scope: "range", from: "2026-10-01", to: "2026-10-04" }, LEDGER_CTX);
eqDeep(RANGE_LEDGER.rows.map((t) => t.id), ["r1"], "自定义时间段：只到 10-04 那天");
eqDeep(RANGE_LEDGER.transfers.map((t) => t.id), ["rt1"], "转账也在这一段里");
eq(ledgerOf(RANGE_TX, RANGE_TFS, null, LEDGER_CTX).rows.length, 0,
  "筛选条件传 null：退回「当天」（10-08 那天没账目，所以是空）");
eq(ledgerOf(null, null, { scope: "month" }, LEDGER_CTX).rows.length, 0, "账目传 null 也不炸");

/* ---------------- 常用账目模板（2026-10-13 加的） ----------------
   常记的那几笔（午饭、房租、工资）存成模板，下次点一下就填好。
   模板只存「记一笔」表单里那几个字段：类型 / 分类 / 金额 / 账户 / 备注；
   图片不存（每次的截图都不一样），也不进全局搜索（它是配置，不是记录）。 */

eq(TEMPLATE_LIMIT, 8, "最多存 8 个（再多就该删了）");

const TPL_TX = {
  type: "expense", category: "餐饮", amountCents: 2550, accountId: "a1",
  note: "午饭 黄焖鸡", date: "2026-10-13", imagePaths: ["x.png"], createdAt: "2026-10-13 12:00",
};
eqDeep(templateFromTx(TPL_TX),
  { id: "", type: "expense", category: "餐饮", amountCents: 2550, accountId: "a1", note: "午饭 黄焖鸡" },
  "从一笔账捏模板：只挑那五个字段，日期 / 图片 / 创建时间都不带");
eq(templateFromTx({ type: "income" }).category, "其他",
  "分类空着给「其他」（和「记一笔」的默认值一个口径）");
eq(templateFromTx(null).type, "expense", "什么都没有时当一笔普通支出，不炸");

eqDeep(normalizeTemplate({ id: "t1", type: "income", category: "工资", amountCents: "800000",
  accountId: " a2 ", note: " 月薪 ", extra: "忽略我" }),
  { id: "t1", type: "income", category: "工资", amountCents: 800000, accountId: "a2", note: "月薪" },
  "读模板：金额取整、账户去空白、多余的键不要");
eq(normalizeTemplate({ type: "转账" }).type, "expense", "类型认不出就当支出（转账不做模板）");
eq(normalizeTemplate({ amountCents: -100 }).amountCents, 100, "金额负数当手滑，取正");

const TPL_FINANCE = { templates: [{ id: "t1", type: "expense", category: "餐饮", amountCents: 2550 },
                                  { type: "income", category: "工资", amountCents: 800000 }] };
eq(templatesOf(TPL_FINANCE).length, 2, "读出来两条");
eq(templatesOf({}).length, 0, "没这个键的老数据：空列表，不抛错");
eq(templatesOf({ templates: "坏掉的" }).length, 0, "被手改成别的形状也当空");

eq(templateLabel({ category: "餐饮", amountCents: 2550 }), "餐饮 ¥25.50", "显示名：分类 + 金额");
eq(templateLabel({ category: "餐饮", amountCents: 2550, note: "午饭" }), "午饭", "有备注就用备注");
eq(templateLabel({ category: "工资", amountCents: 800000, type: "income" }), "工资 +¥8,000.00",
  "收入那边带个加号，一眼分得清");

const ADDED = addTemplate([], templateFromTx(TPL_TX));
eq(ADDED.status, "added", "存一个新的：added");
eq(ADDED.list.length, 1, "列表里多了一条");
eq(ADDED.list[0].category, "餐饮", "存的是那一笔的内容");
eq(ADDED.list[0].id.length > 0, true, "顺手给它一个 id（删的时候要用）");
eq(ADDED.list[0].id === ADDED.list[0].id, true, "id 是稳定的");

const TWICE = addTemplate(ADDED.list, templateFromTx(TPL_TX));
eq(TWICE.status, "dup", "再存同一条：告诉你是重复的");
eq(TWICE.list.length, 1, "重复的不往里加");
eq(addTemplate(ADDED.list, templateFromTx({ ...TPL_TX, amountCents: 3000 })).status, "added",
  "金额不一样就不算重复");
eq(addTemplate(ADDED.list, templateFromTx({ ...TPL_TX, category: "交通" })).status, "added",
  "分类不一样也不算重复");

const FULL = Array.from({ length: TEMPLATE_LIMIT }, (_, i) => ({
  id: "t" + i, type: "expense", category: "其他", amountCents: 100 + i, accountId: "", note: "",
}));
const FULL_TRY = addTemplate(FULL, templateFromTx({ type: "expense", category: "餐饮", amountCents: 999 }));
eq(FULL_TRY.status, "full", "存满 8 个之后再存：告诉它满了（让它自己删一个）");
eq(FULL_TRY.list.length, TEMPLATE_LIMIT, "满了就不再往里加");
eq(addTemplate(null, templateFromTx(TPL_TX)).status, "added", "传 null 也能存（当空列表）");

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
