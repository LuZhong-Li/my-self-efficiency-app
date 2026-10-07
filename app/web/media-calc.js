/* 自媒体的纯计算：账号、粉丝、播放、爆款、活跃度、趋势。
   为什么单独一个文件：这里全是**最容易算错**的地方（粉丝到底从哪儿开始加、
   快照和作品同一天算几遍、一周从哪天算起、多少倍才算爆款），放在这里就能用
   Node 一条条断言（tests/自媒体计算.test.mjs），不用开浏览器对着界面数。
   这个文件不 import 任何东西：不碰 DOM、不碰 store，取表函数自带一份。
   别的文件（media.js / home-view.js / search.js）不许再自己算这些数。 */

/** 平台清单。存的还是文本，所以以后想改可编辑也不用迁数据。 */
export const PLATFORMS = ["B站", "小红书", "抖音", "公众号", "知乎", "视频号", "其他"];

/** 内容流水线：想法 → 撰写中 → 剪辑中 → 待发布 → 已发布 */
export const STATUSES = ["想法", "撰写中", "剪辑中", "待发布", "已发布"];

/** 废弃 = 归档隐藏，只在折叠区里露脸，不参与统计 */
export const ARCHIVED = "废弃";

const SLUGS = {
  "B站": "bili",
  "小红书": "xhs",
  "抖音": "douyin",
  "公众号": "wechat",
  "知乎": "zhihu",
  "视频号": "shipin",
  "其他": "other",
};

export function statusesOf() {
  return STATUSES.slice();
}

export function isPublished(c) {
  return !!c && c.status === "已发布";
}

export function isArchived(c) {
  return !!c && c.status === ARCHIVED;
}

/** "B站" → "bili"。CSS 类名后缀用它（mk-plat-bili / cx-plat-bili）。 */
export function platformSlug(platform) {
  return SLUGS[String(platform || "").trim()] || "other";
}

/* ---------------- 数字显示 ---------------- */

/** 大数字缩写：326 / 6.2k / 1.26w / 48.6w。
    一律**截断**不四舍五入——涨粉和播放都是「有多少说多少」，宁少不多。 */
export function fmtCount(value) {
  const n = Math.round(Number(value) || 0);
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs < 1000) return sign + String(abs);
  if (abs < 10000) return sign + trimZero(Math.floor(abs / 100) / 10) + "k";
  if (abs < 100000) return sign + trimZero(Math.floor(abs / 100) / 100) + "w";
  return sign + trimZero(Math.floor(abs / 1000) / 10) + "w";
}

function trimZero(x) {
  return String(x).replace(/\.0$/, "");
}

/* ---------------- 日期 ---------------- */

/** 本地日期的加减，不走 UTC（toISOString 那种晚上会差一天）。
    store.js 里有同名函数，但这个文件要能在 Node 里单独跑，不能 import 它。 */
export function shiftDateStr(date, days) {
  const [y, m, d] = String(date).split("-").map(Number);
  const dt = new Date(y, m - 1, d, 12); // 中午，绕开夏令时
  dt.setDate(dt.getDate() + days);
  const p = (n) => String(n).padStart(2, "0");
  return dt.getFullYear() + "-" + p(dt.getMonth() + 1) + "-" + p(dt.getDate());
}

function daysBetween(from, to) {
  const a = String(from).split("-").map(Number);
  const b = String(to).split("-").map(Number);
  const t1 = new Date(a[0], a[1] - 1, a[2], 12).getTime();
  const t2 = new Date(b[0], b[1] - 1, b[2], 12).getTime();
  return Math.round((t2 - t1) / 86400000);
}

/** 那一周的范围：周一算一周的开头。prev 是上一周，用来算环比。 */
export function weekRangeOf(today) {
  const [y, m, d] = String(today).split("-").map(Number);
  const dt = new Date(y, m - 1, d, 12);
  const offset = (dt.getDay() + 6) % 7; // 周一 = 0
  const start = shiftDateStr(today, -offset);
  const prevStart = shiftDateStr(start, -7);
  return { start, end: shiftDateStr(start, 6), prevStart, prevEnd: shiftDateStr(start, -1) };
}

/* ---------------- 取表 ---------------- */

function listOf(data, key) {
  const list = data && data[key];
  return Array.isArray(list) ? list : [];
}

/* ---------------- 作品归属 ---------------- */

/**
 * 落到这个账号名下的作品。
 *
 * 优先认 accountId；老数据没有 accountId 的，只有在「这个平台上只有一个账号」
 * 时才归给它——同一个平台开两个号的情况下硬塞，等于把数据算两遍。
 * accounts 不传就只认 accountId（纯函数测试和特殊场合用）。
 */
export function contentsOfAccount(account, contents, accounts = null) {
  const all = contents || [];
  if (!account) return all.slice();
  const id = account.id;
  const platform = String(account.platform || "").trim();
  const samePlatform = accounts
    ? accounts.filter((a) => String(a.platform || "").trim() === platform)
    : [];
  return all.filter((c) => {
    if (!c) return false;
    if (c.accountId) return c.accountId === id;
    if (!accounts || !platform) return false;
    // 得先确认这条老作品就是这个平台的，再看这个平台上是不是只有这一个账号
    return (
      String(c.platform || "").trim() === platform &&
      samePlatform.length === 1 &&
      samePlatform[0].id === id
    );
  });
}

/* ---------------- 粉丝：快照 + 作品涨粉 ---------------- */

/**
 * 截至 date（含）这天这个账号有多少粉。
 *
 * 规则：= 最近一条快照 + 该快照**之后**（严格晚于）发布作品的涨粉；
 *       一条快照都没有 = 初始粉丝 + 该账号所有已发布作品的涨粉。
 *
 * 为什么用「快照 + 之后的增量」而不是在账号上直接存一个数字：
 * 用户手动校正一次，不该把作品统计出来的涨粉冲掉。同一天的作品算快照
 * 已经包含它，避免同一天算两遍。
 */
export function followersAt(account, contents, snapshots, date, accounts = null) {
  if (!account) return 0;
  const mine = contentsOfAccount(account, contents, accounts);
  const snaps = (snapshots || [])
    .filter((s) => s && s.accountId === account.id && s.date && s.date <= date)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const last = snaps[snaps.length - 1];
  const base = last ? Number(last.count) || 0 : Number(account.baseFollowers) || 0;
  const since = last ? last.date : "";
  const gain = mine
    .filter((c) => c.publishDate && c.publishDate <= date && (!since || c.publishDate > since))
    .reduce((sum, c) => sum + (Number(c.fansGain) || 0), 0);
  return base + gain;
}

/** 区间涨粉：从 from 那天算到 to 那天（含两头）。 */
export function followersGain(account, contents, snapshots, from, to, accounts = null) {
  return (
    followersAt(account, contents, snapshots, to, accounts) -
    followersAt(account, contents, snapshots, shiftDateStr(from, -1), accounts)
  );
}

/** 近 days 天的粉丝曲线，逐日算（数据量小，够用且不会算错边界）。 */
export function followersSeries(account, contents, snapshots, today, days, accounts = null) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = shiftDateStr(today, -i);
    out.push({ date, value: followersAt(account, contents, snapshots, date, accounts) });
  }
  return out;
}

/** 近 days 天的**累计播放**曲线（截至那天，已发布作品的播放之和）。 */
export function viewsSeries(account, contents, today, days, accounts = null) {
  const mine = contentsOfAccount(account, contents, accounts);
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = shiftDateStr(today, -i);
    const value = mine
      .filter((c) => isPublished(c) && c.publishDate && c.publishDate <= date)
      .reduce((sum, c) => sum + (Number(c.views) || 0), 0);
    out.push({ date, value });
  }
  return out;
}

/** 涨粉文案 + 环比提示。上周没有记录时不编一个百分比出来。 */
export function growthText(weekGain, lastWeekGain) {
  const now = Number(weekGain) || 0;
  const last = lastWeekGain === null || lastWeekGain === undefined ? null : Number(lastWeekGain);
  const text = (now > 0 ? "+" : "") + fmtCount(now);
  if (!last) return { text, tip: "上周没有记录" };
  const diff = now - last;
  if (!diff) return { text, tip: "与上周持平" };
  const percent = Math.round((diff / Math.abs(last)) * 100);
  return { text, tip: percent > 0 ? `比上周多 ${percent}%` : `比上周少 ${Math.abs(percent)}%` };
}

/* ---------------- 爆款 ---------------- */

export function avgViewsOf(items) {
  const list = (items || []).filter(Boolean);
  if (!list.length) return 0;
  return list.reduce((sum, c) => sum + (Number(c.views) || 0), 0) / list.length;
}

/** ≥2 倍是小爆款、≥3 倍是大爆款，其余 null。 */
export function isHit(views, avgViews) {
  const n = Number(views) || 0;
  const avg = Number(avgViews) || 0;
  if (!avg || !n) return null;
  if (n >= avg * 3) return "big";
  if (n >= avg * 2) return "small";
  return null;
}

/** 拿「同账号已发布、且填了播放」的这批当基准，判断某一条算不算爆款。
    样本不足 3 条不评——两条数据里挑一条「爆款」没有说服力。 */
export function hitLevelOf(item, items) {
  if (!item || !isPublished(item) || !(Number(item.views) > 0)) return null;
  const pool = (items || []).filter((c) => isPublished(c) && Number(c.views) > 0);
  if (pool.length < 3) return null;
  return isHit(item.views, avgViewsOf(pool));
}

/** 某一组作品的爆款条数（同一批数据里挑出来的）。 */
function hitsOfGroup(items) {
  const pool = (items || []).filter((c) => isPublished(c) && Number(c.views) > 0);
  if (pool.length < 3) return 0;
  const avg = avgViewsOf(pool);
  return pool.filter((c) => isHit(c.views, avg)).length;
}

/** 按账号分组（没绑账号的算一组），用来统一算爆款。 */
function groupsOf(contents) {
  const map = new Map();
  for (const c of contents || []) {
    const key = (c && c.accountId) || "";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(c);
  }
  return map;
}

/* ---------------- 账号活跃度 ---------------- */

export function activityOf(account, contents, today, accounts = null) {
  const mine = contentsOfAccount(account, contents, accounts)
    .filter((c) => isPublished(c) && c.publishDate)
    .sort((a, b) => (a.publishDate < b.publishDate ? 1 : -1));
  if (!mine.length) return { level: "none", text: "新号", days: null, lastDate: "" };
  const lastDate = mine[0].publishDate;
  const days = daysBetween(lastDate, today);
  if (days <= 7) return { level: "hot", text: "高频更新", days, lastDate };
  if (days <= 14) return { level: "ok", text: "正常更新", days, lastDate };
  if (days <= 30) return { level: "slow", text: "轻微断更", days, lastDate };
  return { level: "stalled", text: "严重断更", days, lastDate };
}

/* ---------------- 单账号汇总 ---------------- */

function sumOf(items, field) {
  return (items || []).reduce((sum, c) => sum + (Number(c[field]) || 0), 0);
}

export function accountStats(account, contents, snapshots, today, accounts = null) {
  const mine = contentsOfAccount(account, contents, accounts);
  const live = mine.filter((c) => !isArchived(c));
  const published = mine.filter(isPublished);
  const followers = followersAt(account, contents, snapshots, today, accounts);
  const week = weekRangeOf(today);
  const target = Number(account.targetFollowers) || 0;
  return {
    account,
    followers,
    weekGain: followersGain(account, contents, snapshots, week.start, today, accounts),
    views: sumOf(live, "views"),
    likes: sumOf(live, "likes"),
    collects: sumOf(live, "collects"),
    comments: sumOf(live, "comments"),
    pending: mine.filter((c) => c.status === "待发布").length,
    working: mine.filter((c) => ["想法", "撰写中", "剪辑中"].includes(c.status)).length,
    published: published.length,
    hits: hitsOfGroup(mine),
    lastDate:
      published
        .filter((c) => c.publishDate)
        .map((c) => c.publishDate)
        .sort((a, b) => (a < b ? 1 : -1))[0] || "",
    activity: activityOf(account, contents, today, accounts),
    target,
    targetPercent: target ? Math.round((followers / target) * 100) : 0,
  };
}

/* ---------------- 整页汇总 ---------------- */

/** 爆款倍率：1.5 这种一位小数。 */
function multOf(views, avg) {
  if (!avg) return "—";
  return (Math.round(((Number(views) || 0) / avg) * 10) / 10).toFixed(1);
}

/**
 * 整页的数据概览：几个汇总数 + TOP3 爆款。
 *
 * 粉丝只算**账号**（账号才是粉丝的载体）；播放、点赞这些会把没绑账号的作品
 * 也算进来——没建账号但已经录了作品的人，也该看得到自己的播放。
 */
export function overviewOf(data, today) {
  const accounts = listOf(data, "mediaAccounts");
  const contents = listOf(data, "contents").filter((c) => c && !isArchived(c));
  const snapshots = listOf(data, "mediaFollowers");
  const week = weekRangeOf(today);

  const stats = accounts.map((a) => accountStats(a, contents, snapshots, today, accounts));
  const totalFollowers = stats.reduce((sum, s) => sum + s.followers, 0);
  const weekGain = stats.reduce((sum, s) => sum + s.weekGain, 0);

  // 上周有没有记录：有一条早于本周的快照或作品才算「有上周」。都没有就不编环比。
  const hasHistory =
    snapshots.some((s) => s && s.date && s.date < week.start) ||
    contents.some((c) => c.publishDate && c.publishDate < week.start);
  const lastWeekGain = hasHistory
    ? accounts.reduce(
        (sum, a) =>
          sum +
          (followersAt(a, contents, snapshots, week.prevEnd, accounts) -
            followersAt(a, contents, snapshots, shiftDateStr(week.prevStart, -1), accounts)),
        0
      )
    : null;

  const published = contents.filter(isPublished);
  const hitCount = [...groupsOf(contents).values()].reduce((sum, g) => sum + hitsOfGroup(g), 0);

  // 每一条的倍率要拿它所在账号那组当基准，所以先分组再算
  const groups = groupsOf(contents);
  const top = published
    .filter((c) => Number(c.views) > 0)
    .sort((a, b) => (Number(b.views) || 0) - (Number(a.views) || 0))
    .slice(0, 3)
    .map((c) => {
      const pool = (groups.get(c.accountId || "") || []).filter(
        (x) => isPublished(x) && Number(x.views) > 0
      );
      const avg = avgViewsOf(pool);
      return {
        id: c.id,
        title: c.title || "",
        platform: c.platform || "",
        publishDate: c.publishDate || "",
        views: Number(c.views) || 0,
        likes: Number(c.likes) || 0,
        level: isHit(c.views, avg),
        mult: multOf(c.views, avg),
      };
    });

  const month = String(today).slice(0, 7);
  return {
    accounts,
    contents,
    totalFollowers,
    totalViews: sumOf(contents, "views"),
    totalLikes: sumOf(contents, "likes"),
    totalCollects: sumOf(contents, "collects"),
    weekGain,
    lastWeekGain,
    weekTip: growthText(weekGain, lastWeekGain).tip,
    weekViews: published
      .filter((c) => c.publishDate >= week.start && c.publishDate <= week.end)
      .reduce((sum, c) => sum + (Number(c.views) || 0), 0),
    monthPublished: published.filter(
      (c) => String(c.publishDate || "").slice(0, 7) === month
    ).length,
    hitCount,
    top,
  };
}

/** 整页趋势：所有账号的粉丝合计 + 所有作品的累计播放。 */
export function overviewSeries(data, today, days) {
  const accounts = listOf(data, "mediaAccounts");
  const contents = listOf(data, "contents");
  const snapshots = listOf(data, "mediaFollowers");
  const fans = [];
  const views = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = shiftDateStr(today, -i);
    fans.push({
      date,
      value: accounts.reduce(
        (sum, a) => sum + followersAt(a, contents, snapshots, date, accounts),
        0
      ),
    });
    views.push({
      date,
      value: contents
        .filter((c) => isPublished(c) && c.publishDate && c.publishDate <= date)
        .reduce((sum, c) => sum + (Number(c.views) || 0), 0),
    });
  }
  return { fans, views };
}
