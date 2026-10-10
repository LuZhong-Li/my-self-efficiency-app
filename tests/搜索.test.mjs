/* 全局搜索的纯逻辑测试：只测 search-calc.js 里不碰 DOM 的那部分。
 * 跑法：node tests\搜索.test.mjs   （本机 Node v24，不需要 package.json）
 * 说明：这个测试不进「自检.cmd」——自检是给用户一键跑的，保持纯 Python。 */

import {
  normalizeText, buildSearchPool, searchAll, SOURCE_SPECS,
} from "../app/web/search-calc.js";

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

function ok(cond, label) {
  eq(Boolean(cond), true, label);
}

/* 一份小号但字段齐的样例数据：每个模块至少一条，方便断言「都进池子了」。
 * 字段名照抄 app\web\item-form.js 和 数据\数据.json 的约定。 */
const DATA = {
  memo: "随手记：把搜索做成全模块的",
  tasks: [
    { id: "t1", text: "把论文提纲列出来", date: "2026-10-08", category: "工作", note: "先写粗纲", belong: "plan", isArchived: false },
    { id: "t2", text: "跑步 5 公里", date: "2026-10-07", category: "运动", note: "", belong: "plan", isArchived: false },
    { id: "t9", text: "去年就归档的旧事", date: "2025-01-01", category: "工作", note: "", belong: "plan", isArchived: true, archivedAt: "2026-01-01" },
  ],
  contents: [
    { id: "c1", title: "一个人住的收纳心得", platform: "小红书", status: "撰写中", note: "脚本写了一半点" },
  ],
  mediaAccounts: [
    { id: "ma1", name: "小红书小李", platform: "小红书", intro: "学习方法和收纳", note: "" },
  ],
  projects: [
    { id: "p1", name: "房间收纳改造", status: "进行中", intro: "把阳台用起来", description: "" },
  ],
  issues: [
    { id: "i1", title: "切模块时输入框焦点丢了", desc: "复现步骤：切走再切回来", module: "通用", severity: "中", status: "进行中", isArchived: false },
    { id: "i8", title: "归档很久的老问题", desc: "", module: "通用", severity: "低", status: "已关闭", isArchived: true, archivedAt: "2026-01-01" },
  ],
  progress: [
    { id: "pr1", text: "把搜索池重写了一遍", date: "2026-10-09" },
  ],
  subjects: [
    { id: "s1", name: "高等数学（上）", source: "B 站", note: "每周三次", kind: "视频" },
  ],
  studies: [
    { id: "st1", content: "极限与连续", takeaway: "洛必达法则还挺好使", date: "2026-09-18" },
  ],
  workoutLogs: [
    { id: "w1", date: "2026-09-27", moves: "深蹲 3×12 / 硬拉 3×8", note: "配速 6'20\"" },
  ],
  weights: [
    { id: "wt1", date: "2026-10-01", kg: 70.5, bodyFat: 18 },
  ],
  meals: [
    { id: "m1", date: "2026-10-08", breakfast: "包子豆浆", lunch: "", dinner: "外卖 黄焖鸡", snack: "" },
  ],
  water: [
    { id: "wa1", date: "2026-10-08", cups: 6 },
  ],
  games: [
    { id: "g1", name: "塞尔达传说：王国之泪", platform: "Switch", status: "在玩", progress: "主线第三章" },
  ],
  gameRecords: [
    { id: "r1", gameId: "g1", gameName: "塞尔达传说：王国之泪", playDate: "2026-10-08", remark: "打完一个神庙" },
  ],
  finance: {
    transactions: [
      { id: "tx1", type: "expense", amountCents: 2550, date: "2026-10-05", category: "餐饮", note: "午饭 黄焖鸡" },
      { id: "tx2", type: "expense", amountCents: 220000, date: "2026-10-01", category: "住房", note: "房租" },
    ],
    accounts: [
      { id: "a1", name: "微信", initialBalanceCents: 0 },
    ],
  },
  debt: {
    items: [
      { id: "d1", name: "花呗", creditor: "支付宝", note: "每月 20 号还款", dueDate: "2026-10-20", totalCents: 350000, status: "pending", repayments: [] },
    ],
  },
};

console.log("normalizeText");
eq(normalizeText("  Hello\nWorld  "), "hello world", "小写、换行压成空格、掐首尾");
eq(normalizeText("A\t\tB   C"), "a b c", "Tab 和连续空格压成一个");
eq(normalizeText(null), "", "null → 空串");
eq(normalizeText(undefined), "", "undefined → 空串");
eq(normalizeText(2550), "2550", "数字也能比");

console.log("buildSearchPool：每个模块的表都进池子");
const pool = buildSearchPool(DATA);
const expectedCount = SOURCE_SPECS.reduce((n, spec) => {
  const parts = spec.table.split(".");
  let holder = DATA;
  for (const p of parts) holder = holder ? holder[p] : null;
  return n + (Array.isArray(holder) ? holder.length : 0);
}, 0);
eq(pool.length, expectedCount, "池子条数 = 各表条数之和（一条不落、也不重复）");
for (const spec of SOURCE_SPECS) {
  ok(pool.some((it) => it.module === spec.module && it.label === spec.label),
    `模块「${spec.label}」在池子里`);
}
ok(pool.every((it) => it.hash && it.label && it.hay), "每条都带跳转地址、标签和可搜文本");

console.log("不改传进来的数据");
const snapshot = JSON.stringify(DATA);
buildSearchPool(DATA);
searchAll(DATA, "健身");
eq(JSON.stringify(DATA), snapshot, "搜一遍之后原始数据一个字节都没变");

console.log("各模块都搜得到（就是这次要修的 bug）");
const textsOf = (q) => searchAll(DATA, q).map((h) => h.text);
ok(textsOf("焦点").includes("切模块时输入框焦点丢了"), "bug 记录（问题标题）搜得到");
ok(textsOf("午饭").includes("午饭 黄焖鸡"), "记账流水（备注）搜得到");
ok(textsOf("餐饮").includes("餐饮"), "记账流水（分类）搜得到");
ok(textsOf("2200").includes("2200"), "记账里按金额也能搜");
ok(textsOf("深蹲").includes("深蹲 3×12 / 硬拉 3×8"), "健身打卡搜得到");
ok(textsOf("70.5").includes("70.5 kg"), "体重记录搜得到");
ok(textsOf("收纳").includes("一个人住的收纳心得"), "自媒体作品搜得到");
ok(textsOf("神庙").includes("打完一个神庙"), "游玩记录搜得到");
ok(textsOf("洛必达").includes("洛必达法则还挺好使"), "学习心得搜得到");
ok(textsOf("黄焖鸡").includes("外卖 黄焖鸡"), "饮食记录搜得到");
ok(textsOf("花呗").includes("花呗"), "债务搜得到");
ok(textsOf("查无此词").length === 0, "查无此词就返回空，不硬凑");

console.log("按模块名 / 别称也能带出记录");
ok(searchAll(DATA, "健身").length > 0, "搜「健身」带出健身模块的记录");
ok(searchAll(DATA, "记账").length > 0, "搜「记账」带出记账模块的记录");
ok(searchAll(DATA, "bug").some((h) => h.label === "问题"), "搜「bug」带出问题记录");
ok(searchAll(DATA, "自媒体").length > 0, "搜「自媒体」带出作品和账号");
ok(searchAll(DATA, "喝水").some((h) => h.label === "饮水"), "搜「喝水」带出饮水记录");

console.log("排序：命中标题的排在只命中模块名/别称的前面");
{
  const hits = searchAll(DATA, "收纳");
  ok(hits.length > 0 && hits[0].text.includes("收纳"), "内容命中的排第一");
  ok(hits.every((h, i) => i === 0 || hits[i - 1].score >= h.score), "分数从高到低");
}

console.log("归档：默认不搜，勾上「包含归档记录」才搜得到");
ok(!searchAll(DATA, "归档很久").length, "默认搜不到归档的问题");
ok(searchAll(DATA, "归档很久", true).length === 1, "包含归档时搜得到");
ok(!searchAll(DATA, "去年就归档").length, "默认搜不到归档的待办");
ok(searchAll(DATA, "去年就归档", true).length === 1, "包含归档时搜得到");

console.log("不提前截断：排在最后一张表的记录也得能搜到");
{
  // 以前扫到 12 条就直接 return，后面的表永远轮不到。这里让前面几张表都用
  // 同一个词「查」凑够 12 条以上，最后一张表（债务）的命中必须还在。
  const many = {
    tasks: Array.from({ length: 8 }, (_, i) => ({
      id: "t" + i, text: `查资料 ${i}`, date: "2026-10-01", category: "工作",
    })),
    contents: Array.from({ length: 8 }, (_, i) => ({
      id: "c" + i, title: `查一下选题 ${i}`, platform: "小红书", status: "想法",
    })),
    debt: { items: [{ id: "d1", name: "查一下这笔债", creditor: "", note: "", totalCents: 1000 }] },
  };
  const hits = searchAll(many, "查");
  eq(hits.length, 17, "17 条命中一条不落（不截断）");
  ok(hits.some((h) => h.label === "债务"), "最后一张表的命中还在（修的就是这个）");
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
