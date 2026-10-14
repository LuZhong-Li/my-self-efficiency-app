/* Steam 离线导入的纯逻辑测试：csv.js 的 parseCsvText（读 CSV）
 * 和 game-calc.js 的 parsePlayCsv / parseDurationText / dupeOf（认成一条条游玩记录）。
 * 跑法：node tests\游戏导入.test.mjs   （本机 Node v24，不需要 package.json）
 * 说明：和别的 .test.mjs 一样，不进「自检.cmd」——自检是给用户一键跑的，保持纯 Python。 */

import { parseCsvText } from "../app/web/csv.js";
import {
  parsePlayCsv, parseDurationText, parseDateText, dupeOf,
} from "../app/web/game-calc.js";

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

function ok(cond, label) {
  eq(Boolean(cond), true, label);
}

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

console.log("\n【读 CSV：基本形状】");
eqDeep(parseCsvText("a,b\n1,2"), [["a", "b"], ["1", "2"]], "两行两列");
eqDeep(parseCsvText("a,b\r\n1,2\r\n"), [["a", "b"], ["1", "2"]], "CRLF 的行尾也认");
eqDeep(parseCsvText("a;b\n1;2"), [["a", "b"], ["1", "2"]], "分号分隔也认");
eqDeep(parseCsvText("a\tb\n1\t2"), [["a", "b"], ["1", "2"]], "制表符分隔也认");
eqDeep(parseCsvText("\ufeffa,b\n1,2"), [["a", "b"], ["1", "2"]], "开头的 BOM 吃掉");
eqDeep(parseCsvText("a,b\n\n1,2\n\n"), [["a", "b"], ["1", "2"]], "空行丢掉");
eqDeep(parseCsvText(""), [], "空文本给空数组");
eqDeep(parseCsvText(null), [], "传 null 不炸");
eqDeep(parseCsvText("单列\n值"), [["单列"], ["值"]], "只有一列也能读");
eqDeep(parseCsvText("a,b,"), [["a", "b", ""]], "行尾少一格时补空");

console.log("\n【读 CSV：引号】");
eqDeep(parseCsvText('a,"b,c"'), [["a", "b,c"]], "引号里的逗号不当分隔符");
eqDeep(parseCsvText('a,"他说""你好"""'), [["a", '他说"你好"']], "翻倍的双引号还原成一个");
eqDeep(parseCsvText('a,"第一行\n第二行"'), [["a", "第一行\n第二行"]], "引号里的换行留着");
eqDeep(parseCsvText('"空格 , 也在里面"'), [["空格 , 也在里面"]], "整格裹引号");

console.log("\n【时长的几种写法】");
eq(parseDurationText("1:30"), 90, "1:30 = 90 分钟");
eq(parseDurationText("01:30:00"), 90, "时:分:秒也认");
eq(parseDurationText("12.5h"), 750, "12.5h = 750 分钟");
eq(parseDurationText("1.5 hrs"), 90, "1.5 hrs 也认");
eq(parseDurationText("12.5 小时"), 750, "中文「小时」也认");
eq(parseDurationText("90m"), 90, "90m = 90 分钟");
eq(parseDurationText("90 分钟"), 90, "中文「分钟」也认");
eq(parseDurationText("90"), 90, "纯数字按分钟算");
eq(parseDurationText("0"), 0, "0 就是 0（导入时会被跳过）");
eq(parseDurationText(""), 0, "空串给 0");
eq(parseDurationText("不知道"), 0, "认不出给 0");
eq(parseDurationText(null), 0, "传 null 不炸");

console.log("\n【日期的几种写法：都归一成 YYYY-MM-DD】");
eq(parseDateText("2026-10-14"), "2026-10-14", "横杠那种原样");
eq(parseDateText("2026/10/13"), "2026-10-13", "斜杠那种归一");
eq(parseDateText("2026.10.3"), "2026-10-03", "点号那种也认，月份补零");
eq(parseDateText("2026年10月10日"), "2026-10-10", "中文那种也认");
eq(parseDateText(""), "", "空着就给空（没日期的记录只进累计）");
eq(parseDateText("前天"), "", "认不出给空，不瞎猜");
eq(parseDateText(null), "", "传 null 不炸");

console.log("\n【认成一条条游玩记录：中文表头】");
const CSV_CN = [
  "游戏名,时长,日期,备注",
  "只狼,1:30,2026-10-14,打到苇名弦一郎",
  "空洞骑士,12.5h,2026/10/13,",
  ",30,2026-10-12,没写游戏名",
  "巫师3,不知道,2026-10-11,时长认不出",
  "只狼,45,2026年10月10日,二周目",
].join("\n");
const parsedCn = parsePlayCsv(CSV_CN);
eq(parsedCn.headerBy, "name", "表头是按名字认出来的");
eq(parsedCn.rows.length, 3, "六行里三行认出来了");
eqDeep(parsedCn.rows[0], { gameName: "只狼", playDate: "2026-10-14", durationMin: 90,
  remark: "打到苇名弦一郎" }, "第一条：名字 / 日期 / 时长 / 备注都对");
eq(parsedCn.rows[1].durationMin, 750, "12.5h 换算成 750 分钟");
eq(parsedCn.rows[1].playDate, "2026-10-13", "斜杠日期归一成横杠（统计靠字符串比，必须归一）");
eq(parsedCn.rows[2].playDate, "2026-10-10", "中文日期也归一");
eqDeep(parsedCn.skipped.map((s) => s.line), [4, 5], "跳过的行号是 4 和 5（表头算第 1 行）");
eq(parsedCn.skipped[0].why, "没写游戏名", "第一处跳过说了原因");
eq(parsedCn.skipped[1].why, "时长认不出", "第二处也说了原因");

console.log("\n【认成一条条游玩记录：英文表头】");
const CSV_EN = [
  "Game,Playtime,Date,Note",
  "Sekiro,7:30,2026-10-14,boss run",
].join("\n");
const parsedEn = parsePlayCsv(CSV_EN);
eq(parsedEn.headerBy, "name", "英文表头也认得出");
eq(parsedEn.rows.length, 1, "一条");
eq(parsedEn.rows[0].durationMin, 450, "7:30 = 450 分钟");
eq(parsedEn.rows[0].gameName, "Sekiro", "游戏名");
eq(parsedEn.rows[0].remark, "boss run", "备注");

console.log("\n【表头认不出：按位置兜底】");
const CSV_POS = [
  "col1,col2,col3",
  "只狼,90,2026-10-14",
].join("\n");
const parsedPos = parsePlayCsv(CSV_POS);
eq(parsedPos.headerBy, "position", "认不出表头就按位置兜底，并标出来");
eq(parsedPos.rows.length, 1, "按位置也认出一条");
eq(parsedPos.rows[0].gameName, "只狼", "第一列当游戏名");
eq(parsedPos.rows[0].durationMin, 90, "第二列当时长");

console.log("\n【空与坏输入】");
eqDeep(parsePlayCsv("").rows, [], "空文本：一条都没有");
eqDeep(parsePlayCsv(null).rows, [], "传 null 不炸");
eqDeep(parsePlayCsv("游戏名,时长").rows, [], "只有表头：没有记录");
eqDeep(parsePlayCsv("游戏名,时长").skipped, [], "只有表头时不算「跳过」");

console.log("\n【重复识别】");
const EXISTING = [{ gameName: "只狼", playDate: "2026-10-14", durationMin: 90 }];
const rows = [
  { gameName: "只狼", playDate: "2026-10-14", durationMin: 90 },
  { gameName: "只狼", playDate: "2026-10-14", durationMin: 91 },
  { gameName: "只狼", playDate: "2026-10-13", durationMin: 90 },
  { gameName: "空洞骑士", playDate: "2026-10-14", durationMin: 90 },
];
const dd = dupeOf(rows, EXISTING);
eq(dd.dupes.length, 1, "只有第一条算重复（同游戏 + 同日期 + 同时长）");
eq(dd.fresh.length, 3, "其余三条是新的");
eqDeep(dupeOf(rows, []).fresh.length, 4, "库里没有记录时一条都不算重复");
eqDeep(dupeOf(null, EXISTING), { fresh: [], dupes: [] }, "传 null 不炸");

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
