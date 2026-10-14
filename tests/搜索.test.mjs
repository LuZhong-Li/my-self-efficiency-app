/* 全局搜索的纯逻辑测试：只测 search-calc.js 里不碰 DOM 的那部分。
 * 跑法：node tests\搜索.test.mjs   （本机 Node v24，不需要 package.json）
 * 说明：这个测试不进「自检.cmd」——自检是给用户一键跑的，保持纯 Python。 */

import {
  normalizeText, buildSearchPool, searchAll, SOURCE_SPECS, sourceRows,
  allTags, searchByTag,
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
    { id: "ma2", name: "B站小李", platform: "B站", intro: "做产品的过程记录", note: "周更" },
  ],
  mediaFollowers: [
    { id: "mf1", accountId: "ma2", date: "2026-10-06", count: 1200 },
    { id: "mf2", accountId: "ma1", date: "2026-10-04", count: 640 },
  ],
  // 素材也要在样例里有一条：上面那条「每个来源在池子里」的断言会挨个 spec 查
  mediaAssets: [
    { id: "as1", title: "样例素材", kind: "link", url: "https://example.com/a", note: "自检用" },
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
  workLogs: [
    { id: "wl1", date: "2026-10-14", projectId: "p1", minutes: 90,
      note: "把工时页画出来", tags: [] },
  ],
  foods: [
    { id: "fd1", name: "燕麦", unit: "100 克", kcal: 380, protein: 13, fat: 7,
      carb: 66, tags: [] },
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
    { id: "wt2", date: "2026-10-08", kg: 63.2, bodyFat: 17.5 },
  ],
  meals: [
    { id: "m1", date: "2026-10-08", breakfast: "包子豆浆", lunch: "", dinner: "外卖 黄焖鸡", snack: "" },
  ],
  water: [
    { id: "wa1", date: "2026-10-08", cups: 6 },
    // 另一套形状：喝水量按毫升记、带备注（ml / note 有就一起搜）
    { id: "wa2", date: "2026-10-09", cups: 8, ml: 800, note: "早上喝水" },
  ],
  // 模块目标按模块 id 分桶，不是数组表 —— 两条各回自己的模块页
  moduleGoals: {
    fitness: [
      { id: "g-fit", moduleId: "fitness", moduleName: "健身计划", mainTarget: "3 个月减重到 65kg",
        cycle: "月度", startDate: "2026-09-08", endDate: "2026-12-07",
        dailyRule: "每周一三五力量训练", remark: "练完顺手记体重", isActive: true, autoTask: true },
    ],
    study: [
      { id: "g-study", moduleId: "study", moduleName: "学习工作", mainTarget: "把高数上册过完",
        cycle: "每日", startDate: "2026-09-18", endDate: "", dailyRule: "晚 7 点学两小时",
        remark: "", isActive: true, autoTask: true },
    ],
  },
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
    // 转账也要在样例里有一条：上面那条「每个来源在池子里」的断言会挨个 spec 查
    transfers: [
      { id: "tf-search", amountCents: 50000, date: "2026-10-06",
        fromAccountId: "a1", toAccountId: "a1", note: "样例转账" },
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
const expectedCount = SOURCE_SPECS.reduce((n, spec) => n + sourceRows(DATA, spec).length, 0);
eq(pool.length, expectedCount, "池子条数 = 各表条数之和（一条不落、也不重复）");
for (const spec of SOURCE_SPECS) {
  ok(pool.some((it) => it.label === spec.label),
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

console.log("饮水记录：杯数、毫升数、备注都搜得到");
ok(textsOf("6 杯").includes("6 杯"), "按杯数搜得到");
ok(textsOf("800").includes("800 ml"), "按毫升数搜得到（ml 形状的数据）");
ok(textsOf("早上喝水").includes("早上喝水"), "按备注搜得到");

console.log("模块目标：标题、数值、描述都搜得到，点结果回它自己那个模块");
ok(textsOf("减重").includes("3 个月减重到 65kg"), "健身目标（核心目标）搜得到");
ok(textsOf("65").includes("3 个月减重到 65kg"), "目标里的数值搜得到");
ok(searchAll(DATA, "力量").some((h) => h.label === "目标"), "自动任务规则（描述）搜得到");
ok(searchAll(DATA, "65").some((h) => h.label === "目标" && h.hash === "fitness"),
  "健身目标跳健身页（#fitness）");
ok(searchAll(DATA, "高数上册").some((h) => h.label === "目标" && h.hash === "study"),
  "学习目标跳学习页（#study）");

console.log("粉丝快照：粉丝数、平台、账号名都搜得到");
ok(textsOf("1200").includes("1200 粉"), "按粉丝数搜得到");
ok(searchAll(DATA, "B站").some((h) => h.label === "粉丝"),
  "按平台搜得到（平台得回账号表里取）");
ok(searchAll(DATA, "小红书").some((h) => h.label === "粉丝"), "另一个账号的快照也在池子里");
{
  const hit = searchAll(DATA, "1200").find((h) => h.label === "粉丝");
  eq(hit.text, "1200 粉", "命中粉丝数时正文就是那句话");
  ok(hit.module === "media" && hit.hash === "media", "点结果回自媒体页");
}

console.log("体重记录：kg 数值能搜（原来只能搜日期）");
ok(textsOf("63.2").includes("63.2 kg"), "按体重数值搜得到");
ok(textsOf("17.5").includes("17.5% 体脂"), "体脂数值照样搜得到");
ok(searchAll(DATA, "2026-10-08").some((h) => h.label === "体重"), "按日期搜得到（老行为没动）");

console.log("模块目标的桶形状放宽：单条、整体数组、认不出的模块 id");
{
  const one = buildSearchPool({ moduleGoals: { fitness: { moduleId: "fitness", mainTarget: "单条也认" } } });
  ok(one.some((it) => it.hay.includes("单条也认")), "一个模块直接摆一个对象也进池子");
  const arr = buildSearchPool({ moduleGoals: [{ moduleId: "study", mainTarget: "整体写成数组也认" }] });
  ok(arr.some((it) => it.hay.includes("整体写成数组也认")), "moduleGoals 整个是数组也进池子");
  const weird = buildSearchPool({ moduleGoals: { x: [{ moduleId: "没见过的模块", mainTarget: "认不出的模块" }] } });
  ok(weird.some((it) => it.hash === "home"), "认不出的 moduleId 落回首页，不给个死地址");
}

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

/* ---------------- 标签（2026-10-11 加的） ----------------
   标签是记录上的一个字符串数组；「全站有哪些标签」「点了某个标签捞哪几条」
   都在这儿算，界面那边只负责画。 */

const TAGGED = {
  tasks: [
    { id: "tg1", text: "把标签做出来", tags: ["工作", "本周"], belong: "plan" },
    { id: "tg2", text: "买菜", tags: ["生活"], belong: "plan" },
    { id: "tg3", text: "老记录没标签", belong: "plan" },
    { id: "tg4", text: "归档的旧事", tags: ["工作"], belong: "plan", isArchived: true },
  ],
  contents: [{ id: "tc1", title: "标签那期视频", tags: ["工作"], status: "想法" }],
  projects: [{ id: "tp1", name: "标签系统那个项目", tags: ["工作"] }],
  finance: {
    transactions: [
      { id: "tf1", note: "买标签纸", amountCents: 199, date: "2026-10-11", tags: ["生活"] },
    ],
  },
};

const tagList = allTags(TAGGED);
eq(tagList[0].name, "工作", "用得最多的标签排最前");
eq(tagList.find((t) => t.name === "工作").count, 3,
  "跨模块一起数：待办 + 作品 + 项目（归档那条不算）");
eq(tagList.find((t) => t.name === "生活").count, 2, "生活 2 次：待办 1 条 + 账目 1 条");
eq(tagList.length, 3, "一共三个标签：工作、生活、本周（没多出别的）");
eq(allTags({}).length, 0, "空数据没有标签，也不抛错");
eq(allTags(TAGGED).every((t) => t.count > 0), true, "计数都是正数");

const byTag = searchByTag(TAGGED, "工作");
eq(byTag.length, 3, "按标签捞到三条（没归档的）");
eq(byTag.some((h) => h.module === "plan" && h.text === "工作"), true,
  "待办那条：正文给的是标签本身，点下去就跳今日计划");
eq(byTag.some((h) => h.module === "media"), true, "跨模块：自媒体作品那条也在");
eq(searchByTag(TAGGED, "工作", true).length, 4, "勾上「包含归档记录」，归档那条才算进来");
eq(searchByTag(TAGGED, " 工作 ").length, 3, "前后带空格也认");
eq(searchByTag(TAGGED, "工作", true).some((h) => h.hash === "plan"), true,
  "结果里带着跳转地址（searchAll 那一套形状）");
eq(searchByTag(TAGGED, "没这个标签").length, 0, "没有的标签返回空");
eq(searchByTag(TAGGED, "").length, 0, "空标签返回空，不把整站捞出来");
eq(searchByTag(TAGGED, "工作", false, "视频").length, 1,
  "标签 + 关键词：只在贴了「工作」的里面再筛「视频」，只剩作品那条");
eq(searchByTag(TAGGED, "工作", false, "买菜").length, 0,
  "关键词筛没了就是空的（不会退回「只看标签」）");
eq(searchByTag(TAGGED, "工作", false, "  ").length, 3, "关键词只有空白等于没筛");

/* 标签进了匹配池：敲标签名 = 搜得到（和备注、分类一个待遇） */
eq(searchAll(TAGGED, "工作").length, 3, "敲「工作」搜得到贴了它的记录（归档那条不算）");
eq(searchAll(TAGGED, "工作").every((h) => h.text === "工作"), true,
  "命中标签时，卡片正文给的就是那个标签（不是整条记录的标题）");
eq(searchAll(TAGGED, "本周").length, 1, "只贴了一条记录的标签也搜得到");
eq(searchAll(TAGGED, "买菜").length, 1, "老行为没动：正文照样搜得到");

/* ---------------- 转账（2026-10-12 加的） ----------------
   转账只存账户 id，账户名要回 finance.accounts 里现取 ——
   和粉丝快照回账号表取名字一个做法。 */

const TF_DATA = {
  finance: {
    accounts: [{ id: "a1", name: "微信" }, { id: "a2", name: "招行卡" }],
    transfers: [
      { id: "tf1", amountCents: 100000, date: "2026-10-12", fromAccountId: "a1",
        toAccountId: "a2", note: "还信用卡" },
      { id: "tf2", amountCents: 20000, date: "2026-10-12", fromAccountId: "a2",
        toAccountId: "a1", note: "" },
    ],
  },
};

eq(searchAll(TF_DATA, "还信用卡").length, 1, "按备注搜得到转账");
eq(searchAll(TF_DATA, "还信用卡")[0].label, "转账", "卡片上的标签是「转账」");
eq(searchAll(TF_DATA, "还信用卡")[0].hash, "finance", "点结果回记账页");
eq(searchAll(TF_DATA, "招行").filter((h) => h.label === "转账").length, 2,
  "按账户名搜得到那两条转账（账户那一行本身也会中，所以只数「转账」标签的）");
eq(searchAll(TF_DATA, "1000").length, 1, "按金额搜得到（1000.00 那条）");
eq(searchAll(TF_DATA, "转账").length, 2, "搜模块别称「转账」把两条都带出来");
eq(searchAll(TF_DATA, "招行卡 → 微信").length, 1, "没写备注的那条，正文给的是「A → B」（方向照记录）");

/* ---------------- 素材（2026-10-14 加的） ---------------- */

const ASSET_DATA = {
  mediaAssets: [
    { id: "as1", title: "封面：标签系统那期", kind: "image",
      path: "attachments/media_asset/1.png", note: "B 站竖版" },
    { id: "as2", title: "素材站参考", kind: "link", url: "https://example.com/ref",
      note: "" },
  ],
};
eq(searchAll(ASSET_DATA, "标签系统").length, 1, "按标题搜得到素材");
eq(searchAll(ASSET_DATA, "标签系统")[0].label, "素材", "卡片上的标签是「素材」");
eq(searchAll(ASSET_DATA, "标签系统")[0].hash, "media", "点结果回自媒体页");
eq(searchAll(ASSET_DATA, "竖版").length, 1, "说明里也搜得到");
eq(searchAll(ASSET_DATA, "example.com").length, 1, "链接也进匹配");
eq(searchAll(ASSET_DATA, "media_asset").length, 0, "图片路径本身不搜（搜文件名没意义）");

console.log("\n【重复规则与子任务文字也进搜索池（2026-10-14 加的）】");
const REPEAT_DATA = { tasks: [
  { id: "t-rule-1", text: "跑步 5 公里", date: "", repeat: "每周一、三、五",
    belong: "plan", tags: [],
    subtasks: [{ id: "s1", text: "换跑鞋", done: false }] },
] };
eq(searchAll(REPEAT_DATA, "每周一").length, 1, "搜「每周一」找得到那条重复规则");
eq(searchAll(REPEAT_DATA, "每周一")[0].label, "待办", "它还挂在「待办」这枚标签下");
eq(searchAll(REPEAT_DATA, "换跑鞋").length, 1, "搜子任务的文字能带出父任务");
eq(searchAll(REPEAT_DATA, "换跑鞋")[0].text, "换跑鞋", "结果卡片上显示的是命中的那句子任务");
eq(searchAll(REPEAT_DATA, "跑步").length, 1, "正文照样搜得到");
eq(searchAll(REPEAT_DATA, "重复任务").length, 1, "搜「重复任务」也认得（同义词里加了这个词）");

console.log("\n【工时也进搜索池（2026-10-14 加的）】");
const WORK_DATA = {
  projects: [{ id: "p1", name: "工作台改造" }],
  workLogs: [{ id: "w1", date: "2026-10-14", projectId: "p1", minutes: 120,
               note: "画工时页", tags: [] }],
};
eq(searchAll(WORK_DATA, "画工时页").length, 1, "备注也进匹配");
eq(searchAll(WORK_DATA, "2026-10-14").length, 1, "日期也进匹配");
eq(searchAll(WORK_DATA, "画工时页")[0].label, "工时", "卡片上那枚标签写着「工时」");
eq(searchAll(WORK_DATA, "画工时页")[0].hash, "dev/hours", "点结果回工时页");
eq(searchAll(WORK_DATA, "画工时页")[0].module, "dev", "归在开发工作这个模块下");
// 搜项目名会同时命中「项目」那条本身，所以从命中里挑工时那一条来断言
ok(searchAll(WORK_DATA, "工作台改造").some((h) => h.label === "工时"),
  "搜项目名也能带出挂在它下面的工时");

console.log("\n【菜谱与吃了什么也进搜索池（2026-10-14 加的）】");
const NUTRITION_DATA = {
  foods: [{ id: "f1", name: "米饭", unit: "碗", kcal: 200, protein: 4, fat: 0.5,
            carb: 44, tags: [] }],
  meals: [{ id: "m1", date: "2026-10-14", breakfast: "米饭 + 鸡蛋", lunch: "", dinner: "",
            snack: "", items: [{ id: "i1", slot: "breakfast", name: "全麦面包",
            unit: "片", amount: 2, kcal: 90, protein: 3, fat: 1, carb: 17 }] }],
};
eq(searchAll(NUTRITION_DATA, "米饭").length, 2, "菜谱一条 + 那天的饮食记录一条");
eq(searchAll(NUTRITION_DATA, "全麦面包").length, 1, "搜条目里那样也能带出那天");
eq(searchAll(NUTRITION_DATA, "全麦面包")[0].label, "饮食", "带出来的是「饮食」那条");
const foodHits = searchAll(NUTRITION_DATA, "米饭").filter((h) => h.label === "菜谱");
eq(foodHits.length, 1, "菜谱那一条在");
eq(foodHits[0].hash, "diet/foods", "点菜谱回菜谱库");

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
