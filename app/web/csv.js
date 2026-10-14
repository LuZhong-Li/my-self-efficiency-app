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

/**
 * 反过来：一段 CSV 文本 → 二维数组（2026-10-14 加的，给「离线导入」用）。
 *
 * 各家导出的 CSV 脾气不一样，所以这里尽量宽：
 *   · 开头有 UTF-8 BOM（Excel 存出来的都有）就先吃掉；
 *   · 分隔符看表头那一行里 逗号 / 分号 / 制表符 哪个多就用哪个；
 *   · 认带引号的格子（里面的逗号、换行、翻倍的双引号照原样还回来）；
 *   · CRLF / LF 都认；空行丢掉（末尾的换行不算一行）。
 * 纯函数：不碰 DOM、不发请求、不改传进来的东西。
 */
export function parseCsvText(text) {
  const src = String(text == null ? "" : text).replace(/^\ufeff/, "");
  if (!src.trim()) return [];
  const delimiter = pickDelimiter(src);
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === delimiter) {
      row.push(cell);
      cell = "";
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
      row.push(cell);
      cell = "";
      pushRow(rows, row);
      row = [];
      continue;
    }
    cell += ch;
  }
  row.push(cell);
  pushRow(rows, row);
  return rows;
}

/** 空行（整行都是一个空格子的那些）不收 */
function pushRow(rows, row) {
  if (row.length === 1 && !row[0].trim()) return;
  rows.push(row.map((c) => c.trim()));
}

/** 表头那一行里哪个分隔符多就用哪个（都没有时按逗号） */
function pickDelimiter(src) {
  const head = src.split(/\r?\n/)[0] || "";
  const counts = [",", ";", "\t"].map((d) => [d, head.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ",";
}
