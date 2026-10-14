/* 自媒体模块的纯逻辑测试：只测不碰 DOM 的 media-calc.js。
 * 跑法：node tests\自媒体计算.test.mjs   （本机 Node v24，不需要 package.json）
 * 说明：这个测试不进「自检.cmd」——自检是给用户一键跑的，保持纯 Python。 */

import {
  PLATFORMS, STATUSES, ARCHIVED, statusesOf, isPublished, isArchived, platformSlug,
  fmtCount, contentsOfAccount, followersAt, followersSeries, viewsSeries,
  weekRangeOf, shiftDateStr, followersGain, growthText,
  isHit, avgViewsOf, hitLevelOf, activityOf, accountStats, overviewOf, overviewSeries,
  PLATFORM_LIMIT, PLATFORM_MAX_CHARS, normalizePlatforms, platformsOf, addPlatform, removePlatform,
  lastSnapshotOf,
  WORKS_CSV_HEAD, contentCsvRows, mediaCsv,
  recentDays, parseSnapshotLines, applySnapshots,
  ASSET_KINDS, normalizeAsset, assetsOf, assetUsage, assetsOfContent, unlinkAsset,
} from "../app/web/media-calc.js";
import { csvCell } from "../app/web/csv.js";

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

/* ---------- 固定的一份小数据，后面的断言都围着它 ---------- */

const TODAY = "2026-10-07"; // 周三，所在周的周一是 10-05

const ACCOUNTS = [
  { id: "a1", name: "B站小李", platform: "B站", baseFollowers: 1000, targetFollowers: 5000 },
  { id: "a2", name: "小红书小李", platform: "小红书", baseFollowers: 500, targetFollowers: 2000 },
];

// 10-01 记过一次快照：1200。所以 10-01 之后的作品涨粉才往上加
const SNAPS = [
  { id: "s1", accountId: "a1", date: "2026-10-01", count: 1200 },
];

const CONTENTS = [
  { id: "c1", title: "写作这件小事", accountId: "a1", platform: "B站", status: "已发布",
    publishDate: "2026-09-20", views: 5000, likes: 100, collects: 20, comments: 10, fansGain: 100 },
  { id: "c2", title: "笔记怎么整理", accountId: "a1", platform: "B站", status: "已发布",
    publishDate: "2026-10-03", views: 8000, likes: 200, collects: 30, comments: 20, fansGain: 200 },
  { id: "c3", title: "十月复盘", accountId: "a1", platform: "B站", status: "已发布",
    publishDate: "2026-10-05", views: 30000, likes: 900, collects: 100, comments: 80, fansGain: 300 },
  { id: "c4", title: "一个人住的收纳", accountId: "a1", platform: "B站", status: "待发布",
    planDate: "2026-10-10", views: 0, likes: 0, collects: 0, comments: 0, fansGain: 0 },
  { id: "c5", title: "小红的笔记", accountId: "a2", platform: "小红书", status: "已发布",
    publishDate: "2026-10-04", views: 2000, likes: 50, collects: 5, comments: 2, fansGain: 60 },
  { id: "c6", title: "老数据没账号", platform: "知乎", status: "想法" },
];

console.log("media-calc.js：清单与状态");
eq(PLATFORMS.length, 7, "平台清单 7 个（含「其他」）");
eq(PLATFORMS[0], "B站", "第一个是 B站");
eq(ARCHIVED, "废弃", "归档叫「废弃」");
eqDeep(statusesOf(), ["想法", "撰写中", "剪辑中", "待发布", "已发布"], "五条流水线");
eq(STATUSES.includes("写作中"), false, "「写作中」不在新清单里（老数据由服务端迁移）");
eq(isPublished({ status: "已发布" }), true, "已发布");
eq(isPublished({ status: "待发布" }), false, "待发布不是已发布");
eq(isArchived({ status: "废弃" }), true, "废弃是归档");
eq(isPublished(null), false, "空记录不炸");
eq(platformSlug("B站"), "bili", "B站 → bili");
eq(platformSlug("小红书"), "xhs", "小红书 → xhs");
eq(platformSlug("抖音"), "douyin", "抖音 → douyin");
eq(platformSlug("公众号"), "wechat", "公众号 → wechat");
eq(platformSlug("知乎"), "zhihu", "知乎 → zhihu");
eq(platformSlug("视频号"), "shipin", "视频号 → shipin");
eq(platformSlug("某不存在的平台"), "other", "认不出的平台 → other（不崩）");

console.log("\nmedia-calc.js：数字显示");
eq(fmtCount(0), "0", "0");
eq(fmtCount(326), "326", "三位数照原样");
eq(fmtCount(999), "999", "还不到一千");
eq(fmtCount(1000), "1k", "一千 → 1k");
eq(fmtCount(6200), "6.2k", "6200 → 6.2k");
eq(fmtCount(12689), "1.26w", "不到十万给两位（12689 → 1.26w）");
eq(fmtCount(486000), "48.6w", "十万以上给一位（486000 → 48.6w）");
eq(fmtCount(20000), "2w", "整万亿去掉多余的小数（20000 → 2w）");
eq(fmtCount(9999), "9.9k", "还不到一万时按 k 算");
eq(fmtCount(-326), "-326", "负数带负号（涨粉为负时要看得见）");

console.log("\nmedia-calc.js：作品归属");
eq(contentsOfAccount(ACCOUNTS[0], CONTENTS, ACCOUNTS).map((c) => c.id).join(),
  "c1,c2,c3,c4", "按 accountId 归到第一个账号");
eq(contentsOfAccount(ACCOUNTS[1], CONTENTS, ACCOUNTS).map((c) => c.id).join(),
  "c5", "第二个账号只有一条");
// 老数据没有 accountId：同平台只有一个账号时才归给它，两个同平台账号时谁也不认
eq(contentsOfAccount({ id: "a9", platform: "知乎" },
  [{ id: "x", platform: "知乎", status: "想法" }], [{ id: "a9", platform: "知乎" }]).length,
  1, "老作品按平台归给唯一的同平台账号");
eq(contentsOfAccount({ id: "a9", platform: "知乎" },
  [{ id: "x", platform: "知乎", status: "想法" }],
  [{ id: "a9", platform: "知乎" }, { id: "a8", platform: "知乎" }]).length,
  0, "同一个平台有两个账号时，老作品不硬塞给谁");
eq(contentsOfAccount(ACCOUNTS[0], CONTENTS, null).length, 4,
  "不传账号清单时只认 accountId");

console.log("\nmedia-calc.js：粉丝 = 快照 + 之后的涨粉");
eq(followersAt(ACCOUNTS[0], CONTENTS, SNAPS, "2026-10-01", ACCOUNTS), 1200,
  "有快照那天就是快照值");
eq(followersAt(ACCOUNTS[0], CONTENTS, SNAPS, "2026-10-03", ACCOUNTS), 1400,
  "快照 + 10-03 那条的 200");
eq(followersAt(ACCOUNTS[0], CONTENTS, SNAPS, "2026-10-05", ACCOUNTS), 1700,
  "再加 10-05 那条的 300");
eq(followersAt(ACCOUNTS[0], CONTENTS, SNAPS, "2026-09-30", ACCOUNTS), 1100,
  "快照之前：初始粉丝 1000 + 09-20 那条的 100（不重复算快照之前那条）");
eq(followersAt(ACCOUNTS[1], CONTENTS, SNAPS, "2026-10-07", ACCOUNTS), 560,
  "没有快照：初始 500 + 作品 60");
eq(followersAt(ACCOUNTS[1], CONTENTS, SNAPS, "2026-10-03", ACCOUNTS), 500,
  "没有快照、作品还没发时就是初始值");
eq(followersAt(ACCOUNTS[0], CONTENTS, SNAPS, "2026-10-07", ACCOUNTS), 1700,
  "待发布的作品不算涨粉（c4 计划 10-10 还没发）");

// 作品和快照同一天：算快照已经包含它，不要算两遍
const SAME_DAY = [
  { id: "s", accountId: "a1", date: "2026-10-01", count: 1200 },
];
const SAME_DAY_C = [
  { id: "x", accountId: "a1", status: "已发布", publishDate: "2026-10-01", fansGain: 50 },
  { id: "y", accountId: "a1", status: "已发布", publishDate: "2026-10-02", fansGain: 30 },
];
eq(followersAt(ACCOUNTS[0], SAME_DAY_C, SAME_DAY, "2026-10-01", ACCOUNTS), 1200,
  "和快照同一天的作品不重复算");
eq(followersAt(ACCOUNTS[0], SAME_DAY_C, SAME_DAY, "2026-10-02", ACCOUNTS), 1230,
  "第二天才加上去");

console.log("\nmedia-calc.js：日期与周区间");
eq(shiftDateStr("2026-10-07", 1), "2026-10-08", "加一天");
eq(shiftDateStr("2026-10-01", -1), "2026-09-30", "跨月往回一天");
eq(shiftDateStr("2026-01-01", -1), "2025-12-31", "跨年往回一天");
eqDeep(weekRangeOf("2026-10-07"),
  { start: "2026-10-05", end: "2026-10-11", prevStart: "2026-09-28", prevEnd: "2026-10-04" },
  "周三 → 本周 10-05~10-11、上周 09-28~10-04");
eq(weekRangeOf("2026-10-05").start, "2026-10-05", "周一 → 它自己");
eq(weekRangeOf("2026-10-11").start, "2026-10-05", "周日算这一周的最后一天");

console.log("\nmedia-calc.js：区间涨粉与环比文案");
eq(followersGain(ACCOUNTS[0], CONTENTS, SNAPS, "2026-10-05", "2026-10-07", ACCOUNTS), 300,
  "本周（10-05~10-07）涨了 300");
eq(followersGain(ACCOUNTS[0], CONTENTS, SNAPS, "2026-09-28", "2026-10-04", ACCOUNTS), 300,
  "上周（09-28~10-04）涨了 300");
eq(followersGain(ACCOUNTS[1], CONTENTS, SNAPS, "2026-10-05", "2026-10-07", ACCOUNTS), 0,
  "没涨就是 0");
eqDeep(growthText(326, 300), { text: "+326", tip: "比上周多 9%" }, "比上周多");
eqDeep(growthText(100, 300), { text: "+100", tip: "比上周少 67%" }, "比上周少");
eqDeep(growthText(300, 300), { text: "+300", tip: "与上周持平" }, "持平");
eqDeep(growthText(-12, 300), { text: "-12", tip: "比上周少 104%" }, "掉粉也照实说");
eqDeep(growthText(0, 0), { text: "0", tip: "与上周持平" }, "两周都没涨粉 → 持平");
eqDeep(growthText(326, 0), { text: "+326", tip: "上周没有涨粉" }, "上周是 0 时不给百分比（0 不能当分母）");
eqDeep(growthText(50, null), { text: "+50", tip: "上周没有记录" }, "null 才是「上周没有记录」");

console.log("\nmedia-calc.js：爆款");
eq(isHit(190, 100), null, "1.9 倍还不算爆款");
eq(isHit(200, 100), "small", "刚好 2 倍 → 小爆款");
eq(isHit(299, 100), "small", "2.99 倍还是小爆款");
eq(isHit(300, 100), "big", "刚好 3 倍 → 大爆款");
eq(isHit(5000, 0), null, "平均为 0 时不评爆款");
eq(avgViewsOf([{ views: 100 }, { views: 300 }]), 200, "平均播放");
eq(avgViewsOf([]), 0, "没有作品时平均是 0，不出现除零");
eq(avgViewsOf([{ views: 0 }, { views: 0 }]), 0, "全是 0 时平均也是 0");

const pool = [
  { id: "p1", status: "已发布", views: 100 },
  { id: "p2", status: "已发布", views: 100 },
  { id: "p3", status: "已发布", views: 100 },
  { id: "big", status: "已发布", views: 1000 },
];
eq(hitLevelOf({ views: 1000, status: "已发布" }, pool), "big", "明显高于平均 → 大爆款");
eq(hitLevelOf({ views: 100, status: "已发布" }, pool), null, "拖后腿的不算爆款");
eq(hitLevelOf({ views: 1000, status: "已发布" }, pool.slice(0, 2)), null,
  "作品不足 3 条时不评爆款（样本太少，标了也没意义）");
eq(hitLevelOf({ views: 1000, status: "待发布" }, pool), null, "还没发的不评爆款");

console.log("\nmedia-calc.js：账号活跃度");
eq(activityOf({ id: "a1" }, CONTENTS, TODAY, ACCOUNTS).level, "hot", "2 天前发过 → 高频更新");
eq(activityOf({ id: "a1" }, CONTENTS, TODAY, ACCOUNTS).text, "高频更新", "文案");
const slow = [{ id: "z", accountId: "a1", status: "已发布", publishDate: "2026-09-20" }];
eq(activityOf({ id: "a1" }, slow, TODAY, ACCOUNTS).level, "slow", "17 天前 → 轻微断更");
const stalled = [{ id: "z", accountId: "a1", status: "已发布", publishDate: "2026-08-01" }];
eq(activityOf({ id: "a1" }, stalled, TODAY, ACCOUNTS).level, "stalled", "两个多月 → 严重停更");
eq(activityOf({ id: "a1" }, [], TODAY, ACCOUNTS).text, "新号", "一条都没发过 → 新号");
eq(activityOf({ id: "a1" }, [], TODAY, ACCOUNTS).level, "none", "新号没有档位");

console.log("\nmedia-calc.js：单账号汇总");
const st = accountStats(ACCOUNTS[0], CONTENTS, SNAPS, TODAY, ACCOUNTS);
eq(st.followers, 1700, "当前粉丝");
eq(st.weekGain, 300, "本周涨粉");
eq(st.views, 43000, "总播放 = 5000 + 8000 + 30000（待发布那条不算）");
eq(st.likes, 1200, "总点赞");
eq(st.collects, 150, "总收藏");
eq(st.comments, 110, "总评论");
eq(st.pending, 1, "待发布 1 条");
eq(st.published, 3, "已发布 3 条");
eq(st.hits, 1, "1 条小爆款（30000 ≥ 11000 的 2 倍）");
eq(st.lastDate, "2026-10-05", "最近一次发布");
eq(st.target, 5000, "目标粉丝");
eq(st.targetPercent, 34, "1700 / 5000 → 34%");
eq(accountStats({ id: "a9", platform: "知乎" }, CONTENTS, SNAPS, TODAY, ACCOUNTS).followers, 0,
  "没有粉丝的账号给 0，不炸");

console.log("\nmedia-calc.js：趋势");
const fanSeries = followersSeries(ACCOUNTS[0], CONTENTS, SNAPS, TODAY, 30, ACCOUNTS);
eq(fanSeries.length, 30, "30 天就是 30 个点");
eq(fanSeries[29].date, TODAY, "最后一天是今天");
eq(fanSeries[29].value, 1700, "最后一天的值 = 当前粉丝");
eq(fanSeries[28].value, 1700, "没作品的 10-06 是平的");
eq(followersSeries(ACCOUNTS[0], CONTENTS, SNAPS, TODAY, 3, ACCOUNTS)
  .map((p) => p.date).join(","), "2026-10-05,2026-10-06,2026-10-07", "只画要求的几天");
const viewSeries = viewsSeries(ACCOUNTS[0], CONTENTS, TODAY, 4, ACCOUNTS);
eq(viewSeries[3].value, 43000, "累计播放到今天 = 43000");
eq(viewSeries[0].value, 13000, "10-04 时只有前两条（5000 + 8000）");

console.log("\nmedia-calc.js：整页汇总");
const ov = overviewOf({ mediaAccounts: ACCOUNTS, mediaFollowers: SNAPS, contents: CONTENTS }, TODAY);
eq(ov.accounts.length, 2, "两个账号");
eq(ov.totalFollowers, 2260, "总粉丝 = 1700 + 560");
eq(ov.totalViews, 45000, "总播放（含未绑定那条的 0）");
eq(ov.totalLikes, 1250, "总点赞");
eq(ov.weekGain, 300, "本周涨粉");
eq(ov.weekTip, "比上周少 17%", "环比文案（本周 300、上周 360）");
eq(ov.weekViews, 30000, "本周流量 = 本周发布那条的播放");
eq(ov.monthPublished, 3, "本月已发布 3 条");
eq(ov.hitCount, 1, "爆款 1 条");
eq(ov.top.length, 3, "TOP3");
eq(ov.top[0].id, "c3", "TOP1 是播放最高的那条");
eq(ov.top[0].mult, "2.1", "倍率 = 30000 / 14333，保留一位");
eqDeep(overviewOf({}, TODAY).top, [], "空数据不炸");
eq(overviewOf({}, TODAY).totalFollowers, 0, "空数据总粉丝是 0");

const all = overviewSeries({ mediaAccounts: ACCOUNTS, mediaFollowers: SNAPS, contents: CONTENTS },
  TODAY, 30);
eq(all.fans.length, 30, "整页粉丝曲线 30 个点");
eq(all.fans[29].value, 2260, "两条账号曲线加起来");
eq(all.views[29].value, 45000, "整页播放曲线今天 = 45000");
eq(all.fans[0].date, "2026-09-08", "起点是 30 天前");

const fresh = overviewOf(
  { mediaAccounts: [{ id: "n1", platform: "B站", baseFollowers: 100 }] },
  TODAY
);
eq(fresh.weekGain, 0, "全新账号本周没涨粉");
eq(fresh.lastWeekGain, null, "没有更早的快照和作品 → 上周是 null");
eq(fresh.weekTip, "上周没有记录", "不编一个环比百分比出来");
eq(fresh.top.length, 0, "没有作品就没有 TOP3");

/* ---------------- 平台清单可以自己编辑（2026-10-13 加的） ----------------
   PLATFORMS 那份是**默认**清单；真正用哪几个看 settings.mediaPlatforms。
   账号和作品里存的还是平台名（文本），所以改清单不影响已经记下的东西 ——
   这一版只改「下拉里有哪些可选」。 */

eq(PLATFORM_LIMIT, 12, "最多 12 个平台");
eq(PLATFORM_MAX_CHARS, 12, "平台名最多 12 个字");

eqDeep(normalizePlatforms(null), PLATFORMS, "没设过 → 用默认那份清单");
eqDeep(normalizePlatforms([]), PLATFORMS, "设成空数组也算没设 → 回到默认");
eqDeep(normalizePlatforms("坏掉的"), PLATFORMS, "被手改成别的形状 → 回到默认");
eqDeep(normalizePlatforms(["B站", " 小红书 ", "B站", ""]),
  ["B站", "小红书"], "去空白、去重、丢空串");
eqDeep(normalizePlatforms(["x".repeat(PLATFORM_MAX_CHARS + 5)])[0].length, PLATFORM_MAX_CHARS,
  "太长的名字截到上限");
eqDeep(normalizePlatforms(Array.from({ length: PLATFORM_LIMIT + 3 }, (_, i) => "平台" + i)).length,
  PLATFORM_LIMIT, "超过上限就只留前 12 个");

eqDeep(platformsOf({ settings: { mediaPlatforms: ["B站", "知乎"] } }), ["B站", "知乎"],
  "设过就用设的");
eqDeep(platformsOf({}), PLATFORMS, "老数据没有这个设置 → 默认清单");
eqDeep(platformsOf(null), PLATFORMS, "什么都没传也不炸");

const ADD1 = addPlatform(["B站"], "小红书");
eq(ADD1.status, "added", "加一个新的：added");
eqDeep(ADD1.list, ["B站", "小红书"], "加到尾巴上（顺序就是下拉里的顺序）");
eq(addPlatform(["B站"], "B站").status, "dup", "重名的：dup");
eq(addPlatform(["B站"], " B站 ").status, "dup", "带空白也算重名");
eq(addPlatform(["B站"], "   ").status, "bad", "空名字：bad");
eq(addPlatform(["B站"], "x".repeat(PLATFORM_MAX_CHARS + 1)).status, "bad", "太长：bad");
eq(addPlatform(Array.from({ length: PLATFORM_LIMIT }, (_, i) => "p" + i), "新的").status, "full",
  "满 12 个：full（让用户自己删一个）");
eq(addPlatform(null, "知乎").status, "dup", "传 null 时按默认清单算（知乎本来就在里面）");
eq(addPlatform(null, "播客").status, "added", "传 null 也能加默认清单里没有的那个");

const REM1 = removePlatform(["B站", "知乎"], "知乎");
eq(REM1.status, "removed", "删一个：removed");
eqDeep(REM1.list, ["B站"], "列表里少了一个");
eq(removePlatform(["B站"], "B站").status, "last", "只剩最后一个就不让删了（下拉不能是空的）");
eqDeep(removePlatform(["B站"], "B站").list, ["B站"], "不让删就原样返回");
eq(removePlatform(["B站", "知乎"], "没有这个").status, "removed", "删一个本来就没有的：当成功（幂等）");

/* ---------------- 快照：最近记过的那一条（2026-10-13 加的） ----------------
   「记粉丝」里加一行「上一条：10-10 · 1,260 粉」+ 一个「用它」——
   点一下把那个数字垫进输入框，你只改数字，省得从头敲。 */

const SNAP_LIST = [
  { id: "s1", accountId: "a1", date: "2026-10-01", count: 1200 },
  { id: "s2", accountId: "a1", date: "2026-10-05", count: 1400 },
  { id: "s3", accountId: "a2", date: "2026-10-09", count: 560 },
  { id: "s4", accountId: "a1", date: "2026-10-03", count: 1300 },
];
eqDeep(lastSnapshotOf(SNAP_LIST, "a1"), { id: "s2", date: "2026-10-05", count: 1400 },
  "取这个账号最近那一条（不按数组顺序，按日期）");
eqDeep(lastSnapshotOf(SNAP_LIST, "a2"), { id: "s3", date: "2026-10-09", count: 560 },
  "别的账号各取各的");
eq(lastSnapshotOf(SNAP_LIST, "没记过的账号"), null, "没记过：null（界面就不显示那一行）");
eq(lastSnapshotOf([], "a1"), null, "一条快照都没有：null");
eq(lastSnapshotOf(null, "a1"), null, "传 null 也不炸");
eq(lastSnapshotOf(SNAP_LIST, ""), null, "没给账号 id：null");
eq(lastSnapshotOf([{ accountId: "a1", date: "2026-10-05", count: -5 }], "a1").count, 0,
  "数字取整、负数当 0（手改坏了的也不至于垫一个负数进去）");
eq(lastSnapshotOf([{ accountId: "a1", count: 999 }], "a1"), null,
  "没有日期的快照不算（那一条本来就不知道是哪天的）");

/* ---------------- 作品导出 CSV（2026-10-13 加的） ----------------
   一行一条作品；日期那一列「发布日优先，没发布就用排期日」，账号名回账号表取。
   拼装那半截（裹引号、BOM）在 csv.js，记账那边已经用过一份了，这里只管「有哪些列」。 */

eqDeep(WORKS_CSV_HEAD,
  ["日期", "状态", "标题", "平台", "账号", "播放", "点赞", "评论", "收藏", "涨粉", "链接", "备注"],
  "表头 12 列");

const CSV_ACCS = [
  { id: "a1", name: "B站小李", platform: "B站" },
  { id: "a2", name: "小红书小号", platform: "小红书" },
];
const WORKS = [
  { id: "w1", accountId: "a1", platform: "B站", title: "第一条", status: "已发布",
    planDate: "2026-10-01", publishDate: "2026-10-02", link: "https://b23.tv/x",
    views: 12000, likes: 300, comments: 20, collects: 88, fansGain: 15, note: "脚本要点",
    createdAt: "2026-10-02 20:00" },
  { id: "w2", accountId: "a2", platform: "小红书", title: "还没发的选题", status: "待发布",
    planDate: "2026-10-05", publishDate: "", link: "",
    views: 0, likes: 0, comments: 0, collects: 0, fansGain: 0, note: "素材在桌面",
    createdAt: "2026-10-03 09:00" },
  { id: "w3", accountId: "", platform: "B站", title: "上个月的老作品", status: "已发布",
    planDate: "", publishDate: "2026-09-20", link: "",
    views: 500, likes: 10, comments: 1, collects: 2, fansGain: 3, note: "",
    createdAt: "2026-09-20 10:00" },
  { id: "w4", accountId: "a1", platform: "B站", title: "连日期都没填的想法", status: "想法",
    planDate: "", publishDate: "", link: "",
    views: 0, likes: 0, comments: 0, collects: 0, fansGain: 0, note: "",
    createdAt: "2026-10-04 08:00" },
];

const W_ROWS = contentCsvRows(WORKS, CSV_ACCS, {});
eq(W_ROWS.length, 4, "四条作品四行");
eqDeep(W_ROWS[0], ["2026-10-05", "待发布", "还没发的选题", "小红书", "小红书小号", "0", "0", "0", "0", "0", "", "素材在桌面"],
  "日期倒序：10-05 排第一；没发布的用排期日（导出来一眼看得出排在哪天）");
eqDeep(W_ROWS[1], ["2026-10-02", "已发布", "第一条", "B站", "B站小李", "12000", "300", "20", "88", "15",
  "https://b23.tv/x", "脚本要点"],
  "发布日那一列用实际发布日期；账号名回账号表取；数字不带千分位");
eq(W_ROWS[2][1], "已发布", "第三行是 09-20 那条老作品");
eq(W_ROWS[2][6], "10", "老作品的点赞也在");
eq(W_ROWS[2][4], "", "认不出账号的（accountId 是空的）账号那列留空，不硬塞平台名");
eq(W_ROWS[3][2], "连日期都没填的想法", "一条日期都没有的排在最后");
eq(W_ROWS[3][0], "", "它的日期列空着");

const W_MONTH = contentCsvRows(WORKS, CSV_ACCS, { month: "2026-10" });
eq(W_MONTH.length, 2, "只看 10 月：三条里有日期的两条在");
eq(W_MONTH.some((r) => r[2] === "上个月的老作品"), false, "9 月那条不在");
eq(W_MONTH.some((r) => r[2] === "连日期都没填的想法"), false, "没日期的在按月筛时也不算（不知道该归哪个月）");

eq(contentCsvRows(null, null, {}).length, 0, "什么都没传也不炸");
eq(contentCsvRows(WORKS, null, {}).length, 4, "不传账号表也能导（账号列留空）");

const W_CSV = mediaCsv(contentCsvRows(WORKS, CSV_ACCS, {}));
eq(W_CSV.charCodeAt(0), 0xfeff, "开头是 BOM");
eq(W_CSV.slice(1).split("\r\n")[0], WORKS_CSV_HEAD.join(","), "第一行是表头");
eq(W_CSV.slice(1).split("\r\n").length, 6, "表头 + 四行 + 末尾换行");
eq(mediaCsv([]), "\ufeff" + WORKS_CSV_HEAD.join(",") + "\r\n", "一条作品都没有时只剩表头");
const W_NOTE = mediaCsv(contentCsvRows(
  [{ id: "w9", title: '带 "引号, 逗号" 的标题', status: "想法", views: 1, likes: 0, comments: 0,
     collects: 0, fansGain: 0, note: "第一行\n第二行" }],
  null, {}
));
eq(W_NOTE.indexOf('"带 ""引号, 逗号"" 的标题"') >= 0, true, "标题里的引号逗号都照顾到了");
eq(W_NOTE.indexOf('"第一行\n第二行"') >= 0, true, "备注里换行也裹起来");
eq(csvCell("普通"), "普通", "共用的那份拼格子还在（csv.js）");

/* ---------------- 粉丝快照批量补录（2026-10-13 加的） ----------------
   前几天忘了记，现在从平台后台翻出数字来一次补上。
   一行一天「日期 粉丝数」；日期由界面替你预填（最近 7 天里还没记过的那几天），
   你只填数字、没填的行跳过；同一天已经有的覆盖它；**未来的日期不收**。 */

eqDeep(recentDays("2026-10-13", 3), ["2026-10-11", "2026-10-12", "2026-10-13"],
  "最近三天（升序、含今天）");
eqDeep(recentDays("2026-10-02", 3), ["2026-09-30", "2026-10-01", "2026-10-02"],
  "跨月往回数也对");
eqDeep(recentDays("2026-10-13", 1), ["2026-10-13"], "只要一天就是今天");
eqDeep(recentDays("不是日期", 3), [], "认不出来给空数组");

const P1 = parseSnapshotLines("2026-10-10 1200\n2026-10-11 1260\n2026-10-12", "2026-10-13");
eqDeep(P1.rows, [{ date: "2026-10-10", count: 1200 }, { date: "2026-10-11", count: 1260 }],
  "两行有数字的收下；只写了日期没写数字的那行跳过（不报错）");
eq(P1.skipped, 1, "跳过的行数报出来");
eqDeep(P1.errors, [], "没填数字不算错");

const P2 = parseSnapshotLines("2026-10-10 1200\n乱写一行\n2026-13-45 100\n2026-10-20 900\n", "2026-10-13");
eqDeep(P2.rows, [{ date: "2026-10-10", count: 1200 }], "只有那一条好行收下");
eq(P2.errors.length, 3, "三行有问题：乱写的、日期不存在的、未来日期的");
eq(P2.errors[0].line, 2, "错在哪一行也报出来（第一行是 1）");
eq(P2.errors[0].reason.indexOf("日期") >= 0, true, "乱写那行说清是日期的毛病（" + P2.errors[0].reason + "）");
eq(P2.errors[2].reason.indexOf("以后") >= 0, true, "未来日期单独说（" + P2.errors[2].reason + "）");

const P3 = parseSnapshotLines("2026-10-10 1200\n2026-10-10 1300", "2026-10-13");
eqDeep(P3.rows, [{ date: "2026-10-10", count: 1300 }], "同一天写两次：后写的算数");
eq(P3.errors.length, 0, "这不算错");
eqDeep(parseSnapshotLines("2026-10-10 -5", "2026-10-13").rows, [],
  "负数不收（说清毛病）");
eq(parseSnapshotLines("2026-10-10 -5", "2026-10-13").errors[0].reason.indexOf("整数") >= 0, true,
  "负数那行给「要填整数」的提示（" + parseSnapshotLines("2026-10-10 -5", "2026-10-13").errors[0].reason + "）");
eqDeep(parseSnapshotLines("2026-10-10 1,200", "2026-10-13").rows,
  [{ date: "2026-10-10", count: 1200 }],
  "带千分位也认（从平台后台复制的数字常带逗号）");
eqDeep(parseSnapshotLines("", "2026-10-13").rows, [], "整段是空的：什么都不收，也不算错");
eq(parseSnapshotLines(null, "2026-10-13").errors.length, 0, "传 null 也不炸");

const EXIST = [
  { id: "s1", accountId: "a1", date: "2026-10-10", count: 1000 },
  { id: "s2", accountId: "a2", date: "2026-10-10", count: 500 },
];
const APPLY = applySnapshots(EXIST, "a1", P1.rows, () => "new-id");
eq(APPLY.added, 1, "10-11 是新加的");
eq(APPLY.updated, 1, "10-10 已经有 → 覆盖那一天");
eq(APPLY.list.length, 3, "原来两条 + 新加一条");
eq(APPLY.list.find((s) => s.accountId === "a1" && s.date === "2026-10-10").count, 1200,
  "覆盖的是这个账号那天的数字");
eq(APPLY.list.find((s) => s.accountId === "a2" && s.date === "2026-10-10").count, 500,
  "别的账号同一天的快照一个字不动");
eq(APPLY.list.find((s) => s.date === "2026-10-11").accountId, "a1", "新加那条挂在这个账号上");
eq(APPLY.list.find((s) => s.date === "2026-10-11").id, "new-id", "新条目的 id 由调用方给");
eq(EXIST.length, 2, "原数组没被改（返回的是新数组）");
eqDeep(applySnapshots(null, "a1", [], () => "x"), { list: [], added: 0, updated: 0 },
  "什么都没有时干净地给 0");

/* ---------------- 素材库（2026-10-14 加的） ----------------
   自媒体要用的东西（脚本、封面、参考链接）收进一张 mediaAssets 表；
   「这条作品用了哪几份」存在作品那一侧（contents[].assetIds）——
   日常动作是「做这条作品 → 挑素材」，作品是主动方；素材页那句「用在 N 条作品上」
   由作品侧现算，不会出现第二份真相。删素材时记得摘引用（unlinkAsset）。 */

eqDeep(ASSET_KINDS, ["image", "link"], "素材就两种：图片 / 链接");

eqDeep(normalizeAsset({ id: "a1", title: " 封面 ", kind: "link", url: " https://x ",
  path: "attachments/media_asset/x.png", note: " 竖版 " }),
  { id: "a1", title: "封面", kind: "link", path: "", url: "https://x", note: "竖版", createdAt: "" },
  "链接素材：填 url、把 path 清掉（两种字段不混着留）");
eqDeep(normalizeAsset({ title: "图", kind: "image", path: " attachments/media_asset/a.png ",
  url: "https://忽略" }),
  { id: "", title: "图", kind: "image", path: "attachments/media_asset/a.png", url: "",
    note: "", createdAt: "" },
  "图片素材：填 path、把 url 清掉");
eq(normalizeAsset({ kind: "别的" }).kind, "image", "类型认不出当图片（界面里默认也是图片）");
eq(normalizeAsset(null).title, "", "什么都没传也不炸");

const ASSETS = [
  { id: "a1", title: "封面", kind: "image", path: "attachments/media_asset/1.png" },
  { id: "a2", title: "参考链接", kind: "link", url: "https://example.com" },
  { id: "a3", title: "没人用的那份" },
];
eq(assetsOf({ mediaAssets: ASSETS }).length, 3, "三条都读出来");
eq(assetsOf({}).length, 0, "老数据没这个键：空数组，不抛错");
eq(assetsOf({ mediaAssets: "坏掉的" }).length, 0, "被手改成别的形状也当空");
eq(assetsOf({ mediaAssets: [{ id: "a9", kind: "image" }] }).length, 0,
  "标题、图片、链接全空的残渣丢掉（读出来也没法显示）");

const WITH_USE = [
  { id: "c1", title: "第一条", assetIds: ["a1", "a2"] },
  { id: "c2", title: "第二条", assetIds: ["a1"] },
  { id: "c3", title: "没用素材的" },
];
eqDeep(assetUsage(ASSETS, WITH_USE), { a1: 2, a2: 1, a3: 0 },
  "a1 被两条作品用着、a2 一条、a3 没人用；没 assetIds 的作品不算");
eqDeep(assetUsage(ASSETS, []), { a1: 0, a2: 0, a3: 0 }, "一条作品都没有：都是 0");
eqDeep(assetUsage(ASSETS, [{ id: "c9", assetIds: ["a1", "a1"] }]), { a1: 1, a2: 0, a3: 0 },
  "同一条作品里写了两遍同一个 id：只算一条");
eqDeep(assetUsage(ASSETS, null), { a1: 0, a2: 0, a3: 0 }, "作品传 null 也不炸");

eqDeep(assetsOfContent({ assetIds: ["a2", "a1"] }, ASSETS).map((a) => a.id), ["a1", "a2"],
  "作品用了哪些素材：按素材库的顺序给回来（库里怎么排就怎么排）");
eqDeep(assetsOfContent({ assetIds: ["a1", "没有这个"] }, ASSETS).map((a) => a.id), ["a1"],
  "认不出的 id 直接跳过，不硬塞一个空壳");
eqDeep(assetsOfContent({}, ASSETS), [], "作品没写 assetIds：空");

const UNLINKED = unlinkAsset(WITH_USE, "a1");
eqDeep(UNLINKED[0].assetIds, ["a2"], "第一条里的 a1 摘掉了");
eqDeep(UNLINKED[1].assetIds, [], "第二条只剩它自己（空了就是空数组）");
eqDeep(UNLINKED[2].assetIds, undefined, "本来没写 assetIds 的那条一个字不动");
eqDeep(WITH_USE[0].assetIds, ["a1", "a2"], "原数组没被改（返回的是新数组）");
eqDeep(unlinkAsset(null, "a1"), [], "传 null 也不炸");

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
