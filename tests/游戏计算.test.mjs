/* 游戏娱乐纯逻辑（app/web/game-calc.js）的单元测试。
 * 跑法：node tests\游戏计算.test.mjs   （本机 Node v24，不需要 package.json）
 * 说明：和别的 .test.mjs 一样，不进「自检.cmd」——自检是给用户一键跑的，保持纯 Python。 */

import {
  DURATION_UNITS, LOOSE_NAME, normalizeRecord, durationText, hoursOf, hoursText,
  toMinutes, shownDuration, linkGameId, belongsTo, recordsOn, recordsOfGame,
  totalMinutesOfGame, sumMinutes, weekStartOf, statsOf, topGames, hasFilter,
  filterRecords, recordTitle, elapsedMinutes, clockText, overTargetGames,
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

function ok(cond, label) {
  eq(Boolean(cond), true, label);
}

/* ---------------- 时长换算 ---------------- */

eqDeep(DURATION_UNITS, ["分钟", "小时"], "单位就两个：分钟 / 小时");
eq(durationText(120), "2 小时", "120 分钟 → 2 小时");
eq(durationText(90), "1 小时 30 分钟", "90 分钟 → 1 小时 30 分钟");
eq(durationText(45), "45 分钟", "不满一小时就按分钟说");
eq(durationText(60), "1 小时", "正好一小时不啰嗦");
eq(durationText(0), "—", "没填时长给一个占位，不显示 0 小时");
eq(durationText("120"), "2 小时", "字符串进来的分钟也认（手写的数据）");
eq(hoursOf(120), 2, "120 分钟是 2 小时");
eq(hoursOf(90), 1.5, "90 分钟是 1.5 小时");
eq(hoursText(0), "0 小时", "统计格里 0 也写出来（0 小时本身是有用的信息）");

eq(toMinutes(2, "小时"), 120, "2 小时 = 120 分钟");
eq(toMinutes(90, "分钟"), 90, "按分钟填就是原数");
eq(toMinutes(1.5, "小时"), 90, "半小时也认（小数小时）");
eq(toMinutes("abc", "小时"), 0, "乱填按 0 算，不写进去 NaN");
eqDeep(shownDuration(120), { amount: 2, unit: "小时" }, "编辑时整小时按小时回填");
eqDeep(shownDuration(90), { amount: 90, unit: "分钟" }, "不是整小时就按分钟回填");
eqDeep(shownDuration(0), { amount: 0, unit: "分钟" }, "0 按分钟回填");

/* ---------------- 一条记录 ---------------- */

eqDeep(normalizeRecord({ id: "r1", gameName: " 只狼 ", playDate: "2026-10-07", durationMin: "90" }),
  { id: "r1", gameId: "", gameName: "只狼", playDate: "2026-10-07", durationMin: 90,
    remark: "", createAt: "", imagePaths: [] },
  "记录补齐成完整形状（名字去空白、时长转数字）");
eqDeep(normalizeRecord(null),
  { id: "", gameId: "", gameName: "", playDate: "", durationMin: 0,
    remark: "", createAt: "", imagePaths: [] },
  "空的也认，不抛错");
eq(normalizeRecord({ durationMin: -30 }).durationMin, 0, "负数当 0");
eqDeep(normalizeRecord({ imagePaths: ["a.png", "", 3] }).imagePaths, ["a.png"],
  "图片只留非空字符串");

/* ---------------- 记录 ↔ 清单 ---------------- */

const games = [
  { id: "g1", name: "王者荣耀", status: "在玩" },
  { id: "g2", name: "空洞骑士", status: "已通关" },
  { id: "g3", name: "只狼", status: "在玩" },
];
eq(linkGameId("王者荣耀", { 王者荣耀: "g1" }), "g1", "名字对上清单就绑上 id");
eq(linkGameId("没听过的小游戏", { 王者荣耀: "g1" }), "", "清单里没有就留空，只统计不绑定");
eq(linkGameId("", { 王者荣耀: "g1" }), "", "没写名字就没得绑");

eq(belongsTo({ gameId: "g1", gameName: "旧名字" }, games[0]), true, "认 id：改过名的记录也还挂得住");
eq(belongsTo({ gameId: "", gameName: "只狼" }, games[2]), true, "没 id 就按名字对");
eq(belongsTo({ gameId: "g9", gameName: "只狼" }, games[2]), false, "有 id 但指的不是这款，就不算");

const records = [
  { id: "p1", gameId: "g1", gameName: "王者荣耀", playDate: "2026-10-05", durationMin: 60,
    remark: "排位", createAt: "2026-10-05T21:00:00" },
  { id: "p2", gameId: "g1", gameName: "王者荣耀", playDate: "2026-10-07", durationMin: 120,
    remark: "", createAt: "2026-10-07T20:00:00" },
  { id: "p3", gameId: "g1", gameName: "王者荣耀", playDate: "2026-10-07", durationMin: 30,
    remark: "午后一把", createAt: "2026-10-07T14:00:00" },
  { id: "p4", gameId: "", gameName: "随手玩的小游戏", playDate: "2026-10-07", durationMin: 25,
    remark: "", createAt: "2026-10-07T10:00:00" },
  { id: "p5", gameId: "g2", gameName: "空洞骑士", playDate: "2026-09-20", durationMin: 480,
    remark: "", createAt: "2026-09-20T22:00:00" },
];

eqDeep(recordsOn(records, "2026-10-07").map((r) => r.id), ["p2", "p3", "p4"],
  "某一天的记录：同一天里新记的排前面");
eqDeep(recordsOn(records, "2026-01-01"), [], "没记过的那天就是空数组");
eqDeep(recordsOfGame(records, games[0]).map((r) => r.id), ["p2", "p3", "p1"],
  "某款游戏的全部记录：日期从新到旧");
eqDeep(recordsOfGame(records, games[2]), [], "没玩过的游戏没有记录");

eq(totalMinutesOfGame(records, games[0]), 210, "累计 = 这款游戏的记录求和");
eq(totalMinutesOfGame(records, { id: "g9", name: "只狼", hours: 4 }), 240,
  "老数据里手填的小时也算进累计");
eq(totalMinutesOfGame(records, { id: "g9", name: "只狼", hours: 4 }),
  240, "同一款再算一次结果不变");
eq(totalMinutesOfGame(records, { id: "g1", name: "王者荣耀", hours: 2 }), 330,
  "记录 + 老手填一起算（老数据不掉队）");
eq(sumMinutes(records), 715, "一张表的总分钟数");

/* ---------------- 统计 ---------------- */

eq(weekStartOf("2026-10-07"), "2026-10-05", "周三所在的周从周一算起");
eq(weekStartOf("2026-10-05"), "2026-10-05", "周一自己就是那周的起点");
eq(weekStartOf("2026-10-11"), "2026-10-05", "周日也算这一周");

const st = statsOf(records, "2026-10-07");
eq(st.todayMin, 175, "今日：10-07 那三条");
eq(st.weekMin, 235, "本周（10-05 起）：算上 10-05 那条 60 分钟");
eq(st.monthMin, 235, "本月：10 月的都在这一档");
eq(st.yearMin, 715, "全年：9 月那条也算进来");
eq(st.allMin, 715, "累计就是全部");
eq(st.count, 5, "记录条数");
eq(st.days, 3, "玩过几天（同一天多条只算一天）");

const none = statsOf([], "2026-10-07");
eq(none.allMin, 0, "一条记录都没有时全是 0");
eq(none.days, 0, "也没玩过哪一天");
eq(statsOf([{ id: "x", durationMin: 30 }], "2026-10-07").allMin, 30,
  "没写日期的记录只算进累计");
eq(statsOf([{ id: "x", durationMin: 30 }], "2026-10-07").todayMin, 0,
  "没写日期的不掺进「今日」");

/* ---------------- TOP 排行 ---------------- */

const top = topGames(records, games, 3);
eqDeep(top.map((g) => g.name), ["空洞骑士", "王者荣耀", "随手玩的小游戏"],
  "TOP3：按累计时长排，没绑定清单的临时记录也能上榜");
eq(top[0].minutes, 480, "第一名 480 分钟");
eq(top[1].count, 3, "第二名是 3 条记录加出来的");
eqDeep(topGames(records, games, 1).map((g) => g.name), ["空洞骑士"], "limit 说了算");
eqDeep(topGames(records, [], 3).map((g) => g.name),
  ["空洞骑士", "王者荣耀", "随手玩的小游戏"],
  "清单被清空时，临时记录照旧能排出来");
eq(topGames(records, games, 3).length <= 3, true, "最多就三条");
eqDeep(topGames([], games, 3), [], "没有记录就没有排行（老手填的单独算）");
eq(topGames([], [{ id: "g1", name: "老游戏", hours: 42 }], 3)[0].name, "老游戏",
  "只有老数据手填时，也排得出来");
eq(topGames([], [{ id: "g1", name: "老游戏", hours: 42 }], 3)[0].count, 0,
  "这条没有游玩记录，界面上会写「原有手填」");

/* ---------------- 每月目标（超了才提醒） ---------------- */

const withTargets = [
  { id: "g1", name: "王者荣耀", targetHours: 3 },   // 本月 210 分钟 > 180
  { id: "g2", name: "空洞骑士", targetHours: 1 },   // 本月的记录 0 分钟，没超
  { id: "g3", name: "只狼", targetHours: 10 },      // 一条记录都没有，谈不上超
  { id: "g4", name: "没设目标的游戏" },              // 没设目标就不看
];
const over = overTargetGames(records, withTargets, "2026-10");
eqDeep(over.map((g) => g.name), ["王者荣耀"], "只有超了目标的才提醒");
eq(over[0].overMinutes, 30, "超出的分钟数算得出来");
eq(over[0].targetMinutes, 180, "目标是 3 小时就换算成 180 分钟");
eq(over[0].minutes, 210, "本月已玩的分钟数");
eqDeep(overTargetGames(records, withTargets, ""), [], "月份空着就不算，不瞎提醒");
eqDeep(overTargetGames(records, withTargets, "2026-09").map((g) => g.name), ["空洞骑士"],
  "换个月份，超目标的是另一款（9 月只有空洞骑士那一条 480 分钟）");
eqDeep(overTargetGames(records, [{ id: "g1", name: "王者荣耀", targetHours: 10 }], "2026-10"),
  [], "目标比实际高就不提醒");
const two = [
  { id: "g1", name: "低目标", targetHours: 1 },
  { id: "g1", name: "高目标", targetHours: 2 },
];
eq(overTargetGames(records, two, "2026-10").length, 2, "两款都超了就都提醒");
eq(overTargetGames(records, two, "2026-10")[0].name, "低目标", "超得越多排越前");

/* ---------------- 筛选 ---------------- */

eq(hasFilter({}) || hasFilter({ name: "  " }), false, "都空着就不算在筛");
eq(hasFilter({ from: "2026-10-01" }), true, "填了起始日期就是在筛");
eqDeep(filterRecords(records, { name: "王者" }).map((r) => r.id), ["p2", "p3", "p1"],
  "按游戏名模糊筛（大小写 / 半个名字都行）");
eqDeep(filterRecords(records, { from: "2026-10-06", to: "2026-10-07" }).map((r) => r.id),
  ["p2", "p3", "p4"], "按日期范围筛，新的在前");
eqDeep(filterRecords(records, { name: "王者", from: "2026-10-07" }).map((r) => r.id),
  ["p2", "p3"], "两个条件一起用是「都要满足」");
eqDeep(filterRecords(records, {}).map((r) => r.id), ["p2", "p3", "p4", "p1", "p5"],
  "不筛的时候按日期从新到旧全给出来");
eqDeep(filterRecords(records, { name: "不存在的游戏" }), [], "筛不到就是空数组");

eq(recordTitle({ gameName: "王者荣耀", durationMin: 120 }), "王者荣耀 · 2 小时",
  "列表行上那句「游戏名 · 时长」");
eq(recordTitle({ gameName: "", durationMin: 0 }), LOOSE_NAME + " · —",
  "没写名字、没填时长也给得出话");

/* ---------------- 快速计时 ---------------- */

eq(elapsedMinutes(1000000, 1000000 + 30 * 60000), 30, "计时 30 分钟就是 30 分钟");
eq(elapsedMinutes(1000000, 1000000 + 20000), 1, "不到一分钟也按 1 分钟算（别记成 0）");
eq(elapsedMinutes(0, Date.now()), 0, "没在计时就是 0");
eq(clockText(1000000, 1000000 + (3600 + 754) * 1000), "01:12:34", "计时器上的 时:分:秒");
eq(clockText(0, 0), "00:00:00", "没在计时就显示 00:00:00");

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
