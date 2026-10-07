/* 自媒体模块的纯逻辑测试：只测不碰 DOM 的 media-calc.js。
 * 跑法：node tests\自媒体计算.test.mjs   （本机 Node v24，不需要 package.json）
 * 说明：这个测试不进「自检.cmd」——自检是给用户一键跑的，保持纯 Python。 */

import {
  PLATFORMS, STATUSES, ARCHIVED, statusesOf, isPublished, isArchived, platformSlug,
  fmtCount, contentsOfAccount, followersAt, followersSeries, viewsSeries,
  weekRangeOf, shiftDateStr, followersGain, growthText,
  isHit, avgViewsOf, hitLevelOf, activityOf, accountStats, overviewOf, overviewSeries,
} from "../app/web/media-calc.js";

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
eqDeep(growthText(0, 0), { text: "0", tip: "上周没有记录" }, "上周压根没记录时不编百分比");
eqDeep(growthText(50, null), { text: "+50", tip: "上周没有记录" }, "null 也算没有记录");

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

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
