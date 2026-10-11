/* 标签的纯逻辑测试：只测 app/web/tag-calc.js（不碰 DOM、不碰数据）。
 * 跑法：node tests\标签计算.test.mjs   （本机 Node v24，不需要 package.json）
 * 说明：和别的 .test.mjs 一样，不进「自检.cmd」——自检是给用户一键跑的，保持纯 Python。 */

import {
  TAG_MAX_CHARS, TAG_LIMIT, TAG_PALETTE,
  parseTagInput, normalizeTags, tagsOfRow, tagsText, visibleTags, tagInputError, tagColor,
} from "../app/web/tag-calc.js";

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

/* ---------------- 切分 ---------------- */

eqDeep(parseTagInput("工作, 本周、重要"), ["工作", "本周", "重要"], "中英文逗号、顿号都算分隔符");
eqDeep(parseTagInput("工作 本周\n重要"), ["工作", "本周", "重要"], "空格和换行也当分隔符");
eqDeep(parseTagInput("工作;本周；重要"), ["工作", "本周", "重要"], "分号也认");
eqDeep(parseTagInput(""), [], "空串切出来是空的");
eqDeep(parseTagInput(null), [], "没给值也不抛错");
eqDeep(parseTagInput("  ,  ,  "), [], "全是分隔符就什么都不剩");

/* ---------------- 洗净 ---------------- */

eqDeep(normalizeTags(["工作", "工作"]), ["工作"], "同一条记录里重复的只留一个");
eqDeep(normalizeTags([" 工作 ", "工作"]), ["工作"], "去重看的是去了空白之后的样子");
eqDeep(normalizeTags(["Bug", "bug", "BUG"]), ["Bug"], "去重也忽略大小写，留第一次写下的那个写法");
eqDeep(normalizeTags("工作, 本周"), ["工作", "本周"], "字符串进来也能洗干净（手改数据可能写成字符串）");
eqDeep(normalizeTags(["工作", 42, null, "", "  ", "本周"]), ["工作", "本周"], "非字符串和空的都丢掉");
eqDeep(normalizeTags(undefined), [], "没值就是空数组（老记录没这个字段）");
eqDeep(normalizeTags({ a: 1 }), [], "写成对象这种怪东西也当空");

eq(normalizeTags(["x".repeat(TAG_MAX_CHARS + 6)])[0].length, TAG_MAX_CHARS,
  "单个标签超长就截到上限（" + TAG_MAX_CHARS + " 个字）");
eq(normalizeTags(Array.from({ length: TAG_LIMIT + 4 }, (_, i) => "t" + i)).length, TAG_LIMIT,
  "一条记录最多留 " + TAG_LIMIT + " 个标签");
eqDeep(
  normalizeTags(["工作", "工作", "本周", "本周", "重要", "重要"]),
  ["工作", "本周", "重要"],
  "去重是在限量之前做的（否则重复的会把名额占掉）"
);

/* ---------------- 记录 → 标签 ---------------- */

eqDeep(tagsOfRow({ tags: ["工作", "本周"] }), ["工作", "本周"], "正常记录原样读出来");
eqDeep(tagsOfRow({}), [], "没有 tags 字段的老记录读出来是空数组");
eqDeep(tagsOfRow(null), [], "整条是空的也不抛错");
eqDeep(tagsOfRow({ tags: "工作" }), ["工作"], "tags 被手改成了字符串也认");
eqDeep(tagsOfRow({ tags: [1, "工作"] }), ["工作"], "混进了数字就跳过");

/* ---------------- 填回输入框 ---------------- */

eq(tagsText(["工作", "本周"]), "工作、本周", "数组 → 一行文本");
eq(tagsText([]), "", "空数组 → 空串");
eq(tagsText("工作,本周"), "工作、本周", "本来就是字符串也照样归一");

/* ---------------- 行上画几个 ---------------- */

eqDeep(visibleTags(["工作", "本周"], 3), { shown: ["工作", "本周"], rest: 0 }, "两个标签就画两个");
eqDeep(visibleTags(["一", "二", "三", "四", "五"], 3), { shown: ["一", "二", "三"], rest: 2 },
  "五个只画前三个，剩下两个收成 +2");
eqDeep(visibleTags(["一", "二", "三"], 3), { shown: ["一", "二", "三"], rest: 0 }, "正好三个全画");
eqDeep(visibleTags([], 3), { shown: [], rest: 0 }, "没标签就是空的");
eqDeep(visibleTags(["a", "b", "c", "d"], 0), { shown: [], rest: 4 },
  "max 给 0 就一个都不画（只想显示 +N 的场合）");
eqDeep(visibleTags(["工作", "工作", "本周"], 3), { shown: ["工作", "本周"], rest: 0 },
  "先洗净再数，重复的不占名额");

/* ---------------- 输入框里的当场校验 ---------------- */

eq(tagInputError("工作, 本周"), "", "正常的两三个标签放行");
eq(tagInputError(""), "", "空着不算错（标签是选填的）");
eq(tagInputError("一,二,三,四,五,六,七,八,九"), "最多 " + TAG_LIMIT + " 个标签",
  "超过 " + TAG_LIMIT + " 个当场提示");
eq(tagInputError("工作," + "长".repeat(TAG_MAX_CHARS + 1)), "单个标签最多 " + TAG_MAX_CHARS + " 个字",
  "单个标签太长当场提示");
eq(tagInputError("工作,工作,工作,工作,工作,工作,工作,工作,工作"), "",
  "重复的不占名额（去重之后还是 " + TAG_LIMIT + " 个以内就不算超）");

/* ---------------- 颜色 ---------------- */

eq(tagColor("工作") >= 1 && tagColor("工作") <= TAG_PALETTE, true,
  "颜色档位落在 1.." + TAG_PALETTE + " 里");
eq(tagColor("工作"), tagColor(" 工作 "), "前后空白不影响颜色");
eq(tagColor("Work"), tagColor("work"), "大小写不影响颜色（同一个词不该一天一个色）");
eq(typeof tagColor("工作"), "number", "返回的是数字（CSS 里当 data-c 用）");
const manyNames = ["工作", "生活", "本周", "重要", "报销", "健身", "学习", "杂事", "等等", "临时"];
eq(manyNames.every((n) => tagColor(n) >= 1 && tagColor(n) <= TAG_PALETTE), true,
  "随便十个名字都落在调色板里（会撞色，但不该越界）");

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
