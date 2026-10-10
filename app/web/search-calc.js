/* 全局搜索的纯逻辑：把各模块的数据摊平成一张统一的搜索池，再按关键词筛。
 *
 * 为什么单开一份：
 *   · 搜索的表和字段以前是手写的，只覆盖了一部分 —— 于是「bug / 记账 / 健身 /
 *     自媒体」里的记录搜不到：要么整张表没进池子，要么只查了标题、漏了分类和备注。
 *   · 以前凑够 12 条就直接 return —— 排在后面的模块永远轮不到（搜「1」的时候，
 *     记账和债务一条都出不来）。现在先把所有模块扫完，再统一排序、截断。
 *
 * 这里不碰 DOM，也不改传进来的数据，所以能单测（tests/搜索.test.mjs）；
 * 输入、下拉面板和跳转在 search.js。
 */

import { MODULES } from "./modules.js";

/** 把文本统一成「好比对」的样子：小写、换行和连续空格压成单个空格、掐掉首尾空白 */
export function normalizeText(value) {
  if (value === undefined || value === null) return "";
  return String(value)
    .toLowerCase()
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 分（整数）转成人看的元文本，搜索时按「2200」或「2200.50」都能命中 */
function yuanText(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n)) return "";
  const y = n / 100;
  return Number.isInteger(y) ? String(y) : y.toFixed(2);
}

/** 数值 + 单位拼成一句，比如 70.5 → 「70.5 kg」 */
function numText(value, suffix) {
  if (value === undefined || value === null || value === "") return "";
  return `${value}${suffix}`;
}

/** 九个模块的 id 清单（跟侧边导航、首页卡片同一份，见 modules.js） */
const MODULE_IDS = MODULES.map((m) => m.id);

/**
 * 模块目标按模块 id 分桶存在 data.moduleGoals 里（fitness / study / diet 各一个
 * 数组），摊平成「一行一个目标」好进搜索池。整个写成数组、或一个模块直接摆一个
 * 对象也认（和 goal-calc.js 的读法一致）。
 */
function goalsOf(data) {
  const box = data && data.moduleGoals;
  if (!box || typeof box !== "object") return [];
  const buckets = Array.isArray(box) ? [box] : Object.values(box);
  const out = [];
  for (const bucket of buckets) {
    for (const row of Array.isArray(bucket) ? bucket : [bucket]) {
      if (row && typeof row === "object") out.push(row);
    }
  }
  return out;
}

/** 目标点回它自己那个模块；moduleId 认不出来（老数据 / 手改过的）就回首页 */
function goalModule(row) {
  const id = clean(row && row.moduleId);
  return MODULE_IDS.includes(id) ? id : "home";
}

/** 粉丝快照只存 accountId，账号本身要回 mediaAccounts 里找 */
function accountOf(row, data) {
  const id = clean(row && row.accountId);
  if (!id) return null;
  return readTable(data, "mediaAccounts").find((a) => a && clean(a.id) === id) || null;
}

/** 快照上取账号的一个字段（名字 / 平台）；账号没了就给空串 */
function accountField(row, data, key) {
  const a = accountOf(row, data);
  return a ? clean(a[key]) : "";
}

/**
 * 每个模块查哪张表、哪几段文本。
 *   table  —— 表名，支持 "finance.transactions" 这种带点的路径
 *   rows   —— 表不是数组时用它摊平（模块目标按模块 id 分桶，见 goalsOf）
 *   module —— 点结果时跳到哪个模块（地址 #<module>）；写成函数就一行一个模块
 *   hash   —— 少数子页有自己地址的（债务在 #finance/debt），单列
 *   label  —— 结果卡片上那枚标签（短，别撑爆那枚小胶囊）
 *   alias  —— 只进匹配、不上屏的同义词：搜「bug」「健身」「记账」也能带出记录
 *   title  —— 卡片正文默认显示哪段（可以是键名，也可以是一个取值函数）
 *   fields —— 参与匹配的所有文本（键名，或 (row, data) => 文本 的取值函数）
 * 数组存在的表都在这儿列全了；回收站不单独搜（归档靠面板底部那个勾选框）。
 */
export const SOURCE_SPECS = [
  { table: "tasks", module: "plan", label: "待办", title: "text",
    alias: "任务 今日计划",
    fields: ["text", "note", "category", "belong"] },
  { table: "contents", module: "media", label: "自媒体", title: "title",
    alias: "作品 选题 发布",
    fields: ["title", "platform", "status", "note", "link"] },
  { table: "mediaAccounts", module: "media", label: "账号", title: "name",
    alias: "自媒体",
    fields: ["name", "platform", "intro", "note"] },
  { table: "projects", module: "dev", label: "项目", title: "name",
    alias: "开发工作",
    fields: ["name", "intro", "description", "status"] },
  { table: "issues", module: "dev", label: "问题", title: "title",
    alias: "bug 缺陷 报错 开发工作",
    fields: ["title", "desc", "module", "severity", "status"] },
  { table: "progress", module: "dev", label: "进展", title: "text",
    alias: "开发工作",
    fields: ["text", "date"] },
  { table: "subjects", module: "study", label: "学习对象", title: "name",
    alias: "学习工作",
    fields: ["name", "source", "note", "kind"] },
  { table: "studies", module: "study", label: "学习", title: "content",
    alias: "学习工作",
    fields: ["content", "takeaway", "date"] },
  { table: "workoutLogs", module: "fitness", label: "打卡", title: "moves",
    alias: "健身 训练",
    fields: ["moves", "note", "date"] },
  { table: "weights", module: "fitness", label: "体重", title: "date",
    alias: "健身",
    // kg / bodyFat 是数据里真有的列；note 是备用形状，有就一起搜，没有就是空串
    fields: ["date", "note", (r) => numText(r.kg, " kg"), (r) => numText(r.bodyFat, "% 体脂")] },
  { table: "meals", module: "diet", label: "饮食", title: "date",
    alias: "吃饭 三餐",
    fields: ["breakfast", "lunch", "dinner", "snack", "date"] },
  { table: "water", module: "diet", label: "饮水", title: "date",
    alias: "喝水 饮食",
    // cups 是数据里真有的列；ml / time / note 是备用形状（老数据或导入的数据）
    fields: ["date", "time", "note", (r) => numText(r.cups, " 杯"), (r) => numText(r.ml, " ml")] },
  // 模块目标（健身 / 学习 / 饮食）不是「一张数组表」，是按模块 id 分成的桶，
  // 所以用 rows 自己摊平；每条跳回它自己那个模块（健身目标回健身页）。
  { rows: goalsOf, module: goalModule, title: "mainTarget",
    label: "目标", alias: "模块目标 健身目标 学习目标 饮食目标",
    fields: ["mainTarget", "dailyRule", "remark", "moduleName", "cycle", "startDate", "endDate"] },
  // 粉丝快照自己只存 accountId，账号名 / 平台要回账号表里找 —— 搜「B站」也能
  // 带出那天的快照。点结果回自媒体页（快照没有自己的子地址）。
  { table: "mediaFollowers", module: "media", label: "粉丝",
    alias: "自媒体 粉丝快照 涨粉",
    title: (r, data) => {
      const a = accountOf(r, data);
      const who = a ? a.name || a.platform || "" : "";
      return [who, numText(r.count, " 粉"), r.date].filter(Boolean).join(" · ");
    },
    fields: ["date", (r) => numText(r.count, " 粉"),
             (r, data) => accountField(r, data, "name"),
             (r, data) => accountField(r, data, "platform")] },
  { table: "games", module: "game", label: "游戏", title: "name",
    alias: "游戏娱乐",
    fields: ["name", "platform", "status", "progress"] },
  { table: "gameRecords", module: "game", label: "游玩记录", title: "gameName",
    alias: "游戏 游戏娱乐",
    fields: ["gameName", "remark", "playDate"] },
  { table: "finance.transactions", module: "finance", label: "账目",
    alias: "记账 支出 收入 花费 花销",
    title: (r) => r.note || r.category || yuanText(r.amountCents),
    fields: ["note", "category", "date", (r) => yuanText(r.amountCents)] },
  { table: "finance.accounts", module: "finance", label: "账户", title: "name",
    alias: "记账 余额",
    fields: ["name", (r) => yuanText(r.initialBalanceCents)] },
  { table: "debt.items", module: "finance", hash: "finance/debt", label: "债务", title: "name",
    alias: "记账 欠款 借款 还款",
    fields: ["name", "creditor", "note", "dueDate", (r) => yuanText(r.totalCents)] },
];

/**
 * 取一个值：键名就直接读，函数就调用 —— 函数能拿到 (row, data)，所以
 * 粉丝快照这种要回别的表里取字段的也能写。空值一律给空串。
 */
function valueOf(field, row, data) {
  if (typeof field === "function") return clean(field(row, data));
  return clean(row ? row[field] : "");
}

/** 取一段文本：就是 valueOf，单独一个名字读起来顺一点 */
function textOf(field, row, data) {
  return valueOf(field, row, data);
}

/** module / hash 这类：写成字符串就是固定值，写成函数就按行算 */
function fixedOrFn(value, row, data) {
  return typeof value === "function" ? clean(value(row, data)) : clean(value);
}

function clean(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

/** 照着 "finance.transactions" 这种路径取表；取不到就返回空数组，绝不新建键 */
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
 * 一条 spec 摊出哪几行：数组表直接按路径读，不是数组的（模块目标）走 spec.rows。
 * 导出给单测用，好在「池子条数 = 各表条数之和」那条断言里算出一份期望值。
 */
export function sourceRows(data, spec) {
  const rows = typeof spec.rows === "function" ? spec.rows(data) : readTable(data, spec.table);
  return Array.isArray(rows) ? rows : [];
}

/**
 * 把所有模块的记录摊成一张只读的搜索池。每条带上来源模块、跳转地址、显示文本，
 * 以及一段拼好的 haystack。不改动传进来的数据。
 */
export function buildSearchPool(data) {
  const pool = [];
  for (const spec of SOURCE_SPECS) {
    for (const row of sourceRows(data, spec)) {
      if (!row || typeof row !== "object") continue;
      const title = textOf(spec.title, row, data) || textOf(spec.fields[0], row, data);
      const fields = spec.fields
        .map((f) => textOf(f, row, data))
        .filter(Boolean)
        .map((raw) => ({ raw, norm: normalizeText(raw) }));
      const module = fixedOrFn(spec.module, row, data);
      pool.push({
        module,
        hash: fixedOrFn(spec.hash, row, data) || module,
        label: spec.label,
        archived: row.isArchived === true,
        title,
        titleNorm: normalizeText(title),
        fields,
        // 模块名和同义词也算命中：搜「健身」「记账」「bug」能把该模块的记录带出来
        hay: normalizeText(
          [title, ...fields.map((f) => f.raw), spec.label, spec.alias || ""].join(" ")
        ),
      });
    }
  }
  return pool;
}

/**
 * 按关键词搜所有模块，返回排好序的命中列表（不截断，摆多少条由界面决定）。
 * 命中标题的排前面，命中备注/分类的其次，只命中模块名（健身、记账…）的排最后；
 * 同分保持模块原顺序。
 *
 * @param {object} data 完整的 data 对象
 * @param {string} query 关键词
 * @param {boolean} includeArchived 归档条目要不要一起搜，默认不搜
 */
export function searchAll(data, query, includeArchived = false) {
  const kw = normalizeText(query);
  if (!kw) return [];
  const hits = [];
  for (const item of buildSearchPool(data)) {
    if (item.archived && !includeArchived) continue;
    if (!item.hay.includes(kw)) continue;
    const field = item.fields.find((f) => f.norm.includes(kw));
    hits.push({
      module: item.module,
      hash: item.hash,
      label: item.label,
      text: field ? field.raw : item.title || item.label,
      score: item.titleNorm.includes(kw) ? 3 : field ? 2 : 1,
    });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits;
}
