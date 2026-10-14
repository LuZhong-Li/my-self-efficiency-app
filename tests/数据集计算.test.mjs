/* 数据集（多套数据文件）的纯逻辑测试：只测 app/web/dataset-calc.js
 * （不碰 DOM、不碰数据、不起服务）。
 * 跑法：node tests\数据集计算.test.mjs   （本机 Node v24，不需要 package.json）
 * 说明：和别的 .test.mjs 一样，不进「自检.cmd」——自检是给用户一键跑的，保持纯 Python。
 *      名字规则那张表服务端也有一份（app\服务.py 的 check_dataset_name），
 *      两份必须一模一样 —— tests\自检.py 里有一条盯着它们对齐。 */

import {
  DATASET_NAME_MAX, DATASET_BAD_CHARS, DATASET_RESERVED,
  checkDatasetName, sortDatasets, datasetMetaText,
} from "../app/web/dataset-calc.js";

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

console.log("\n【名字：能过的】");
eq(checkDatasetName("工作"), "", "普通中文名字能过");
eq(checkDatasetName("work-2026"), "", "字母数字和横杠能过");
eq(checkDatasetName("私人 2"), "", "中间有空格能过");
eq(checkDatasetName("  工作  "), "", "首尾空格自动去掉（不算错）");
eq(checkDatasetName("x".repeat(DATASET_NAME_MAX)), "", "刚好 24 个字能过");
eq(checkDatasetName("工作", ["默认"]), "", "没有重名就能过");

console.log("\n【名字：拦下的】");
ok(checkDatasetName("").includes("起个名字"), "空名字给一句人话");
ok(checkDatasetName("   ").includes("起个名字"), "光空格也算空");
ok(checkDatasetName(null).includes("起个名字"), "传 null 不炸，也算空");
ok(checkDatasetName("x".repeat(DATASET_NAME_MAX + 1)).includes("最多"), "太长的名字拦下");
for (const ch of ["\\", "/", ":", "*", "?", "\"", "<", ">", "|"]) {
  ok(checkDatasetName("a" + ch + "b").includes("不能有"), "含「" + ch + "」的名字拦下");
}
ok(checkDatasetName("../跑出去").includes("不能有"), "想跑到根目录外面的拦下");
ok(checkDatasetName(".").includes("点开头"), "一个点拦下");
ok(checkDatasetName("..").includes("点开头"), "两个点拦下");
ok(checkDatasetName(".隐藏").includes("点开头"), "点开头拦下");
ok(checkDatasetName("结尾是点.").includes("点结尾"), "点结尾拦下");
ok(checkDatasetName("con").includes("保留"), "Windows 保留名拦下");
ok(checkDatasetName("COM1").includes("保留"), "保留名不看大小写");
ok(checkDatasetName("lpt9").includes("保留"), "LPT9 也在保留名单里");
ok(checkDatasetName("工作", ["默认", "工作"]).includes("已经有一份"), "重名拦下");
ok(checkDatasetName("工作", null).includes("") === true, "传 null 当没有重名（不炸）");
eq(DATASET_BAD_CHARS, '\\/:*?"<>|', "禁用字符那一串就是这些");
eq(DATASET_RESERVED.includes("nul"), true, "保留名单里有 nul");

console.log("\n【列表顺序】");
const items = [{ name: "工作" }, { name: "默认" }, { name: "阿黄" }, null, {}];
eq(sortDatasets(items, "默认").length, 3, "坏条目（null / 没名字）丢掉");
eq(sortDatasets(items, "默认")[0].name, "默认", "当前那份排第一");
eq(sortDatasets(items, "默认").map((i) => i.name).includes("阿黄"), true, "其余的都在");
eq(sortDatasets(null, "").length, 0, "传 null 给空数组");
eq(sortDatasets([], "工作").length, 0, "空列表给空数组");
const origin = [{ name: "工作" }, { name: "默认" }];
sortDatasets(origin, "工作");
eq(origin[0].name, "工作", "排序不改传进来的那个数组（返回的是新数组）");

console.log("\n【一行摘要】");
eq(datasetMetaText({ count: 0, updatedAt: "" }), "空", "空数据集写「空」");
eq(datasetMetaText({ count: 128, updatedAt: "2026-10-14 15:30:00" }), "128 条 · 10-14 15:30",
  "有数据就写条数和时间（时间只留月日时分）");
eq(datasetMetaText({ count: 3, updatedAt: "" }), "3 条", "没时间戳就只写条数");
eq(datasetMetaText({ bad: true, count: 0 }), "读不出来", "读不出来就如实说");
eq(datasetMetaText(null), "读不出来", "传 null 不炸");
eq(datasetMetaText({ count: 3, updatedAt: "看不懂的时间" }), "3 条 · 看不懂的时间",
  "时间认不出来就原样显示，别吞掉");

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
