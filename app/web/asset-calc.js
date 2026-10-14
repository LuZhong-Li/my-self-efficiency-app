/* 素材库（全站版）的纯逻辑：一条素材长什么样、读出来、被几处引用、删素材时摘引用。
 *
 * 素材原来只有自媒体在用（mediaAssets 表，只数「用在几条作品上」）。2026-10-14 升级成
 * 全站共用：搬到顶层 data.assets，加了「文本片段」这一种类型，引用计数与摘引用都跨表走。
 * 这几个函数本来在 media-calc.js 里，一并搬过来（那边只留一行转出，页面能不改就不改）。
 *
 * 老数据兼容：老的 mediaAssets 表照样认（搬家还没落盘那一刻两个都在），
 * 同一个 id 以顶层那份为准。
 */

export const ASSET_KINDS = ["image", "link", "text"];

/** 能挂素材的表（表名 + 页面上的叫法）；"finance.transactions" 这种带点的照 readTable 那套取 */
export const ASSET_TABLES = [
  ["contents", "作品"],
  ["tasks", "待办"],
  ["issues", "问题"],
  ["projects", "项目"],
  ["studies", "学习记录"],
  ["subjects", "学习对象"],
  ["workoutLogs", "训练打卡"],
  ["gameRecords", "游玩记录"],
  ["notes", "笔记"],
  ["finance.transactions", "账目"],
];

function text(value) {
  return String(value == null ? "" : value).trim();
}

/** 照着 "finance.transactions" 这种路径取表；取不到就给空数组（绝不新建键） */
function readTable(data, key) {
  if (!data) return [];
  const parts = String(key).split(".");
  let holder = data;
  for (const part of parts.slice(0, -1)) {
    holder = holder[part];
    if (!holder || typeof holder !== "object") return [];
  }
  const rows = holder[parts[parts.length - 1]];
  return Array.isArray(rows) ? rows : [];
}

/**
 * 这条素材是哪种类型。认不出的类型（老数据、手改过）看它身上有什么：
 * 有图路径当图片、有正文当文本片段、其余当链接。
 */
function kindOf(row) {
  const raw = text(row && row.kind);
  if (ASSET_KINDS.includes(raw)) return raw;
  if (text(row && row.path)) return "image";
  if (text(row && row.text)) return "text";
  return "link";
}

/** 把一条素材补齐成完整形状 */
export function normalizeAsset(row) {
  const r = row && typeof row === "object" ? row : {};
  return {
    id: text(r.id),
    title: text(r.title),
    kind: kindOf(r),
    path: text(r.path),
    url: text(r.url),
    text: text(r.text),
    note: text(r.note),
    tags: Array.isArray(r.tags) ? r.tags.map((t) => text(t)).filter(Boolean) : [],
    createdAt: text(r.createdAt),
  };
}

/**
 * 全部素材：顶层 assets 为准，老的 mediaAssets 也认（同 id 只留顶层那份）。
 * 三样全空的残渣丢掉 —— 那是手改数据或者迁移留下的空壳，画在界面上只会添乱。
 */
export function assetsOf(data) {
  const out = [];
  const seen = new Set();
  for (const row of [...readTable(data, "assets"), ...readTable(data, "mediaAssets")]) {
    if (!row || typeof row !== "object") continue;
    const one = normalizeAsset(row);
    if (!one.title && !one.path && !one.url && !one.text) continue;
    if (seen.has(one.id)) continue;
    seen.add(one.id);
    out.push(one);
  }
  return out;
}

/** 一条记录引用了哪几个 id（老记录没这一格就当空） */
function idsOf(row) {
  const raw = row && Array.isArray(row.assetIds) ? row.assetIds : [];
  return raw.map((x) => text(x)).filter(Boolean);
}

/**
 * 每条素材被全站几处引用：{ [assetId]: { total, byTable } }。
 * 同一处写两遍只算一次；认不出的 id 不算（它没对应任何素材）。
 * byTable 是「哪张表各几条」，页面上那句「被 N 处引用」的悬停提示要用。
 */
export function assetUsage(data) {
  const known = new Set(assetsOf(data).map((a) => a.id));
  const counts = new Map();   // assetId → Map<表名, 条数>
  for (const [key] of ASSET_TABLES) {
    for (const row of readTable(data, key)) {
      for (const id of new Set(idsOf(row))) {
        if (!known.has(id)) continue;
        const mine = counts.get(id) || new Map();
        mine.set(key, (mine.get(key) || 0) + 1);
        counts.set(id, mine);
      }
    }
  }
  const out = {};
  for (const asset of assetsOf(data)) {
    const mine = counts.get(asset.id) || new Map();
    const byTable = {};
    let total = 0;
    for (const [key, n] of mine) {
      byTable[key] = n;
      total += n;
    }
    out[asset.id] = { total, byTable };
  }
  return out;
}

/** 一条记录引用的那几份素材（查不到的跳过，不编空壳；顺序照素材库那份） */
export function assetsOfRow(row, assets) {
  const ids = new Set(idsOf(row));
  if (!ids.size) return [];
  return (assets || []).filter((a) => a && ids.has(text(a.id))).map((a) => normalizeAsset(a));
}

/**
 * 从所有表里摘掉这条素材的引用，返回摘掉了几处。
 * 删素材时用：素材没了，各处指着它的 id 就是脏数据，得一并清掉。
 * （反过来不成立：删一条记录不动素材 —— 素材是共用的，别人可能还在用。）
 */
export function unlinkAsset(data, assetId) {
  const id = text(assetId);
  if (!id) return 0;
  let removed = 0;
  for (const [key] of ASSET_TABLES) {
    for (const row of readTable(data, key)) {
      if (!row || !Array.isArray(row.assetIds)) continue;
      if (!idsOf(row).includes(id)) continue;
      row.assetIds = row.assetIds.filter((x) => text(x) !== id);
      removed += 1;
    }
  }
  return removed;
}
