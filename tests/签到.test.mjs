/* 签到（多站点）的纯逻辑测一遍（checkin-calc.js，不碰 DOM、不发请求）。
 *
 * 要盯住的还是那件事：签到只有两种真相——签了 / 没签。
 * 含糊其辞会让人以为签上了，所以每条断言都在检查措辞和禁用条件。
 *
 * 跑法：node tests\签到.test.mjs
 */

import {
  expiryLine,
  pendingCount,
  queryButton,
  resultLine,
  siteButton,
  siteCreditLine,
  siteState,
  siteStatusLine,
  sourceTag,
  summaryLine,
  tokenHint,
  weekCells,
} from "../app/web/checkin-calc.js";

let pass = 0;
let fail = 0;

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) { pass++; console.log("  ok   " + label); }
  else {
    fail++;
    console.log("  FAIL " + label + "：期望 " + b + "，实际 " + a);
  }
}

function ok(cond, label) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label); }
}

/* ---------------- 测试用数据 ---------------- */

// 站点（服务端 /api/checkin 返回的列表项）
const SITE = {
  id: "workbuddy",
  name: "WorkBuddy",
  source: "内置",
  enabled: true,
  configured: true,
  error: null,
  tokenHint: "去客户端按 F12 复制",
  tokenExpires: "2026-12-04 02:20",
  vars: [],
};

const USER_SITE = { ...SITE, id: "demo", name: "演示站", source: "用户" };

// 状态（真实返回，2026-11-04 实测抓到的）
const CHECKED = {
  ok: true,
  configured: true,
  checked: true,
  streak: 2,
  dailyCredit: 100,
  todayCredit: 100,
  total: 200,
  week: [false, true, true, false, false, false, false],
  weekDays: 2,
  activityName: "Buddy加油站",
  tokenExpires: "2026-12-04 02:20",
};

const NOT_CHECKED = {
  ...CHECKED,
  checked: false,
  streak: 1,
  total: 100,
  week: [false, true, false, false, false, false, false],
  weekDays: 1,
};

/* ---------------- 站点状态判断 ---------------- */

console.log("\n站点状态：");
eq(siteState(SITE, CHECKED), "checked", "签了 → checked");
eq(siteState(SITE, NOT_CHECKED), "not-checked", "没签 → not-checked");
eq(siteState(SITE, null), "unknown", "还没查 → unknown");
eq(siteState({ ...SITE, configured: false }, null), "unconfigured", "没凭证单独一档");
eq(siteState({ ...SITE, enabled: false }, null), "disabled", "关掉了单独一档");
eq(siteState({ ...SITE, error: "定义坏了" }, null), "broken", "定义坏了优先报坏");
eq(siteState(SITE, { ok: false, error: "401" }), "error", "查失败 → error");
eq(siteState(null, null), "unknown", "null 站点 → unknown");
// 关键优先级：没配置要在「还没查」之前，否则界面一直说「点查状态」
eq(siteState({ ...SITE, configured: false }, undefined), "unconfigured", "没配置优先于未知");

/* ---------------- 状态文案 ---------------- */

console.log("\n状态文案：");
ok(siteStatusLine(SITE, CHECKED).includes("今天已签"), "签了说「今天已签」");
ok(siteStatusLine(SITE, CHECKED).includes("连续 2 天"), "带上连续天数");
ok(siteStatusLine(SITE, CHECKED).includes("Buddy加油站"), "带上活动名");
ok(siteStatusLine(SITE, NOT_CHECKED).includes("还没签"), "没签说「还没签」");
// 这条最重要：没说签上之前，绝不能出现「已签」字样
ok(!siteStatusLine(SITE, NOT_CHECKED).includes("已签"), "没签时绝不能出现「已签」");
eq(siteStatusLine({ ...SITE, configured: false }, null), "还没填凭证", "没凭证直说");
eq(siteStatusLine({ ...SITE, enabled: false }, null), "已关掉，不参与签到", "关掉了直说");
eq(siteStatusLine({ ...SITE, error: "少了 id" }, null), "少了 id", "定义坏了原样报错");
eq(siteStatusLine(SITE, { ok: false, error: "凭证失效了" }), "凭证失效了", "查失败原样报错");
// 查失败不能被说成「还没签」——那是两回事
ok(!siteStatusLine(SITE, { ok: false, error: "401" }).includes("还没签"), "查失败不能说成没签");

console.log("\n积分与有效期：");
ok(siteCreditLine(CHECKED).includes("200"), "带总积分");
ok(siteCreditLine(CHECKED).includes("每天可得 100"), "带每天可得");
eq(siteCreditLine({ total: null }), "", "没总数就不显示");
eq(siteCreditLine({ ok: false }), "", "查失败不显示积分");
eq(expiryLine(SITE, null), "凭证有效期到 2026-12-04 02:20", "从站点上取有效期");
eq(expiryLine(SITE, { tokenExpires: "2026-01-01 00:00" }), "凭证有效期到 2026-01-01 00:00",
  "状态里有就用状态的");
eq(expiryLine({}, null), "", "没有就不显示");

console.log("\n来源标签：");
eq(sourceTag(SITE), "", "内置站点不加标签");
eq(sourceTag(USER_SITE), "自己加的", "用户加的标出来");

/* ---------------- 按钮 ---------------- */

console.log("\n签到按钮：");
eq(siteButton(SITE, NOT_CHECKED, ""), { disabled: false, label: "立即签到" }, "没签 → 可点");
eq(siteButton(SITE, CHECKED, ""), { disabled: true, label: "今天已签" }, "已签 → 不可点");
// 防重复点击：正在签的那个站点必须锁住
eq(siteButton(SITE, NOT_CHECKED, "workbuddy").disabled, true, "签到中 → 锁住");
eq(siteButton(SITE, NOT_CHECKED, "workbuddy").label, "签到中…", "签到中要说清楚");
// 只锁正在签的那个，别的站点不受影响
eq(siteButton(USER_SITE, NOT_CHECKED, "workbuddy").disabled, false, "别的站点不受影响");

eq(siteButton({ ...SITE, configured: false }, null, "").disabled, true, "没凭证 → 不可点");
eq(siteButton({ ...SITE, enabled: false }, null, "").disabled, true, "关掉了 → 不可点");
eq(siteButton({ ...SITE, error: "x" }, null, "").disabled, true, "定义坏了 → 不可点");
eq(siteButton(SITE, { ok: false }, "").disabled, false, "查失败但没说是已签 → 允许再试");
eq(siteButton(SITE, null, "").disabled, false, "还没查 → 允许直接点");
eq(siteButton(null, null, "").disabled, true, "没有站点 → 不可点");

console.log("\n查状态按钮：");
eq(queryButton(SITE, "").disabled, false, "正常能点");
eq(queryButton(SITE, "workbuddy").disabled, true, "查询中锁住");
eq(queryButton({ ...SITE, error: "x" }, "").disabled, true, "定义坏了不让查");
eq(queryButton({ ...SITE, enabled: false }, "").disabled, true, "关掉了不让查");

/* ---------------- 签到结果 ---------------- */

console.log("\n签到结果：");
ok(resultLine({ ok: true, skipped: false, credit: 100, streak: 2 }).includes("领到 100 积分"),
  "成功要说领到多少");
ok(resultLine({ ok: true, skipped: true, message: "今天已经签过了" }).includes("已经签过"),
  "跳过时说清楚");
eq(resultLine({ ok: false, error: "凭证失效了" }), "凭证失效了", "失败时把原因带出来");
eq(resultLine(null), "", "没结果就不显示");

/* ---------------- 本周格子 ---------------- */

console.log("\n本周格子：");
eq(weekCells([false, true, true, false, false, false, false]), [
  { on: false }, { on: true }, { on: true }, { on: false },
  { on: false }, { on: false }, { on: false },
], "七个格子，签过的 on");
eq(weekCells([]), Array(7).fill({ on: false }), "空数据也是七格");
eq(weekCells(null).length, 7, "null 也要七格，界面才不会塌");
eq(weekCells([true]).length, 7, "只给一天也补齐七格");
eq(weekCells([true, true, true, true, true, true, true, true]).length, 7, "多了就截断");

/* ---------------- 凭证校验 ---------------- */

console.log("\n凭证校验：");
eq(tokenHint("").ok, false, "空的不通过");
eq(tokenHint("   ").ok, false, "全是空格不通过");
eq(tokenHint("abc").ok, false, "太短不通过");
eq(tokenHint("eyJhbGciOiJIUzI1NiJ9.payload.sig").ok, true, "JWT 形状通过");
eq(tokenHint("Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig").ok, true, "带 Bearer 前缀也认");
// 有些站点用普通 session token，不强制 JWT
eq(tokenHint("a1b2c3d4e5f6g7h8i9j0").ok, true, "普通 token 也认（不强求 JWT）");
eq(tokenHint("abc def ghi jkl").ok, false, "中间有空格不通过");
ok(tokenHint("abc").hint.includes("太短"), "太短时说清楚");

/* ---------------- 汇总 ---------------- */

console.log("\n汇总：");
const items = [SITE, USER_SITE, { ...SITE, id: "c", configured: false }];
eq(pendingCount(items, { workbuddy: NOT_CHECKED, demo: CHECKED }), 1, "只数真的待签的");
eq(pendingCount(items, {}), 0, "没查过的不算待签");
eq(pendingCount([], {}), 0, "空列表是 0");

ok(summaryLine(items, { workbuddy: CHECKED, demo: NOT_CHECKED }).includes("1 个已签"), "说清已签几个");
ok(summaryLine(items, { workbuddy: CHECKED, demo: NOT_CHECKED }).includes("1 个待签"), "说清待签几个");
ok(summaryLine(items, { workbuddy: CHECKED }).includes("1 个没填凭证"), "说清没填凭证几个");
eq(summaryLine([], {}), "还没有任何签到站点", "空列表直说");

/* ---------------- 浏览器型站点（2026-11-04 加，即梦用） ----------------
 *
 * 即梦没有"签到"这个动作，每日积分是登录后自动发的。
 * 所以它的按钮、文案都得跟 Token 型站点分开——
 * 不然用户会去找一个根本不存在的"签到"按钮。
 */

console.log("\n浏览器型站点：");

const BROWSER_SITE = {
  id: "jimeng",
  name: "即梦",
  source: "内置",
  enabled: true,
  configured: true,
  browser: true,
  browserReady: true,
  tokenHint: "",
  vars: [],
};

// 没登录时，主按钮得是"先登录"，不是"先填凭证"
const notLogged = { ...BROWSER_SITE, configured: false, browserReady: false };
eq(siteButton(notLogged, null, "").label, "先登录", "没登录时提示先登录（不是先填凭证）");
eq(siteButton(notLogged, null, "").disabled, true, "没登录时不能点");

// 登录了但今天还没领 → 按钮可点，字样是"打开页面"
eq(siteButton(BROWSER_SITE, NOT_CHECKED, "").label, "打开页面", "登录了没领时是「打开页面」");
eq(siteButton(BROWSER_SITE, NOT_CHECKED, "").disabled, false, "登录了没领时可以点");

// 领过了 → 禁用，字样"今天已领"（Token 型站点仍是"今天已签"）
eq(siteButton(BROWSER_SITE, CHECKED, "").label, "今天已领", "领过了显示「今天已领」");
eq(siteButton(BROWSER_SITE, CHECKED, "").disabled, true, "领过了不能重复点");
eq(siteButton(SITE, CHECKED, "").label, "今天已签", "Token 型站点仍说「今天已签」");

// 忙的时候
eq(siteButton(BROWSER_SITE, NOT_CHECKED, "jimeng").label, "打开中…", "打开中说「打开中…」");
eq(siteButton(SITE, NOT_CHECKED, "workbuddy").label, "签到中…", "Token 型站点说「签到中…」");

// 月度浏览器型站点（可灵）：不能误写成「今天已签 / 总积分」
const MONTHLY_STATUS = {
  ...CHECKED,
  activityName: "每月惊喜体验包",
  activityPeriod: "monthly",
  nextApplyAt: "2026-12-07 01:44",
  total: 6600,
  dailyCredit: 0,
};
eq(siteStatusLine(BROWSER_SITE, MONTHLY_STATUS), "本月已领「每月惊喜体验包」；下次可领 2026-12-07 01:44", "月度活动明确说本月已领和下次时间");
eq(siteCreditLine(MONTHLY_STATUS), "灵感值 6600", "可灵余额叫灵感值（不说总积分）");
eq(siteButton(BROWSER_SITE, MONTHLY_STATUS, "").label, "本月已领", "月度站点按钮说本月已领");

// 站点定义坏掉 / 关掉，两种类型都该拦住
eq(siteButton({ ...BROWSER_SITE, error: "坏" }, NOT_CHECKED, "").label,
   "定义有问题", "浏览器型站点定义坏了也说清楚");
eq(siteState({ ...BROWSER_SITE, error: "坏" }, NOT_CHECKED), "broken", "浏览器型站点的坏定义也是 broken");

/* ---------------- 收尾 ---------------- */

console.log("\n" + "-".repeat(60));
if (fail) {
  console.log(` 通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(1);
} else {
  console.log(` 全部通过（${pass} 项）`);
}
