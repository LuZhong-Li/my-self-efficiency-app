/* 数据集（多套数据文件）的纯逻辑：名字规则、列表顺序、一行摘要。
 * 只吃参数、吐结果，不碰 DOM、不碰数据 —— 所以能用 node 直接跑断言
 * （tests\数据集计算.test.mjs）。
 *
 * 名字规则和服务端 app\服务.py 的 check_dataset_name 是**同一套**（含文案）：
 * 服务端那份才是权威（真拦），这份是为了「当场把按钮灰掉 + 说清为什么」。
 * 三张表必须一致 —— tests\自检.py 里有一条把它们抠出来比对。
 */

/** 名字最多几个字（和 服务.py 的 DATASET_NAME_MAX 对齐） */
export const DATASET_NAME_MAX = 24;

/** 名字里不能有的字符：Windows 文件名里都不允许 */
export const DATASET_BAD_CHARS = '\\/:*?"<>|';

/** Windows 的保留设备名（不看大小写） */
export const DATASET_RESERVED = [
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/**
 * 名字合不合规：通过给空串，不通过给一句中文原因。
 * 先自己去首尾空格（服务端那边也一样），所以「打多了个空格」不算错。
 */
export function checkDatasetName(raw, existing = []) {
  const name = String(raw == null ? "" : raw).trim();
  if (!name) return "得给这份数据起个名字";
  // 用 [...name] 数「字」，和 Python 那边数的一样（emoji 不会被算成两个字符）
  if ([...name].length > DATASET_NAME_MAX) return `名字最多 ${DATASET_NAME_MAX} 个字`;
  for (const ch of name) {
    if (DATASET_BAD_CHARS.includes(ch)) return '名字里不能有 \\ / : * ? " < > |';
    if (ch.codePointAt(0) < 32) return "名字里不能有控制字符";
  }
  if (name === "." || name === ".." || name.startsWith(".")) return "名字不能以点开头";
  if (name.endsWith(".")) return "名字不能以点结尾";
  if (DATASET_RESERVED.includes(name.toLowerCase())) return `「${name}」是系统保留的名字`;
  if ((existing || []).map((n) => String(n)).includes(name)) return `已经有一份叫「${name}」的了`;
  return "";
}

/**
 * 列表顺序：当前那份永远第一，其余按名字排（可预期，不随「最后修改时间」乱跳）。
 * 坏条目（null、没名字的）丢掉。返回新数组，不改传进来的那个。
 */
export function sortDatasets(items = [], current = "") {
  return (items || [])
    .filter((it) => it && it.name)
    .slice()
    .sort((a, b) => {
      const ac = a.name === current ? 0 : 1;
      const bc = b.name === current ? 0 : 1;
      if (ac !== bc) return ac - bc;
      return String(a.name).localeCompare(String(b.name), "zh");
    });
}

/** 一行摘要：「128 条 · 10-14 15:30」「空」「读不出来」 */
export function datasetMetaText(item) {
  if (!item || item.bad) return "读不出来";
  const n = Number(item.count) || 0;
  return (n ? n + " 条" : "空") + (item.updatedAt ? " · " + shortStamp(item.updatedAt) : "");
}

/** 「2026-10-14 15:30:00」→「10-14 15:30」；认不出来就原样返回（不吞信息） */
function shortStamp(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(text));
  return m ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}` : String(text);
}
