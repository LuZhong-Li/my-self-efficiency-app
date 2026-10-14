/* 自媒体的纯计算：账号、粉丝、播放、爆款、活跃度、趋势。
   为什么单独一个文件：这里全是**最容易算错**的地方（粉丝到底从哪儿开始加、
   快照和作品同一天算几遍、一周从哪天算起、多少倍才算爆款），放在这里就能用
   Node 一条条断言（tests/自媒体计算.test.mjs），不用开浏览器对着界面数。
   这个文件只 import 了 csv.js（导出用，也是纯函数）：不碰 DOM、不碰 store，
   取表函数自带一份。别的文件（media.js / home-view.js / search.js）不许再自己算这些数。 */

import { csvText } from "./csv.js";

/** 平台清单（**默认的那一份**）。账号和作品里存的是平台名（文本），
 *  所以「用户自己改清单」不用迁数据 —— 真正用哪几个看 settings.mediaPlatforms，
 *  走下面的 platformsOf()。 */
export const PLATFORMS = ["B站", "小红书", "抖音", "公众号", "知乎", "视频号", "其他"];

/** 平台清单最多几个、名字最多几个字 */
export const PLATFORM_LIMIT = 12;
export const PLATFORM_MAX_CHARS = 12;

/**
 * 把用户设的清单洗干净：去空白、去重（忽略大小写）、每个截到上限、最多留 PLATFORM_LIMIT 个。
 * 没设过 / 设成别的形状 / 洗完全是空的 → 一律回到默认那份（下拉不能是空的）。
 */
export function normalizePlatforms(value) {
  const list = Array.isArray(value) ? value : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (typeof item !== "string") continue;
    const name = item.trim().slice(0, PLATFORM_MAX_CHARS);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= PLATFORM_LIMIT) break;
  }
  return out.length ? out : PLATFORMS.slice();
}

/** 现在实际用哪几个平台：settings.mediaPlatforms 设过就用它，没设就默认那份 */
export function platformsOf(data) {
  const s = (data && data.settings) || {};
  return normalizePlatforms(s.mediaPlatforms);
}

/**
 * 往清单里加一个平台。重名（忽略大小写与首尾空白）不加、满了不加、名字空或太长不加 ——
 * 返回 { list, status }：status 是 "added" / "dup" / "full" / "bad"，界面照它说话。
 */
export function addPlatform(list, name) {
  const rows = normalizePlatforms(list);
  const picked = String(name == null ? "" : name).trim();
  if (!picked || picked.length > PLATFORM_MAX_CHARS) return { list: rows, status: "bad" };
  if (rows.some((p) => p.toLowerCase() === picked.toLowerCase())) return { list: rows, status: "dup" };
  if (rows.length >= PLATFORM_LIMIT) return { list: rows, status: "full" };
  return { list: rows.concat([picked]), status: "added" };
}

/**
 * 从清单里删一个。**最后一个不让删**（下拉不能是空的），返回 status "last"；
 * 删一个本来就没有的算成功（幂等，点两下不会出岔子）。
 */
export function removePlatform(list, name) {
  const rows = normalizePlatforms(list);
  const picked = String(name == null ? "" : name).trim();
  if (rows.length <= 1) return { list: rows, status: "last" };
  return { list: rows.filter((p) => p !== picked), status: "removed" };
}

/**
 * 某个账号**最近记过的那一条**快照（「记粉丝」里那行「上一条 … 用它」用的）。
 * 按日期取最新的一条，不看数组顺序；没记过 / 没给账号 / 那一条没有日期 → null。
 * 数字取整、负数当 0：手改坏了的也不至于垫一个负数进输入框。
 */
export function lastSnapshotOf(snapshots, accountId) {
  const id = String(accountId == null ? "" : accountId).trim();
  if (!id) return null;
  let best = null;
  for (const s of snapshots || []) {
    if (!s || typeof s !== "object") continue;
    if (s.accountId !== id) continue;
    const date = String(s.date || "").trim();
    if (!date) continue;
    if (!best || date > best.date) best = { id: String(s.id || ""), date, count: Math.max(0, Math.round(Number(s.count) || 0)) };
  }
  return best;
}

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
  const text = (now > 0 ? "+" : "") + fmtCount(now);
  // 只有「真的没有上周」才是 null；上周算出来是 0 是另一回事，不能当成没数据
  if (lastWeekGain === null || lastWeekGain === undefined) {
    return { text, tip: "上周没有记录" };
  }
  const last = Number(lastWeekGain) || 0;
  const diff = now - last;
  if (!diff) return { text, tip: "与上周持平" };
  if (!last) return { text, tip: "上周没有涨粉" }; // 0 不能当分母
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

/* ---------------- 作品导出 CSV（2026-10-13 加的） ----------------
   一行一条作品；日期那一列「发布日优先，没发布就用排期日」。
   拼装（裹引号、BOM、行尾）在 csv.js —— 和记账共用一份，两边不会走岔。 */

/** 表头 12 列 */
export const WORKS_CSV_HEAD = [
  "日期", "状态", "标题", "平台", "账号", "播放", "点赞", "评论", "收藏", "涨粉", "链接", "备注",
];

/** 这一条作品算哪一天：发布了看发布日，还没发布看排期日；都没有就是空
 *  （按月筛的时候不算它 —— 不知道该归哪个月，硬塞进当月反而误导人） */
export function workDateOf(c) {
  const row = c && typeof c === "object" ? c : {};
  return String(row.publishDate || row.planDate || "").trim();
}

/**
 * 作品摊成表格（还没拼成文本，方便单测）：
 * 一行一条，**按日期倒序**（新的在前），一条日期都没有的排在最后。
 * 账号名回账号表取；没有 accountId（老数据 / 没绑账号）就留空，不硬塞平台名。
 *
 * @param {object[]} contents 作品
 * @param {object[]} accounts 账号表（不传就账号列留空）
 * @param {{month?: string}} options month 传 "2026-10" 就只导这个月
 */
export function contentCsvRows(contents, accounts, options = {}) {
  const list = accounts || [];
  const month = String(options.month || "").trim();
  const num = (v) => String(Math.max(0, Math.round(Number(v) || 0)));
  const rows = [];
  for (const c of contents || []) {
    if (!c || typeof c !== "object") continue;
    const date = workDateOf(c);
    if (month && !date.startsWith(month)) continue;
    const acc = list.find((a) => a && a.id === c.accountId) || null;
    rows.push({
      date,
      at: String(c.createdAt || ""),
      row: [
        date,
        String(c.status || ""),
        String(c.title || ""),
        String(c.platform || ""),
        acc ? String(acc.name || "") : "",
        num(c.views),
        num(c.likes),
        num(c.comments),
        num(c.collects),
        num(c.fansGain),
        String(c.link || ""),
        String(c.note || ""),
      ],
    });
  }
  rows.sort((a, b) => {
    if (a.date !== b.date) {
      if (!a.date) return 1;      // 没日期的排最后
      if (!b.date) return -1;
      return a.date < b.date ? 1 : -1;   // 日期倒序：新的在前
    }
    return a.at < b.at ? 1 : a.at > b.at ? -1 : 0;   // 同一天按记录时间倒序
  });
  return rows.map((r) => r.row);
}

/** 表格 → CSV 文本（BOM 与行尾都在 csv.js 那份里，和记账一个口径） */
export function mediaCsv(rows) {
  return csvText(WORKS_CSV_HEAD, rows);
}

/* ---------------- 粉丝快照批量补录（2026-10-13 加的） ----------------
   前几天忘了记，现在从平台后台翻出数字来一次补上。
   一行一天「日期 粉丝数」；日期由界面替你预填（最近几天里还没记过的那几个），
   你只填数字、没填的行跳过；同一天已经有的覆盖它；**未来的日期不收**。 */

/** 最近 count 天（升序、含今天）。"2026-10-13" + 3 → 10-11 / 10-12 / 10-13 */
export function recentDays(today, count = 7) {
  const day = String(today == null ? "" : today).trim();
  const n = Math.max(1, Math.floor(Number(count) || 1));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
  const out = [];
  for (let i = n - 1; i >= 0; i -= 1) out.push(shiftDateStr(day, -i));
  return out;
}

/**
 * 把那段多行文本解析成「要记的快照」。
 * 每行 `日期 粉丝数`（空格 / 逗号 / Tab 分开都行）：
 *   · 只写了日期、没写数字 → **跳过**（不算错：预填的日期本来就等着你挑着填）
 *   · 日期不认 / 日期不存在 / 是未来的日子 / 数字不是非负整数 → 记一条错误（带行号）
 *   · 同一天写了两遍 → 后写的算数
 * 返回 { rows: [{date, count}], skipped, errors: [{line, text, reason}] }。
 */
export function parseSnapshotLines(text, today) {
  const day = String(today == null ? "" : today).trim();
  const out = { rows: [], skipped: 0, errors: [] };
  const byDate = new Map();
  const lines = String(text == null ? "" : text).split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const parts = line.split(/[\s,，\t]+/).filter(Boolean);
    const date = parts[0] || "";
    const numberText = parts.slice(1).join("");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isRealDate(date)) {
      out.errors.push({ line: i + 1, text: line, reason: "日期要写成 2026-10-10 这样" });
      return;
    }
    if (!numberText) {
      out.skipped += 1;
      return;
    }
    if (!/^\d+$/.test(numberText)) {
      out.errors.push({ line: i + 1, text: line, reason: "粉丝数要填一个整数" });
      return;
    }
    if (date > day) {
      out.errors.push({ line: i + 1, text: line, reason: "这是以后的日期，快照只能补到今天" });
      return;
    }
    const count = Number(numberText);
    byDate.set(date, { date, count });   // 同一天写两遍：后写的算数
  });
  out.rows = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

/** "2026-13-45" 这种格式对、日子不存在的也要拦下来 */
function isRealDate(date) {
  const [y, m, d] = date.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/**
 * 把解析出来的几天合并进快照表：同一天已有就覆盖那一天，没有就新加一条。
 * 只动这个账号——别的账号哪怕同一天也一个字不动。返回 { list, added, updated }，
 * **不改传进来的数组**（返回的是新数组）；新条目的 id 由调用方给（makeId）。
 */
export function applySnapshots(snapshots, accountId, rows, makeId) {
  const id = String(accountId == null ? "" : accountId).trim();
  const list = (snapshots || []).slice();
  let added = 0;
  let updated = 0;
  for (const row of rows || []) {
    if (!row || !row.date) continue;
    const at = list.findIndex((s) => s && s.accountId === id && s.date === row.date);
    if (at >= 0) {
      list[at] = { ...list[at], count: row.count };
      updated += 1;
    } else {
      list.push({ id: typeof makeId === "function" ? makeId() : "", accountId: id, date: row.date, count: row.count });
      added += 1;
    }
  }
  return { list, added, updated };
}

/* ---------------- 素材库（2026-10-14 加的） ----------------
   自媒体要用的东西（脚本、封面、参考链接）收进一张 mediaAssets 表；
   「这条作品用了哪几份」存在作品那一侧（contents[].assetIds）——
   日常动作是「做这条作品 → 挑素材」，作品是主动方；素材页那句「用在 N 条作品上」
   由作品侧现算，不会出现第二份真相。删素材时记得摘引用（unlinkAsset）。 */

/* 2026-10-14 升级成全站共用的素材库之后，这一套搬去了 asset-calc.js
   （顶层 assets 表 + 三种类型 + 跨表引用计数 / 摘引用）。这里只转出去，
   让 media.js 这类老调用点还能照旧 import。
   注意：assetUsage 的入参从「(素材数组, 作品数组)」变成了「整份 data」、
   返回也从 { id: 条数 } 变成 { id: { total, byTable } }；
   unlinkAsset 从「返回新数组」变成「原地摘掉、返回摘了几处」——
   调用点（media.js）已经跟着改了。 */

import { assetsOf, assetUsage, assetsOfRow, unlinkAsset } from "./asset-calc.js";

export { assetsOf, assetUsage, assetsOfRow, unlinkAsset };
export { assetsOfRow as assetsOfContent };   // 老名字（作品那条链路上在用）也留着
