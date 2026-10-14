/* 素材库（全站版）的纯逻辑测试：只测 app/web/asset-calc.js。
 * 跑法：node tests\素材计算.test.mjs   （本机 Node v24，不需要 package.json）
 * 说明：和别的 .test.mjs 一样，不进「自检.cmd」——自检是给用户一键跑的，保持纯 Python。 */

import {
  ASSET_KINDS, ASSET_TABLES, normalizeAsset, assetsOf, assetUsage, assetsOfRow, unlinkAsset,
} from "../app/web/asset-calc.js";
import { assetsOf as assetsOfFromMedia } from "../app/web/media-calc.js";

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

console.log("\n【三种类型与形状】");
eqDeep(ASSET_KINDS, ["image", "link", "text"], "素材就三种：图片 / 链接 / 文本片段");
eqDeep(normalizeAsset({ id: "a1", title: "封面", kind: "image",
  path: "attachments/media_asset/x.png", tags: ["封面"] }),
{ id: "a1", title: "封面", kind: "image", path: "attachments/media_asset/x.png",
  url: "", text: "", note: "", tags: ["封面"], createdAt: "" }, "图片素材补齐形状");
eq(normalizeAsset({ kind: "text", text: "一段常用的话" }).text, "一段常用的话",
  "文本片段那一格留着");
eq(normalizeAsset({ kind: "没见过的类型" }).kind, "link",
  "认不出的类型又没图没正文时当链接");
eq(normalizeAsset({ kind: "别的", path: "attachments/media_asset/a.png" }).kind, "image",
  "认不出的类型但有图路径时当图片（老数据就是这个形状）");
eq(normalizeAsset({ title: "  " }).title, "", "标题两头空白掐掉");
eqDeep(normalizeAsset(null), normalizeAsset({}), "传 null 不炸");

console.log("\n【读素材：顶层 assets 为准，老的 mediaAssets 也认】");
eqDeep(assetsOf({ assets: [{ id: "a1", title: "新的" }] }).map((a) => a.title), ["新的"],
  "优先读顶层 assets");
eqDeep(assetsOf({ mediaAssets: [{ id: "a0", title: "老的" }] }).map((a) => a.title), ["老的"],
  "只有老表时也读得出来（搬家还没落盘那一刻）");
eqDeep(assetsOf({ assets: [{ id: "a1", title: "新的" }],
  mediaAssets: [{ id: "a0", title: "老的" }] }).map((a) => a.id), ["a1", "a0"],
  "两个都有时：新的在前、老的在后，一个都不丢");
eqDeep(assetsOf({ assets: [{ id: "a1", title: "新的" }],
  mediaAssets: [{ id: "a1", title: "老的重复的" }] }).map((a) => a.title), ["新的"],
  "同一个 id 只留顶层那份（搬完家不重复）");
eqDeep(assetsOf({ assets: [{ id: "a9", kind: "image" }] }).map((a) => a.id), [],
  "三样全空的残渣丢掉（和原来一个口径）");
eqDeep(assetsOf(null), [], "传 null 给空数组");
eq(assetsOfFromMedia, assetsOf, "media-calc.js 那边转出的是同一个函数");

console.log("\n【被几处引用：跨表数】");
const USED = {
  assets: [{ id: "a1", title: "封面" }, { id: "a2", title: "没人用" }],
  contents: [{ id: "c1", assetIds: ["a1", "a1"] }],
  tasks: [{ id: "t1", assetIds: ["a1"] }],
  notes: [{ id: "n1", assetIds: ["不存在的 id"] }],
  studies: [{ id: "s1" }],
};
const usage = assetUsage(USED);
eq(usage.a1.total, 2, "a1 被两处引用（作品 + 待办，作品那条写两遍也只算一处）");
eq(usage.a1.byTable.contents, 1, "分开数：作品 1 条");
eq(usage.a1.byTable.tasks, 1, "分开数：待办 1 条");
eq(usage.a2.total, 0, "没人用的素材是 0 处");
eqDeep(assetUsage(null), {}, "传 null 给空对象");
eq(assetUsage(USED).a1.byTable.notes, undefined, "认不出的 id 不进 byTable");

console.log("\n【一条记录引用了哪几份】");
const ROW = { id: "t1", assetIds: ["a1", "a9"] };
eqDeep(assetsOfRow(ROW, assetsOf(USED)).map((a) => a.id), ["a1"],
  "按 id 查得到就给出素材（查不到的跳过，不编空壳）");
eq(assetsOfRow(ROW, assetsOf(USED))[0].title, "封面", "给出的那份带着原来那些字段");
eqDeep(assetsOfRow({ id: "t2" }, assetsOf(USED)), [], "老记录没 assetIds 给空数组");
eqDeep(assetsOfRow(null, []), [], "传 null 不炸");

console.log("\n【删素材：从各处摘掉引用】");
const TO_UNLINK = {
  assets: [{ id: "a1", title: "封面" }, { id: "a2", title: "留下" }],
  contents: [{ id: "c1", assetIds: ["a1", "a2"] }],
  tasks: [{ id: "t1", assetIds: ["a1"] }, { id: "t2", assetIds: ["a2"] }],
  notes: [{ id: "n1", assetIds: ["a1", "a2"] }],
};
eq(unlinkAsset(TO_UNLINK, "a1"), 3, "摘掉了 3 处引用（作品 / 待办 / 笔记各一处）");
eqDeep(TO_UNLINK.contents[0].assetIds, ["a2"], "作品里只剩另一份素材的 id");
eqDeep(TO_UNLINK.tasks[0].assetIds, [], "待办里那个 id 没了");
eqDeep(TO_UNLINK.tasks[1].assetIds, ["a2"], "没引用它的记录一个字节都不动");
eqDeep(TO_UNLINK.notes[0].assetIds, ["a2"], "笔记里也摘干净了");
eq(unlinkAsset(TO_UNLINK, "a9"), 0, "摘一个没人用的 id：动 0 处");
eq(unlinkAsset(TO_UNLINK, ""), 0, "空 id 不动任何东西");

console.log("\n【表清单】");
ok(ASSET_TABLES.length >= 8, "能挂素材的表至少 8 张");
ok(ASSET_TABLES.some(([t]) => t === "finance.transactions"), "记账账目那条用带点的表名");
ok(ASSET_TABLES.every(([t, label]) => t && label), "每张表都有表名和页面上的叫法");

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
