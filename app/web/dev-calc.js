/* 开发工作的纯逻辑：待办 / bug 条目的字段规整、状态口径、统计、筛选与归档。
 *
 * 抽出来是因为两件最容易写错的事：**哪些状态算「没解决」**，以及
 * **老版本里的状态名怎么迁**；归档也是同一类事——「哪条该出现在主列表」
 * 只由这里说了算，页面照着画就行。放成纯函数，`node tests\开发计算.test.mjs`
 * 就能一条条断言，不用开浏览器。
 */

import { MODULES } from "./modules.js";
import { rowPaths } from "./attachment-calc.js";

/** 一条记录归没归档。缺字段的老数据一律当「没归档」，所以老数据不用搬。 */
export function archivedOf(row) {
  return Boolean(row && typeof row === "object" && row.isArchived === true);
}

/**
 * 把一堆记录按归档拆成两拨：主列表要 `active`，侧边抽屉要 `archived`。
 * 2026-10-08 从「卡片内折叠」改成「右侧抽屉」之后，两处都是这么分的，
 * 所以放成纯函数，一条条断言就行。
 */
export function splitByArchive(rows) {
  const active = [];
  const archived = [];
  for (const row of rows || []) (archivedOf(row) ? archived : active).push(row);
  return { active, archived };
}

/** 按归档档位过一条记录：no 只放没归档的（主列表的默认），only 只放归档的，all 都放 */
function passArchived(row, mode) {
  if (mode === "all") return true;
  return mode === "only" ? archivedOf(row) : !archivedOf(row);
}

/** 优先级（UI 上叫「优先级」，字段名沿用原来的 severity，老数据不用搬） */
export const SEVERITY = ["高", "中", "低"];

/** bug 状态。2026-10-07 扩过一次：处理中 → 进行中、已解决 → 已修复，
 *  中间补了一个「已复现」（复现出来了但还没动手） */
export const ISSUE_STATUS = ["待处理", "进行中", "已复现", "已修复", "已关闭"];

/** 关联模块：这个 bug 是 App 哪个模块的问题。「通用」留给跨模块 / 说不清的。 */
export const DEFAULT_ISSUE_MODULE = "通用";
export const ISSUE_MODULES = [DEFAULT_ISSUE_MODULE, ...MODULES.map((m) => m.name)];

/** 老状态名 → 现名。读老数据时在内存里迁一次，页面别处不用管。 */
const STATUS_ALIAS = { 处理中: "进行中", 已解决: "已修复" };

/** 「已修复 / 已关闭」才算结；「已解决」是老名字，一并认（数据文件还没保存过时可能还是它） */
const CLOSED_STATUS = ["已修复", "已关闭", "已解决"];

export function normalizeStatus(status) {
  const text = String(status == null ? "" : status).trim();
  if (STATUS_ALIAS[text]) return STATUS_ALIAS[text];
  return ISSUE_STATUS.includes(text) ? text : "待处理";
}

export function isIssueClosed(status) {
  return CLOSED_STATUS.includes(String(status == null ? "" : status).trim());
}

export function normalizeSeverity(severity) {
  return SEVERITY.includes(severity) ? severity : "中";
}

export function normalizeModule(module) {
  return ISSUE_MODULES.includes(module) ? module : DEFAULT_ISSUE_MODULE;
}

/** 一条 bug 的展示用副本：缺字段就补默认值，一条都不丢 */
export function normalizeIssue(row) {
  const r = row && typeof row === "object" ? row : {};
  return {
    id: String(r.id || ""),
    projectId: String(r.projectId || ""),
    title: String(r.title || ""),
    desc: String(r.desc || ""),
    severity: normalizeSeverity(r.severity),
    status: normalizeStatus(r.status),
    module: normalizeModule(r.module),
    imagePaths: rowPaths(r),
    createdAt: String(r.createdAt || ""),
    fixedAt: String(r.fixedAt || ""),
    isArchived: archivedOf(r),
    archivedAt: String(r.archivedAt || ""),
  };
}

/** 一条开发待办的展示用副本（今日计划的任务不走这里，它们不看归档） */
export function normalizeTodo(row) {
  const r = row && typeof row === "object" ? row : {};
  return {
    id: String(r.id || ""),
    belong: String(r.belong || ""),
    text: String(r.text || ""),
    done: r.done === true,
    priority: String(r.priority || ""),
    note: String(r.note || ""),
    imagePaths: rowPaths(r),
    createdAt: String(r.createdAt || ""),
    doneAt: String(r.doneAt || ""),
    isArchived: archivedOf(r),
    archivedAt: String(r.archivedAt || ""),
  };
}

/** 一条进展的展示用副本 */
export function normalizeProgress(row) {
  const r = row && typeof row === "object" ? row : {};
  return {
    id: String(r.id || ""),
    projectId: String(r.projectId || ""),
    date: String(r.date || ""),
    text: String(r.text || ""),
    imagePaths: rowPaths(r),
  };
}

/** 卡片标题上那几个数：未解决 / 进行中 / 已修复。
 *  默认不算归档的（归档的不占主列表，也不该占这几个数）；
 *  要连归档一起数就传 { includeArchived: true }。 */
export function issueStats(issues, { includeArchived = false } = {}) {
  const list = (issues || []).map(normalizeIssue).filter((i) => includeArchived || !i.isArchived);
  const pending = list.filter((i) => i.status === "待处理").length;
  const doing = list.filter((i) => i.status === "进行中").length;
  const reproduced = list.filter((i) => i.status === "已复现").length;
  const fixed = list.filter((i) => i.status === "已修复").length;
  const closed = list.filter((i) => i.status === "已关闭").length;
  return {
    total: list.length,
    open: pending + doing + reproduced,   // 未解决 = 还没修复也没关闭
    pending,
    doing,
    reproduced,
    fixed,
    closed,
  };
}

/** 按关键词 / 状态 / 优先级 / 模块 / 归档筛一条 bug。全部是「只看显示」，不动数据。 */
export function matchIssue(
  row,
  { kw = "", status = "all", severity = "all", module = "all", archived = "no" } = {}
) {
  const i = normalizeIssue(row);
  if (!passArchived(row, archived)) return false;
  if (status !== "all" && i.status !== status) return false;
  if (severity !== "all" && i.severity !== severity) return false;
  if (module !== "all" && i.module !== module) return false;
  const needle = String(kw || "").trim().toLowerCase();
  if (!needle) return true;
  return [i.title, i.desc, i.module].some((v) => v.toLowerCase().includes(needle));
}

/** "2026-10-07 12:30" → 本地零点的时间戳；读不出来给 0 */
function dayStamp(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(text || ""));
  if (!m) return 0;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

/** 从记录到修复隔了几天；没修好或者时间不全就给 null */
export function cycleDays(row) {
  const i = normalizeIssue(row);
  const start = dayStamp(i.createdAt);
  const end = dayStamp(i.fixedAt);
  if (!start || !end || end < start) return null;
  return Math.round((end - start) / 86400000);
}

/** 进展按日期从新到旧；同一天的按原来录入的先后倒着排（后记的更靠上） */
export function progressSorted(list) {
  return (list || [])
    .map((row, index) => ({ row: normalizeProgress(row), index }))
    .sort((a, b) => {
      if (a.row.date !== b.row.date) return a.row.date < b.row.date ? 1 : -1;
      return b.index - a.index;
    })
    .map((it) => it.row);
}
