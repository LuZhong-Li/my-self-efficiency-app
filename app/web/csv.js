/* CSV 拼装：只是「一格格子 → 一段文本」，记账和自媒体共用一份。
 * 单独一个文件是因为它跟钱、跟自媒体都没关系；两个模块各抄一份，迟早走岔
 * （一边裹引号、一边忘了，备注里带个逗号就串列）。 */

/** CSV 里一个格子：带逗号 / 引号 / 换行的裹进引号，里面的引号翻倍 */
export function csvCell(value) {
  const text = value === undefined || value === null ? "" : String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return '"' + text.replace(/"/g, '""') + '"';
}

/**
 * 表头 + 若干行 → 一份 CSV 文本。
 * 开头带 UTF-8 **BOM**（不带的话 Excel 打开中文是乱码），行尾用 \r\n（Excel 认这个）。
 */
export function csvText(head, rows) {
  const lines = [head].concat(rows || []);
  return "\ufeff" + lines.map((r) => (r || []).map(csvCell).join(",")).join("\r\n") + "\r\n";
}
