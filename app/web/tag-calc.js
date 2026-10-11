/* 标签的纯逻辑：标签就是记录上的一个字符串数组。
 * 设计见 docs/superpowers/specs/2026-10-11-标签系统-design.md。
 *
 * 这里只管标签自己那一层：一串文本怎么切成标签、怎么洗干净、颜色取哪一档。
 * 「哪张表、跳到哪里、跨模块怎么捞」在 search-calc.js（它本来就管着那张表清单）。
 * 不 import 任何东西，Node 里能直接跑单测。 */

/** 单个标签最多几个字（超了截断；输入框里另外给提示，见 tagInputError） */
export const TAG_MAX_CHARS = 24;

/** 一条记录最多贴几个标签 */
export const TAG_LIMIT = 8;

/** 调色板只有这几档（style.css 里 .chip.tag-chip[data-c="1"…8]） */
export const TAG_PALETTE = 8;

/** 分隔符：中英文逗号、顿号、分号、空格、换行都算 */
const SPLIT = /[,，、;；\s]+/;

/** 把输入框里那一串切开（还没洗：可能带空白、可能重复） */
export function parseTagInput(text) {
  const raw = String(text == null ? "" : text);
  return raw.split(SPLIT).filter(Boolean);
}

/**
 * 洗干净：丢掉非字符串与空白、每个截到 TAG_MAX_CHARS 个字、
 * 按「忽略大小写与首尾空白」去重（留第一次写下的那个写法）、最多留 TAG_LIMIT 个。
 * 数组或字符串都收（手改数据可能把数组写成字符串），别的类型当空。
 * 顺序不排：他自己写的顺序就是他心里的重次。
 */
export function normalizeTags(value) {
  const list = Array.isArray(value)
    ? value
    : typeof value === "string" ? parseTagInput(value) : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (typeof item !== "string") continue;
    const name = item.trim().slice(0, TAG_MAX_CHARS);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= TAG_LIMIT) break;
  }
  return out;
}

/** 一条记录上的标签 —— 读标签一律走这里，别直接读 row.tags（老数据没有这个字段） */
export function tagsOfRow(row) {
  return normalizeTags(row && typeof row === "object" ? row.tags : []);
}

/** 编辑时填回输入框：["工作","本周"] → "工作、本周" */
export function tagsText(list) {
  return normalizeTags(list).join("、");
}

/**
 * 行上最多画几个标签：够的话全画，多了就画前 max 个、剩下的收成 +N。
 * 抽出来单独放是因为「画 HTML」那半截在 ui.js（跑不进 Node），
 * 而「画几个、剩几个」这种算术值得单测。
 */
export function visibleTags(list, max = 3) {
  const tags = normalizeTags(list);
  const keep = Math.max(0, Math.floor(max));
  return { shown: tags.slice(0, keep), rest: Math.max(0, tags.length - keep) };
}

/**
 * 输入框里那一串有没有毛病（超量 / 单个太长）。
 * 页面上要当场告诉人，不能静默截断 —— 截断是数据层 normalizeTags 的事。
 */
export function tagInputError(text) {
  const parts = parseTagInput(text).map((s) => s.trim()).filter(Boolean);
  if (new Set(parts.map((s) => s.toLowerCase())).size > TAG_LIMIT) {
    return `最多 ${TAG_LIMIT} 个标签`;
  }
  if (parts.some((s) => s.length > TAG_MAX_CHARS)) {
    return `单个标签最多 ${TAG_MAX_CHARS} 个字`;
  }
  return "";
}

/** 名字 → 调色板第几档（1..TAG_PALETTE）。同一个名字永远同色，颜色不落盘。 */
export function tagColor(name) {
  const key = String(name == null ? "" : name).trim().toLowerCase();
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) % 1000003;
  }
  return (hash % TAG_PALETTE) + 1;
}
