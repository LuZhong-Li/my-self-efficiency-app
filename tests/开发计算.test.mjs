/* 开发工作纯逻辑的单元测试：只测 app/web/dev-calc.js。
 * 跑法：node tests\开发计算.test.mjs   （本机 Node v24，不需要 package.json）
 * 说明：和别的 .test.mjs 一样，不进「自检.cmd」——自检是给用户一键跑的，保持纯 Python。 */

import {
  SEVERITY, ISSUE_STATUS, ISSUE_MODULES, DEFAULT_ISSUE_MODULE,
  normalizeStatus, isIssueClosed, normalizeSeverity, normalizeModule,
  normalizeIssue, normalizeProgress, normalizeTodo, issueStats, matchIssue, cycleDays, progressSorted,
  ARCHIVE_FILTER, ARCHIVE_FILTER_LABEL, normalizeArchiveFilter, archivedOf, matchArchive,
} from "../app/web/dev-calc.js";

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

/* ---------------- 状态 ---------------- */

eqDeep(ISSUE_STATUS, ["待处理", "进行中", "已复现", "已修复", "已关闭"], "状态是这五个，按顺序");
eqDeep(SEVERITY, ["高", "中", "低"], "优先级还是高/中/低");
eq(ISSUE_MODULES[0], "通用", "关联模块第一个是「通用」");
eq(ISSUE_MODULES.includes("记账"), true, "关联模块里有记账");
eq(ISSUE_MODULES.includes("数据与设置"), true, "关联模块跟模块清单走，不是写死的四个");
eq(DEFAULT_ISSUE_MODULE, "通用", "默认关联模块是通用");

eq(normalizeStatus("处理中"), "进行中", "老状态「处理中」迁成「进行中」");
eq(normalizeStatus("已解决"), "已修复", "老状态「已解决」迁成「已修复」");
eq(normalizeStatus("待处理"), "待处理", "认得出的原样返回");
eq(normalizeStatus("已复现"), "已复现", "新加的「已复现」认得出");
eq(normalizeStatus("随便写的"), "待处理", "认不出的退回待处理");
eq(normalizeStatus(""), "待处理", "空字符串退回待处理");
eq(normalizeStatus(null), "待处理", "null 也退回待处理");
eq(normalizeStatus("  已修复  "), "已修复", "两边带空格也认");

eq(isIssueClosed("已修复"), true, "已修复算结");
eq(isIssueClosed("已关闭"), true, "已关闭算结");
eq(isIssueClosed("已解决"), true, "老名字「已解决」也当结（数据文件还没保存过时会出现）");
eq(isIssueClosed("待处理"), false, "待处理没结");
eq(isIssueClosed("进行中"), false, "进行中没结");
eq(isIssueClosed("已复现"), false, "已复现没结（复现出来还没修）");
eq(isIssueClosed(""), false, "空状态没结");

eq(normalizeSeverity("高"), "高", "优先级认得出就原样");
eq(normalizeSeverity("紧急"), "中", "认不出的优先级退回中");
eq(normalizeModule("记账"), "记账", "关联模块认得出就原样");
eq(normalizeModule("笔记"), "通用", "模块清单里没有的退回通用");
eq(normalizeModule(""), "通用", "空模块退回通用");

/* ---------------- 条目规整 ---------------- */

const older = normalizeIssue({ id: "i1", title: "弹窗一闪就没", status: "已解决", severity: "高" });
eq(older.status, "已修复", "老条目读出来状态已经迁好");
eq(older.desc, "", "老条目没有详细描述 → 空串（不是 undefined）");
eq(older.module, "通用", "老条目没有关联模块 → 通用");
eqDeep(older.imagePaths, [], "老条目没有图片 → 空数组");
eq(older.createdAt, "", "老条目没有创建时间 → 空串");

const full = normalizeIssue({
  id: "i2", projectId: "p1", title: "月历在小窗口下挤", desc: "复现步骤：\n1. 把窗口拉窄",
  severity: "低", status: "已复现", module: "记账",
  imagePaths: ["attachments/buglog/20261007_ab12cd34.png"],
  createdAt: "2026-10-01 09:00", fixedAt: "",
});
eq(full.desc, "复现步骤：\n1. 把窗口拉窄", "详细描述原样带出来（多行不丢）");
eq(full.imagePaths.length, 1, "图片路径带出来");

eqDeep(normalizeIssue(null), normalizeIssue({}), "null 和空对象规整成一样的东西");
eq(normalizeIssue({ imagePaths: "不是数组" }).imagePaths.length, 0, "图片字段被写坏了也不是数组就空数组");

const prog = normalizeProgress({ id: "g1", date: "2026-10-07", text: "首页改版", imagePaths: ["a"] });
eqDeep(prog, { id: "g1", projectId: "", date: "2026-10-07", text: "首页改版", imagePaths: ["a"] },
  "进展条目规整（老条目没有 imagePaths 就是空数组）");
eqDeep(normalizeProgress({}), { id: "", projectId: "", date: "", text: "", imagePaths: [] },
  "空进展规整成空壳");

/* ---------------- 统计 ---------------- */

const MIX = [
  { id: "a", status: "待处理", severity: "高" },
  { id: "b", status: "待处理", severity: "低" },
  { id: "c", status: "进行中", severity: "中" },
  { id: "d", status: "已复现", severity: "高" },
  { id: "e", status: "已修复", severity: "中" },
  { id: "f", status: "已关闭", severity: "低" },
  { id: "g", status: "已解决", severity: "低" },   // 老名字，算已修复
  { id: "h", status: "处理中", severity: "低" },   // 老名字，算进行中
];
const S = issueStats(MIX);
eq(S.total, 8, "一共 8 条");
eq(S.pending, 2, "待处理 2 条");
eq(S.doing, 2, "进行中 2 条（含老名字「处理中」那条）");
eq(S.reproduced, 1, "已复现 1 条");
eq(S.fixed, 2, "已修复 2 条（含老名字「已解决」那条）");
eq(S.closed, 1, "已关闭 1 条");
eq(S.open, 5, "未解决 = 待处理 + 进行中 + 已复现 = 5");
eq(issueStats([]).open, 0, "一条都没有时不炸");
eq(issueStats(null).total, 0, "连数组都没有也不炸");

/* ---------------- 筛选 ---------------- */

eq(matchIssue(MIX[0], {}), true, "什么都不筛就是全都过");
eq(matchIssue(MIX[0], { status: "待处理" }), true, "状态对得上就过");
eq(matchIssue(MIX[2], { status: "待处理" }), false, "状态对不上就不过");
eq(matchIssue(MIX[2], { status: "进行中" }), true, "进行中筛得出");
eq(matchIssue(MIX[2], { severity: "高" }), false, "优先级对不上就不过");
eq(matchIssue(MIX[0], { severity: "高" }), true, "优先级对得上就过");
eq(matchIssue({ module: "记账" }, { module: "记账" }), true, "模块筛得出");
eq(matchIssue({ module: "记账" }, { module: "自媒体" }), false, "模块不匹配就不过");
eq(matchIssue({ module: "" }, { module: "通用" }), true, "没写模块的算通用，筛通用能筛到");
eq(matchIssue({ title: "月历在小窗口下挤" }, { kw: "窗口" }), true, "标题命中关键词");
eq(matchIssue({ desc: "复现步骤：把窗口拉窄" }, { kw: "复现步骤" }), true, "详细描述也算命中");
eq(matchIssue({ module: "记账" }, { kw: "记账" }), true, "关联模块也算命中");
eq(matchIssue({ title: "首页慢" }, { kw: "记账" }), false, "都没命中就不过");
eq(matchIssue({ title: "ABC" }, { kw: "abc" }), true, "关键词不区分大小写");
eq(matchIssue({ title: "月历挤", status: "待处理", severity: "高" }, { status: "待处理", severity: "高", kw: "月历" }),
  true, "三个条件同时满足才算过");

/* ---------------- 迭代周期 ---------------- */

eq(cycleDays({ createdAt: "2026-10-01 09:00", fixedAt: "2026-10-04 18:30" }), 3, "10-01 到 10-04 是 3 天");
eq(cycleDays({ createdAt: "2026-10-01 09:00", fixedAt: "2026-10-01 23:59" }), 0, "当天修好就是 0 天");
eq(cycleDays({ createdAt: "2026-10-01 09:00", fixedAt: "" }), null, "还没修好 → 没有天数");
eq(cycleDays({ createdAt: "", fixedAt: "2026-10-04" }), null, "没有创建时间 → 没有天数");
eq(cycleDays({ createdAt: "2026-10-05", fixedAt: "2026-10-01" }), null, "修复时间早于创建时间 → 不认（数据被改坏了）");
eq(cycleDays({}), null, "什么都没有 → null");

/* ---------------- 进展排序 ---------------- */

const P = progressSorted([
  { id: "1", date: "2026-10-05", text: "第一件" },
  { id: "2", date: "2026-10-07", text: "第二件" },
  { id: "3", date: "2026-10-07", text: "第三件" },
  { id: "4", date: "2026-09-30", text: "很久以前" },
]);
eqDeep(P.map((p) => p.id), ["3", "2", "1", "4"], "按日期从新到旧；同一天后记的排前面");
eq(progressSorted([]).length, 0, "空数组不炸");
eq(progressSorted(null).length, 0, "null 不炸");
eq(progressSorted([{ date: "2026-10-07", text: "带图的", imagePaths: ["x"] }])[0].imagePaths[0], "x",
  "排序之后图片路径还在");

/* ---------------- 归档：标记 / 档位 / 统计 / 筛选 ---------------- */

eqDeep(ARCHIVE_FILTER, ["no", "only", "all"], "归档三个档位：未归档 / 仅归档 / 全部");
eq(ARCHIVE_FILTER_LABEL.only, "仅归档", "档位有中文名");

eq(archivedOf({ isArchived: true }), true, "标了 isArchived: true 就是归档了");
eq(archivedOf({ isArchived: false }), false, "isArchived: false 是没归档");
eq(archivedOf({}), false, "老数据没这个字段 → 当没归档（不用搬数据）");
eq(archivedOf(null), false, "null 不炸");
eq(archivedOf({ isArchived: "true" }), false, "只认真正的布尔 true，字符串不算");

eq(normalizeArchiveFilter("only"), "only", "认得出的档位原样");
eq(normalizeArchiveFilter("随便写的"), "no", "认不出退回「未归档」");
eq(normalizeArchiveFilter(undefined), "no", "不给就默认未归档");

const rows = [{ id: "a", isArchived: true }, { id: "b" }, { id: "c", isArchived: false }];
eqDeep(rows.filter((r) => matchArchive(r, "no")).map((r) => r.id), ["b", "c"],
  "「未归档」只留没归档的");
eqDeep(rows.filter((r) => matchArchive(r, "only")).map((r) => r.id), ["a"], "「仅归档」只留归档的");
eqDeep(rows.filter((r) => matchArchive(r, "all")).map((r) => r.id), ["a", "b", "c"], "「全部」都留");
eqDeep(rows.filter((r) => matchArchive(r)).map((r) => r.id), ["b", "c"], "不传档位默认按未归档");

const oldIssue = normalizeIssue({ id: "i-old", title: "老条目" });
eq(oldIssue.isArchived, false, "老 bug 读出来默认没归档");
eq(oldIssue.archivedAt, "", "老 bug 的归档时间是空串（不是 undefined）");
const keptIssue = normalizeIssue({ id: "i-keep", title: "归档条目",
  isArchived: true, archivedAt: "2026-10-08 10:00" });
eq(keptIssue.isArchived, true, "归档标记带出来");
eq(keptIssue.archivedAt, "2026-10-08 10:00", "归档时间带出来");

const todo = normalizeTodo({ id: "t1", belong: "dev:p1", text: "写文档", done: true,
  priority: "高", note: "顺手", imagePaths: ["a.png"],
  isArchived: true, archivedAt: "2026-10-08 09:00" });
eqDeep(todo, {
  id: "t1", belong: "dev:p1", text: "写文档", done: true, priority: "高", note: "顺手",
  imagePaths: ["a.png"], createdAt: "", doneAt: "",
  isArchived: true, archivedAt: "2026-10-08 09:00",
}, "待办规整：归档字段照搬，缺的补默认值");
eqDeep(normalizeTodo(null), normalizeTodo({}), "null 和空对象规整成一样的东西");
eq(normalizeTodo({ done: "yes" }).done, false, "done 只认真正的布尔 true");
eq(normalizeTodo({ imagePaths: "坏掉的" }).imagePaths.length, 0, "图片字段被写坏了也不炸");

const ARCH_MIX = [
  { id: "a1", status: "待处理", severity: "高" },
  { id: "a2", status: "已修复", severity: "中" },
  { id: "a3", status: "已修复", severity: "低", isArchived: true },
  { id: "a4", status: "进行中", severity: "高", isArchived: true },
];
eq(issueStats(ARCH_MIX).total, 2, "统计默认不数归档的");
eq(issueStats(ARCH_MIX).fixed, 1, "已修复的数里不含归档那条");
eq(issueStats(ARCH_MIX).open, 1, "未解决的数里不含归档那条");
eq(issueStats(ARCH_MIX, { includeArchived: true }).total, 4, "要看全量可以传 includeArchived");
eq(issueStats(ARCH_MIX, { includeArchived: true }).fixed, 2, "全量统计连归档的已修复一起数");

eq(matchIssue(ARCH_MIX[0], {}), true, "默认档位下，没归档的照常显示");
eq(matchIssue(ARCH_MIX[2], {}), false, "默认档位下，归档的不进主列表");
eq(matchIssue(ARCH_MIX[2], { archived: "all" }), true, "「全部」能把归档的放出来");
eq(matchIssue(ARCH_MIX[2], { archived: "only" }), true, "「仅归档」筛得到归档的");
eq(matchIssue(ARCH_MIX[0], { archived: "only" }), false, "「仅归档」不放过没归档的");
eq(matchIssue(ARCH_MIX[3], { archived: "only", status: "进行中", severity: "高" }), true,
  "归档档位和状态 / 优先级一起筛");
eq(matchIssue(ARCH_MIX[3], { archived: "only", status: "已修复" }), false,
  "归档档位和状态一起筛时，状态对不上就不过");
eq(matchIssue({ title: "归档了的标题", isArchived: true }, { kw: "归档", archived: "only" }), true,
  "归档条目也能按关键词筛（前提是档位放它出来）");
eq(matchIssue({ title: "归档了的标题", isArchived: true }, { kw: "归档" }), false,
  "档位没放开时，归档条目连关键词都命中不到（默认不搜归档）");

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
