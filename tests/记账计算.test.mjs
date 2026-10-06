/* 记账模块的纯逻辑测试：只测不碰 DOM 的那两个模块。
 * 跑法：node tests\记账计算.test.mjs   （本机 Node v24，不需要 package.json）
 * 说明：这个测试不进「自检.cmd」——自检是给用户一键跑的，保持纯 Python。 */

import { yuanToCents, centsToYuan, fmtMoney, fmtMoneyShort } from "../app/web/money.js";

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

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
