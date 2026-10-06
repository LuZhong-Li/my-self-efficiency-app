/* 首页双视图的纯逻辑测试：只测 home-view.js 里不碰 DOM 的那部分。
 * 跑法：node tests\首页视图.test.mjs   （本机 Node v24，不需要 package.json）
 * 说明：这个测试不进「自检.cmd」——自检是给用户一键跑的，保持纯 Python。 */

import {
  normalizeHomeView, rows, weekStartOf, todayTasks, overdueTasks, HOME_TASK_LIMIT,
  progressOf, summaryOf, cardOf, cardsFor, hasData, otherVisibleIn,
  debtWarningOf, financeBriefOf, financeTextOf,
} from "../app/web/home-view.js";
import { SUMMARY_MODULES } from "../app/web/modules.js";

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

const TODAY = "2026-10-07"; // 周三，所在周的周一是 10-05

const DATA = {
  memo: "演示数据",
  settings: { theme: "light", skin: "glass" },
  tasks: [
    { id: "t1", text: "把论文提纲列出来", date: TODAY, time: "09:00", category: "工作", done: false, createdAt: "2026-10-06 09:00" },
    { id: "t2", text: "数学刷题 10 道", date: TODAY, time: "10:30", category: "工作", done: true, createdAt: "2026-10-06 09:01" },
    { id: "t3", text: "跑步 5 公里", date: TODAY, time: "19:30", category: "运动", done: true, createdAt: "2026-10-06 09:02" },
    { id: "t4", text: "给家里打个电话", date: TODAY, time: "21:00", category: "生活", done: false, createdAt: "2026-10-06 09:03" },
    { id: "t5", text: "回一下邮件", date: TODAY, time: "", category: "工作", done: false, createdAt: "2026-10-06 09:04" },
    { id: "t6", text: "买菜", date: TODAY, time: "", category: "生活", done: false, createdAt: "2026-10-06 09:05" },
    { id: "t7", text: "昨天没做完的事", date: "2026-10-06", time: "", category: "工作", done: false, createdAt: "2026-10-05 09:00" },
  ],
  contents: [
    { id: "c1", topic: "选题 A", status: "待发布", platform: "小红书" },
    { id: "c2", topic: "选题 B", status: "待发布", platform: "公众号" },
    { id: "c3", topic: "选题 C", status: "想法", platform: "小红书" },
    { id: "c4", topic: "选题 D", status: "写作中", platform: "小红书" },
    { id: "c5", topic: "选题 E", status: "已发布", platform: "小红书", publishDate: "2026-10-02" },
    { id: "c6", topic: "选题 F", status: "已发布", platform: "小红书", publishDate: "2026-10-04" },
  ],
  projects: [
    { id: "p1", name: "小李", status: "进行中" },
    { id: "p2", name: "木子", status: "进行中" },
    { id: "p3", name: "旧项目", status: "已归档" },
  ],
  issues: [
    { id: "i1", projectId: "p1", title: "搜索面板点不动", status: "未解决" },
    { id: "i2", projectId: "p2", title: "弹窗一闪就没", status: "已解决" },
    { id: "i3", projectId: "p1", title: "月历格子挤", status: "未解决" },
  ],
  subjects: [],
  studies: [
    { id: "s1", date: "2026-10-05", subjectId: "sub1", minutes: 120, content: "第 3 章", reviewed: false },
    { id: "s2", date: "2026-10-06", subjectId: "sub1", minutes: 220, content: "第 4 章", reviewed: false },
    { id: "s3", date: "2026-09-20", subjectId: "sub1", minutes: 60, content: "第 1 章", reviewed: true },
  ],
  finance: {
    transactions: [
      { id: "x1", type: "expense", amountCents: 16880, date: TODAY, category: "餐饮", accountId: "a1", note: "" },
      { id: "x2", type: "income", amountCents: 800000, date: "2026-10-05", category: "工资", accountId: "a1", note: "" },
      { id: "x3", type: "expense", amountCents: 25870, date: "2026-10-03", category: "购物", accountId: "a1", note: "" },
    ],
  },
  debt: {
    items: [
      { id: "d1", name: "花呗", type: "oweOthers", totalCents: 35000, creditor: "支付宝", dueDate: "2026-10-20", note: "", status: "pending", repayments: [] },
      { id: "d2", name: "欠朋友", type: "oweOthers", totalCents: 20000, creditor: "老王", dueDate: "2026-10-01", note: "", status: "pending", repayments: [] },
      { id: "d3", name: "信用卡", type: "oweOthers", totalCents: 50000, creditor: "招行", dueDate: "2026-10-09", note: "", status: "pending", repayments: [] },
    ],
  },
  workoutLogs: [
    { id: "w1", date: "2026-10-05", moves: "深蹲" },
    { id: "w2", date: TODAY, moves: "卧推" },
  ],
  weights: [],
  meals: [{ id: "m1", date: TODAY, breakfast: "包子", lunch: "面", dinner: "", snack: "苹果" }],
  water: [{ id: "wa1", date: TODAY, cups: 6 }],
  games: [
    { id: "g1", name: "塞尔达传说：王国之泪", platform: "Switch", status: "在玩" },
    { id: "g2", name: "空洞骑士", platform: "PC", status: "已通关" },
  ],
};

console.log("home-view.js：视图归属");
eq(normalizeHomeView("full"), "full", "认得出完整模式");
eq(normalizeHomeView("simple"), "simple", "认得出简洁模式");
eq(normalizeHomeView(undefined), "simple", "没设置过 → 简洁（默认）");
eq(normalizeHomeView("乱写的"), "simple", "认不出 → 简洁，不崩");

console.log("home-view.js：取表与周起点");
eqDeep(rows(DATA, "finance.transactions").map((t) => t.id), ["x1", "x2", "x3"], "带点的路径能取到嵌套表");
eqDeep(rows(DATA, "没这个键"), [], "缺键给空数组，不抛");
eqDeep(rows(null, "tasks"), [], "连数据都没有时也给空数组");
eq(weekStartOf("2026-10-07"), "2026-10-05", "周三 → 本周一");
eq(weekStartOf("2026-10-05"), "2026-10-05", "周一 → 它自己");
eq(weekStartOf("2026-10-11"), "2026-10-05", "周日算这一周的最后一天，不是下一周");

console.log("home-view.js：今日进度");
eq(HOME_TASK_LIMIT, 5, "简洁模式最多列 5 条");
const p = progressOf(DATA, TODAY);
eq(p.total, 6, "今天 6 条任务");
eq(p.done, 2, "做完 2 条");
eq(p.open, 4, "没做完 4 条");
eq(p.untimed, 2, "待安排 2 条（没填时间点）");
eq(p.percent, 33, "2 / 6 → 33%");
eq(p.shown.length, 5, "只列前 5 条");
eq(p.hidden, 1, "还有 1 条没列出来");
eqDeep(p.shown.map((t) => t.id), ["t1", "t4", "t5", "t6", "t2"],
  "没做完的在前、按时间点排，做完的排最后");
eqDeep(todayTasks(DATA.tasks, TODAY).map((t) => t.id), ["t1", "t4", "t5", "t6", "t2", "t3"],
  "todayTasks 给全量且顺序一致");
eq(progressOf({ tasks: [] }, TODAY).percent, 0, "一条都没有时进度是 0，不出现除零");
eq(progressOf({ tasks: [] }, TODAY).shown.length, 0, "一条都没有时列表也是空的");
eqDeep(overdueTasks(DATA, TODAY).map((t) => t.id), ["t7"], "昨天没做完的进遗留提醒");
eqDeep(overdueTasks({ tasks: [{ id: "a", date: TODAY, done: false }] }, TODAY), [],
  "今天的不算遗留");

console.log("home-view.js：卡片正面与提示");
eq(cardOf("media", DATA, TODAY).main, "2 条待发布", "自媒体只留核心数字");
eq(cardOf("media", DATA, TODAY).tip, "想法 1 · 写作中 1 · 已发布 2", "自媒体的次要信息进提示");
eq(cardOf("dev", DATA, TODAY).main, "2 个项目进行中", "开发工作");
eq(cardOf("dev", DATA, TODAY).tip, "未解决 bug 2 条", "开发工作的提示");
eq(cardOf("study", DATA, TODAY).main, "本周学了 340 分钟", "学习工作按本周合计");
eq(cardOf("study", DATA, TODAY).tip, "待复习 2 条", "学习工作的提示");
eq(cardOf("fitness", DATA, TODAY).main, "本周练了 2 次", "健身按去重的天数算");
eq(cardOf("fitness", DATA, TODAY).tip, "最近一次训练：2026-10-07", "健身的提示（spec 的文案）");
eq(cardOf("diet", DATA, TODAY).main, "今天记了 3 餐", "饮食数填了的餐");
eq(cardOf("diet", DATA, TODAY).tip, "喝水 6 杯", "饮食的提示");
eq(cardOf("game", DATA, TODAY).main, "在玩 1 款", "游戏只数在玩的");
eq(cardOf("game", DATA, TODAY).tip, "塞尔达传说：王国之泪", "游戏的提示");
eq(cardOf("finance", DATA, TODAY).main, "今日支出 ¥168.80", "记账卡正面");
eq(cardOf("finance", DATA, TODAY).sub, "本月结余 ¥7,572.50", "完整模式下记账卡的第二行");
eq(cardOf("fitness", { ...DATA, workoutLogs: [] }, TODAY).main, "本周练了 0 次", "没数据时给数字而不是空白");
eq(cardOf("dev", DATA, TODAY).extra, "", "没有额外信息时 extra 是空串，不是 undefined");

console.log("home-view.js：哪个视图显示哪些卡");
eqDeep(cardsFor("simple", DATA, TODAY).highlight.map((c) => c.id), ["media", "dev", "study"],
  "简洁模式默认 3 张：记账在核心区的财务摘要里，不重复出现");
eqDeep(cardsFor("simple", DATA, TODAY).other.map((c) => c.id), ["fitness", "diet", "game"],
  "简洁模式的「其他模块」是这三张");
eqDeep(cardsFor("full", DATA, TODAY).highlight.map((c) => c.id), SUMMARY_MODULES,
  "完整模式仍然是原来那 7 张、原来的顺序");
eq(otherVisibleIn(DATA), true, "其他模块里有数据 → 折叠面板露脸");
eq(otherVisibleIn({ tasks: [] }), false, "三个次要模块都没数据 → 折叠面板整个隐藏");
eq(hasData("game", DATA), true, "游戏有记录");
eq(hasData("game", { games: [] }), false, "游戏没记录");
eq(hasData("diet", { meals: [{ date: TODAY }] }), true, "饮食记了饭就算有数据");

console.log("home-view.js：财务摘要与债务预警");
const brief = financeBriefOf(DATA, TODAY);
eq(brief.hasAny, true, "有账目");
eq(brief.hasTodayExpense, true, "今天有支出");
eq(brief.expense, "¥168.80", "今日支出");
eq(brief.balance, "¥7,572.50", "本月结余 = 收入 8000 − 支出 427.50");
eq(brief.debt.level, "overdue", "最近一笔是逾期的");
eq(brief.debt.name, "欠朋友", "取到期最近的那一笔");
eq(brief.debt.text, "已逾期：欠朋友 ¥200.00", "逾期文案");
eq(brief.debt.tip, "已经过了 6 天", "逾期的 hover 提示");

const onlySoon = { debt: { items: [DATA.debt.items[2]] }, finance: { transactions: [] } };
eq(debtWarningOf(onlySoon, TODAY).level, "soon", "2 天后到期 → 提示档");
eq(debtWarningOf(onlySoon, TODAY).text, "近 7 天待还：信用卡 ¥500.00", "7 天内的文案");
eq(debtWarningOf(onlySoon, TODAY).tip, "2 天后到期", "7 天内的提示");

const dueToday = { debt: { items: [{ ...DATA.debt.items[2], dueDate: TODAY }] } };
eq(debtWarningOf(dueToday, TODAY).tip, "今天到期", "当天到期这么说");

const farAway = { debt: { items: [DATA.debt.items[0]] } }; // 10-20，还有 13 天
eq(debtWarningOf(farAway, TODAY), null, "8 天以外的不进预警");
eq(debtWarningOf({}, TODAY), null, "一笔债务都没有 → 不显示那一行");
eq(debtWarningOf({ debt: { items: [{ ...DATA.debt.items[1], status: "done" }] } }, TODAY), null,
  "结清的债务不进预警");

const empty = { finance: { transactions: [] } };
const emptyText = financeTextOf(financeBriefOf(empty, TODAY));
eq(emptyText.expenseText, "今日暂无支出", "没有账目时说人话，不写 ¥0.00");
eq(emptyText.balanceText, "", "没有账目时不显示本月结余");
eq(financeTextOf(brief).expenseText, "¥168.80", "有支出就显示金额");
eq(financeTextOf(brief).balanceText, "¥7,572.50", "有账目就显示本月结余");

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
