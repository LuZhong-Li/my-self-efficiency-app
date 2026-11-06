/* 自定义适配的纯逻辑测试：只测 pack-calc.js 里不碰 DOM、不发网络的那部分。
 * 跑法：node tests\适配包.test.mjs   （本机 Node v24，不需要 package.json）
 *
 * 重点是「坏包不许装上」：清单怎么歪都不该让一个坏名字进到标题栏里。 */

import {
  PACK_SCHEMA, NAME_MAX, SLOGAN_MAX, DEFAULT_PACK,
  cleanText, clip, normalizeManifest, resolvePack, packRows, iconUrl,
  parseGitHubInput,
} from "../app/web/pack-calc.js";

let pass = 0;
let fail = 0;

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) { pass++; console.log("  ok   " + label); }
  else {
    fail++;
    console.log("  FAIL " + label + "：期望 " + b + "，实际 " + a);
  }
}

function ok(value, label) {
  if (value) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label); }
}

/* ---------------- 常量 ---------------- */

console.log("pack-calc.js：常量");
eq(PACK_SCHEMA, 1, "清单版本是 1");
eq(DEFAULT_PACK.appName, "小李", "没装包时叫「小李」");
eq(DEFAULT_PACK.id, "", "默认包没有 id");

/* ---------------- 清洗 ---------------- */

console.log("pack-calc.js：洗字符串");
eq(cleanText("  你好  "), "你好", "去掉首尾空白");
eq(cleanText("你\n好"), "你好", "换行被清掉（标题栏里塞换行很难看）");
eq(cleanText("你\u0000好"), "你好", "控制字符被清掉");
eq(cleanText(123), "", "不是字符串就当空串");
eq(cleanText(null), "", "null 当空串");
eq(cleanText(undefined), "", "undefined 当空串");

console.log("pack-calc.js：按码点截断");
eq(clip("abcdef", 3), "abc", "普通字符截断");
eq(clip("😀😀😀", 2), "😀😀", "emoji 不被劈成半个");
eq(Array.from(clip("😀😀😀", 2)).length, 2, "截完正好两个完整码点");
eq(clip("abc", 10), "abc", "本来就够短就不动");

/* ---------------- 清单校验：好包 ---------------- */

console.log("pack-calc.js：一个正常的包能认");
{
  const r = normalizeManifest({ id: "my-pack", appName: "我的工作台", slogan: "今天也要好好过" });
  ok(r.ok, "认得出");
  eq(r.pack.id, "my-pack", "id 原样留着");
  eq(r.pack.appName, "我的工作台", "应用名原样留着");
  eq(r.pack.slogan, "今天也要好好过", "标语原样留着");
  eq(r.errors.length, 0, "没有错误");
}

console.log("pack-calc.js：可选字段");
{
  const r = normalizeManifest({ id: "p1", appName: "甲" });
  ok(r.ok, "只写 id 和 appName 也能装");
  eq(r.pack.icon, "", "没写 icon 就是空串（用默认图标）");
  eq(r.pack.version, "", "没写版本就是空串");
  eq(r.pack.author, "", "没写作者就是空串");
}
{
  const r = normalizeManifest({ schema: 1, id: "p1", appName: "甲", icon: "icon.png", version: "1.2.0", author: "老王" });
  ok(r.ok, "schema 写 1 也行");
  eq(r.pack.icon, "icon.png", "图标名留着");
  eq(r.pack.version, "1.2.0", "版本留着");
  eq(r.pack.author, "老王", "作者留着");
}

/* ---------------- 清单校验：坏包一律不装 ---------------- */

console.log("pack-calc.js：坏包不许装上");
{
  const r = normalizeManifest(null);
  ok(!r.ok, "null 不认");
  eq(r.pack, null, "不认就不给包");
}
{
  const r = normalizeManifest([]);
  ok(!r.ok, "数组不认");
}
{
  const r = normalizeManifest("{}");
  ok(!r.ok, "字符串不认");
}
{
  const r = normalizeManifest({ appName: "甲" });
  ok(!r.ok, "缺 id 不认");
  ok(r.errors.some((e) => e.includes("id")), "错误里说清楚缺 id");
}
{
  const r = normalizeManifest({ id: "../etc", appName: "甲" });
  ok(!r.ok, "id 带 ../ 不认（不能拿它当目录名）");
}
{
  const r = normalizeManifest({ id: "a b", appName: "甲" });
  ok(!r.ok, "id 带空格不认");
}
{
  const r = normalizeManifest({ id: "x".repeat(41), appName: "甲" });
  ok(!r.ok, "id 太长不认");
}
{
  const r = normalizeManifest({ id: "p1" });
  ok(!r.ok, "缺 appName 不认");
}
{
  const r = normalizeManifest({ id: "p1", appName: "甲", icon: "../../evil.png" });
  ok(!r.ok, "图标带路径不认");
}
{
  const r = normalizeManifest({ id: "p1", appName: "甲", icon: "a.txt" });
  ok(!r.ok, "图标扩展名不认识不认");
}
{
  const r = normalizeManifest({ schema: 2, id: "p1", appName: "甲" });
  ok(!r.ok, "未来版本的格式不认（宁可明说，也别装出个四不像）");
  ok(r.errors.some((e) => e.includes("更新版本")), "错误里说明是版本问题");
}
{
  const r = normalizeManifest({ schema: 0, id: "p1", appName: "甲" });
  ok(!r.ok, "schema 是 0 也不认");
}

/* ---------------- 太长：装得上，但要提醒 ---------------- */

console.log("pack-calc.js：太长就截断并提醒");
{
  const long = "名".repeat(NAME_MAX + 5);
  const r = normalizeManifest({ id: "p1", appName: long });
  ok(r.ok, "太长的名字还是能装");
  eq(Array.from(r.pack.appName).length, NAME_MAX, "截到上限");
  ok(r.warnings.some((w) => w.includes("appName")), "提醒说名字太长了");
}
{
  const r = normalizeManifest({ id: "p1", appName: "甲", slogan: "标".repeat(SLOGAN_MAX + 3) });
  ok(r.ok, "太长的标语还是能装");
  eq(Array.from(r.pack.slogan).length, SLOGAN_MAX, "标语截到上限");
  ok(r.warnings.some((w) => w.includes("slogan")), "提醒说标语太长了");
}

/* ---------------- 决定用哪个 ---------------- */

console.log("pack-calc.js：决定界面上该用哪个");
eq(resolvePack("", {}), DEFAULT_PACK, "没设就是默认");
eq(resolvePack("nope", { "my-pack": { id: "my-pack", appName: "甲" } }), DEFAULT_PACK,
  "设了一个没装的包 → 退回默认（不崩）");
eq(resolvePack(null, null), DEFAULT_PACK, "null 也是最默认");
{
  const packs = { "my-pack": { id: "my-pack", appName: "我的工作台", slogan: "自定义", icon: "i.png" } };
  const r = resolvePack("my-pack", packs);
  eq(r.id, "my-pack", "装了就用它");
  eq(r.appName, "我的工作台", "名字用包里的");
  eq(r.slogan, "自定义", "标语用包里的");
  eq(r.icon, "i.png", "图标用包里的");
}
{
  const packs = { bad: { id: "bad", appName: "" } };
  eq(resolvePack("bad", packs), DEFAULT_PACK, "设的是个坏包 → 默认");
}
{
  const packs = { "no-slogan": { id: "no-slogan", appName: "甲" } };
  const r = resolvePack("no-slogan", packs);
  eq(r.appName, "甲", "名字用包里的");
  eq(r.slogan, "", "包里没写标语就空着（不是硬塞默认那句）");
}

/* ---------------- 列表 ---------------- */

console.log("pack-calc.js：设置页那张列表");
{
  const rows = packRows([
    { id: "b", appName: "乙", version: "1.0" },
    { id: "a", appName: "甲" },
  ]);
  eq(rows.length, 2, "两个包装出两行");
  eq(rows.map((r) => r.id), ["a", "b"], "按名字排（甲在乙前，不按 id 排）");
  eq(rows[0].broken, false, "好包不标 broken");
}
{
  const rows = packRows([{ id: "ok", appName: "好" }, { id: "bad", appName: "" }]);
  eq(rows.length, 2, "坏包也要列出来（用户才知道能删它）");
  eq(rows[1].broken, true, "坏包排后面且标 broken");
  ok(rows[1].reason.length > 0, "坏包给出原因");
}
{
  const rows = packRows([{ dirName: "only-dir" }]);
  eq(rows.length, 1, "连 id 都没有但有目录名 → 用目录名当 id，能删");
  eq(rows[0].id, "only-dir", "id 退回目录名");
}
eq(packRows(null), [], "null 列表 → 空数组");
eq(packRows("乱写的"), [], "非数组 → 空数组");

/* ---------------- 图标网址 ---------------- */

console.log("pack-calc.js：图标网址");
eq(iconUrl(null), "", "没包就没图标");
eq(iconUrl({ id: "", icon: "a.png" }), "", "没 id 就没图标");
eq(iconUrl({ id: "p1", icon: "" }), "", "没写图标就没图标");
eq(iconUrl({ id: "p1", icon: "a.png" }), "pack-icon/p1/a.png", "正常拼出来");
eq(iconUrl({ id: "有中文", icon: "a b.png" }), "pack-icon/%E6%9C%89%E4%B8%AD%E6%96%87/a%20b.png",
  "中文和空格都编码掉");

/* ---------------- 从 GitHub 拉 ---------------- */

console.log("pack-calc.js：解析 GitHub 输入");
{
  const r = parseGitHubInput("LuZhong-Li/my-pack");
  ok(r.ok, "用户名/仓库名");
  eq([r.owner, r.repo, r.ref], ["LuZhong-Li", "my-pack", ""], "三段都对");
}
{
  const r = parseGitHubInput("LuZhong-Li/my-pack@v1.2.0");
  ok(r.ok, "带 @标签");
  eq(r.ref, "v1.2.0", "标签解析出来");
}
{
  const r = parseGitHubInput("https://github.com/LuZhong-Li/my-pack");
  ok(r.ok, "完整网址");
  eq([r.owner, r.repo], ["LuZhong-Li", "my-pack"], "网址里的两段");
}
{
  const r = parseGitHubInput("https://github.com/LuZhong-Li/my-pack/tree/dev");
  ok(r.ok, "带 /tree/分支 的网址");
  eq(r.ref, "dev", "分支解析出来");
}
{
  const r = parseGitHubInput("https://github.com/LuZhong-Li/my-pack.git");
  ok(r.ok, "带 .git 后缀");
  eq(r.repo, "my-pack", "后缀被去掉");
}
eq(parseGitHubInput("").ok, false, "空的不认");
eq(parseGitHubInput("   ").ok, false, "全是空格不认");
eq(parseGitHubInput("只有一段").ok, false, "只有一段不认");
eq(parseGitHubInput("a/b/c").ok, false, "三段不认");
eq(parseGitHubInput("https://gitee.com/a/b").ok, false, "不是 github 的网址不认");
{
  const r = parseGitHubInput("a b/c");
  ok(!r.ok, "用户名带空格不认");
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
