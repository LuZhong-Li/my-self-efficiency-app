/* 各模块弹窗字段表（app/web/item-form.js）的单元测试。
 * 跑法：node tests\表单计算.test.mjs   （本机 Node v24，不需要 package.json）
 * 说明：和别的 .test.mjs 一样，不进「自检.cmd」——自检是给用户一键跑的，保持纯 Python。 */

import {
  FORMS, ITEM_TYPES, formOf, optionsOf, formHtml,
  defaultsOf, valuesOf, readValues, validate, applyValues, newRow, trashPlan, imagesOf,
  TASK_CATEGORIES, PRIORITIES, STUDY_KINDS, GAME_STATUSES, GAME_PLATFORMS,
} from "../app/web/item-form.js";
import { ATTACH_MODULES } from "../app/web/attachment-calc.js";

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

/* ---------------- 注册表本身 ---------------- */

eqDeep(ITEM_TYPES, ["todayPlan", "devTodo", "studyRecord", "studyItem", "fitness", "game"],
  "六个模块的弹窗类型都在，按顺序");
eq(formOf("game").table, "games", "游戏存 games 表");
eq(formOf("studyRecord").table, "studies", "学习记录存 studies 表");
eq(formOf("studyItem").table, "subjects", "学习对象存 subjects 表");
eq(formOf("fitness").table, "workoutLogs", "训练打卡存 workoutLogs 表");
eq(formOf("todayPlan").table, "tasks", "今日计划存 tasks 表");
eq(formOf("devTodo").table, "tasks", "开发待办也存 tasks 表（靠 belong 区分）");

for (const type of ITEM_TYPES) {
  const spec = FORMS[type];
  ok(ATTACH_MODULES.includes(spec.upload), `${type} 的图片目录 ${spec.upload} 在白名单里`);
  ok(Boolean(spec.titleNew) && Boolean(spec.titleEdit), `${type} 新增/编辑两个标题都有`);
  ok(typeof spec.label === "function", `${type} 有算显示名字的函数`);
  ok(typeof spec.create === "function", `${type} 有捏空壳的函数`);
  ok(spec.fields.length >= 3, `${type} 至少三个字段`);
}

// 图片目录不能撞车：每个模块各存各的
const uploads = ITEM_TYPES.map((t) => FORMS[t].upload);
eq(new Set(uploads).size, uploads.length, "六个模块的图片目录互不重复");

const ID_REQUIRED = { todayPlan: "text", devTodo: "text", studyRecord: "date",
  studyItem: "name", fitness: "date", game: "name" };
for (const [type, name] of Object.entries(ID_REQUIRED)) {
  const f = FORMS[type].fields.find((x) => x.name === name);
  ok(f && f.required, `${type} 的「${name}」是必填`);
}

/* ---------------- 下拉选项 ---------------- */

eqDeep(optionsOf({ list: ["甲", "乙"] }), [{ value: "甲", label: "甲" }, { value: "乙", label: "乙" }],
  "固定选项包成 value/label");
eqDeep(optionsOf({ list: ["甲"], blank: "不填" }),
  [{ value: "", label: "不填" }, { value: "甲", label: "甲" }], "blank 会插到最前面");
eqDeep(optionsOf({ source: "subjects" }, { subjects: [["s1", "高等数学"], ["s2", "英语精读"]] }),
  [{ value: "s1", label: "高等数学" }, { value: "s2", label: "英语精读" }], "动态选项认 [id, 名称]");
eqDeep(optionsOf({ source: "subjects" }, { subjects: [] }),
  [{ value: "", label: "（还没有可选的对象）" }], "一个学习对象都没有时给一条占位");

/* ---------------- 画表单 ---------------- */

const html = formHtml("game", { name: "旷野之息", platform: "Switch", status: "在玩", hours: 42, progress: "" });
ok(html.includes('id="item-name"'), "画出了游戏名字段");
ok(html.includes('value="旷野之息"'), "值填进去了");
ok(html.includes('id="item-status"'), "画出了状态下拉");
ok(html.includes('<option value="在玩" selected>在玩</option>'), "下拉里的当前值被选中");
ok(html.includes('type="number"'), "时长画成数字框");
ok(html.includes("<textarea"), "进度备注画成多行");
ok(html.indexOf('class="dlg-two"') >= 0, "平台 + 状态并排一行");

const escaped = formHtml("game", { name: '<script>alert("x")</script>' });
ok(!escaped.includes("<script>"), "游戏名里的尖括号被转义，不会当标签渲染");
ok(escaped.includes("&lt;script&gt;"), "转义成实体");

const subjHtml = formHtml("studyRecord", { subjectId: "s2" }, { subjects: [["s1", "数学"], ["s2", "英语"]] });
ok(subjHtml.includes('<option value="s2" selected>英语</option>'), "学习对象下拉接到运行时给的数据");

const emptyHtml = formHtml("fitness", {});
ok(emptyHtml.includes('id="item-moves"') && emptyHtml.includes('id="item-date"'), "空值也画得出来");

/* ---------------- 初始值 ---------------- */

eqDeep(defaultsOf("game"), { name: "", platform: "PC", status: "想玩", hours: "", progress: "" },
  "新增游戏时的默认值");
eq(defaultsOf("studyItem").kind, "书", "新增学习对象默认类型是书");
eq(defaultsOf("devTodo").priority, "", "新增待办默认不标优先级");

eqDeep(valuesOf("game", { name: "只狼", status: "已通关" }),
  { name: "只狼", platform: "PC", status: "已通关", hours: "", progress: "" },
  "编辑时：记录里有的用记录的，没有的用默认值");
eq(valuesOf("game", { hours: 0 }).hours, "", "时长 0 当成没填，框里留空");
eq(valuesOf("game", { hours: 42 }).hours, "42", "时长有值就带出来");
eq(valuesOf("fitness", null, { date: "2026-10-01" }).date, "2026-10-01", "extra 能盖掉默认值（比如从某一天点进来）");

/* ---------------- 读表单 ---------------- */

const bag = { text: "  写方案  ", minutes: "", category: "生活" };
eqDeep(readValues("todayPlan", (name) => bag[name]),
  { text: "  写方案  ", time: "", category: "生活", note: "" },
  "读表单：没填的字段回空串，不去动两头的空格（校验和写回各管各的）");

/* ---------------- 校验 ---------------- */

eq(validate("todayPlan", { text: "  " }).ok, false, "任务只填了空格不算填");
eq(validate("todayPlan", { text: "  " }).error, "「任务」不能是空的", "报错说清是哪个字段");
eq(validate("todayPlan", { text: "写方案" }).ok, true, "填了就算过");
eq(validate("fitness", { date: "2026-10-07", moves: "   " }).ok, false, "训练内容不能是空的");
eq(validate("fitness", { date: "2026-10-07", moves: "深蹲" }).ok, true, "训练内容填了就行");
eq(validate("studyRecord", { date: "2026-10-07", content: "", takeaway: "" }).error,
  "至少写一句学了什么", "学习记录：内容和心得都空要拦下来");
eq(validate("studyRecord", { date: "2026-10-07", content: "", takeaway: "没听懂" }).ok, true,
  "只写了心得也算填了");
eq(validate("studyRecord", { date: "", content: "第 3 章" }).error, "「日期」不能是空的",
  "必填的日期也得管");
eq(validate("game", { name: "只狼" }).ok, true, "游戏名填了就行（其它都可选）");

/* ---------------- 写回 ---------------- */

const row = { id: "g1", name: "旧的", hours: 3, progress: "旧的", extraField: "别动我" };
applyValues("game", row, { name: "  新名字  ", platform: "PC", status: "在玩", hours: "42", progress: " 打到第三章 " });
eq(row.name, "新名字", "写回时去掉两头空白");
eq(row.hours, 42, "时长写成数字");
eq(row.progress, "打到第三章", "进度备注也 trim 了");
eq(row.extraField, "别动我", "记录上别的字段一个都没动");

const r2 = {};
applyValues("game", r2, { hours: "" });
eq(r2.hours, 0, "时长留空按 0 算");
const r3 = {};
applyValues("game", r3, { hours: "abc" });
eq(r3.hours, 0, "时长填了非数字也按 0 算，不会写进去一个 NaN");

/* ---------------- 新增一条 ---------------- */

const ctx = { uid: () => "id-1", nowIso: () => "2026-10-07T10:00:00.000Z", date: "2026-10-07", pid: "demo-p1" };
const todo = newRow("devTodo", { text: "把月历氛围底调淡", priority: "高", note: "" }, ctx);
eqDeep(todo, {
  id: "id-1", date: "", time: "", category: "工作", done: false, note: "",
  priority: "高", belong: "dev:demo-p1", createdAt: "2026-10-07T10:00:00.000Z",
  text: "把月历氛围底调淡", imagePaths: [],
}, "新增一条开发待办：空壳 + 表单值 + imagePaths: []");

const plan = newRow("todayPlan", { text: "写方案", time: "09:00", category: "工作", note: "" }, ctx);
eq(plan.belong, "plan", "今日计划的任务 belong 是 plan");
eq(plan.date, "2026-10-07", "今日计划默认记到今天");
eq(plan.done, false, "新增的任务默认没完成");
eqDeep(plan.imagePaths, [], "新记录带空图片数组");

const study = newRow("studyRecord", { date: "2026-10-06", subjectId: "s1", minutes: "45", content: "第 3 章", takeaway: "" }, ctx);
eq(study.reviewed, false, "新学习记录默认待复习");
eq(study.minutes, 45, "时长是数字");
eq(study.imagePaths.length, 0, "学习记录也带图片数组");

const subj = newRow("studyItem", { name: "人类简史", kind: "书", source: "中信", note: "" }, ctx);
eq(subj.id, "id-1", "学习对象也走 uid");
eq(subj.kind, "书", "类型写进去了");

const fit = newRow("fitness", { date: "", moves: "跑步 5 km", note: "" }, { ...ctx, date: "" });
eq(fit.date, "", "日期留空就是空字符串（表单那边会拦必填）");

/* ---------------- 删除计划 ---------------- */

const one = trashPlan("game", { id: "g1", name: "只狼" });
eq(one.label, "只狼", "删除时拿游戏名当提示文字");
eq(one.items.length, 1, "删游戏只动 games 一张表");

const two = trashPlan("studyItem", { id: "s1", name: "高等数学" }, {
  studies: [
    { id: "st1", subjectId: "s1", content: "第 1 章" },
    { id: "st2", subjectId: "s2", content: "别人的" },
  ],
});
eq(two.label, "高等数学", "删学习对象用名字当提示");
eq(two.items.length, 2, "删学习对象会连它的学习记录一起进回收站");
eq(two.items[1].table, "studies", "第二条动的是 studies 表");
eq(two.items[1].row.id, "st1", "只带走属于它的那条");
eq(two.extra, 1, "额外带走的条数是 1（给提示文案用）");
eq(trashPlan("fitness", { id: "l1", moves: "深蹲 3×12" }).label, "深蹲 3×12", "训练打卡用练了什么当提示");
eq(trashPlan("studyRecord", { id: "st9", content: "", takeaway: "没懂" }).label, "没懂",
  "学习记录没写内容时用心得当提示");
eq(trashPlan("todayPlan", { id: "t1", text: "写方案" }).label, "写方案", "任务用内容当提示");

/* ---------------- 图片标记 ---------------- */

eqDeep(imagesOf({ imagePaths: ["attachments/game/a.png"] }), ["attachments/game/a.png"], "有图就带出来");
eqDeep(imagesOf({}), [], "没图就是空数组");

/* ---------------- 词表 ---------------- */

eqDeep(TASK_CATEGORIES, ["工作", "生活", "运动", "其他"], "任务分类四个");
eqDeep(PRIORITIES, ["高", "中", "低"], "优先级三档");
eqDeep(STUDY_KINDS, ["书", "课程", "视频", "技能", "其它"], "学习对象类型五个");
eqDeep(GAME_STATUSES, ["在玩", "想玩", "已通关", "弃坑"], "游戏状态四个");
eqDeep(GAME_PLATFORMS, ["PC", "Switch", "PS5", "手机", "其它"], "平台五个");

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
