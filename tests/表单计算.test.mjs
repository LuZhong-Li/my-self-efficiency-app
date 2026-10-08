/* 各模块弹窗字段表（app/web/item-form.js）的单元测试。
 * 跑法：node tests\表单计算.test.mjs   （本机 Node v24，不需要 package.json）
 * 说明：和别的 .test.mjs 一样，不进「自检.cmd」——自检是给用户一键跑的，保持纯 Python。 */

import {
  FORMS, ITEM_TYPES, formOf, optionsOf, formHtml,
  defaultsOf, valuesOf, readValues, validate, applyValues, newRow, trashPlan, imagesOf,
  TASK_CATEGORIES, PRIORITIES, PROJECT_STATUSES, STUDY_KINDS, GAME_STATUSES, GAME_PLATFORMS,
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

eqDeep(ITEM_TYPES,
  ["devProject", "todayPlan", "devTodo", "studyRecord", "studyItem", "fitness", "game",
    "gamePlayRecord", "moduleGoal"],
  "九个弹窗类型都在，按顺序（游玩记录与模块目标都是 2026-10-07 加的）");
eq(formOf("devProject").table, "projects", "项目存 projects 表");
eq(formOf("devProject").upload, "dev_project", "项目的图片单独一格");
eq(formOf("game").table, "games", "游戏存 games 表");
eq(formOf("studyRecord").table, "studies", "学习记录存 studies 表");
eq(formOf("studyItem").table, "subjects", "学习对象存 subjects 表");
eq(formOf("fitness").table, "workoutLogs", "训练打卡存 workoutLogs 表");
eq(formOf("todayPlan").table, "tasks", "今日计划存 tasks 表");
eq(formOf("devTodo").table, "tasks", "开发待办也存 tasks 表（靠 belong 区分）");

for (const type of ITEM_TYPES) {
  const spec = FORMS[type];
  // 模块目标没有图片区（upload 为空），别的类型都得有一个合法目录
  if (spec.upload) {
    ok(ATTACH_MODULES.includes(spec.upload), `${type} 的图片目录 ${spec.upload} 在白名单里`);
  }
  ok(Boolean(spec.titleNew) && Boolean(spec.titleEdit), `${type} 新增/编辑两个标题都有`);
  ok(typeof spec.label === "function", `${type} 有算显示名字的函数`);
  ok(typeof spec.create === "function", `${type} 有捏空壳的函数`);
  ok(spec.fields.length >= 3, `${type} 至少三个字段`);
}

// 图片目录不能撞车：每个模块各存各的
const uploads = ITEM_TYPES.map((t) => FORMS[t].upload).filter(Boolean);
eq(new Set(uploads).size, uploads.length, "六个模块的图片目录互不重复");

const ID_REQUIRED = { devProject: "name", todayPlan: "text", devTodo: "text",
  studyRecord: "date", studyItem: "name", fitness: "date", game: "name" };
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

// 游戏清单扩的两格：每月目标、通关日期（后者只在状态 = 已通关时露出来）
const gameExtra = formHtml("game", { name: "只狼", status: "已通关", targetHours: 10,
  finishDate: "2026-09-20" });
ok(gameExtra.includes('id="item-targetHours"'), "游戏有「每月目标」那一格");
ok(gameExtra.includes('value="2026-09-20"'), "通关日期回填");
ok(gameExtra.includes('data-field="finishDate"'), "通关日期那格挂着「跟着状态显隐」的钩子");
eq(formOf("game").fields.find((f) => f.name === "finishDate").showWhen.equals, "已通关",
  "通关日期只在状态 = 已通关时露出来");
eq(valuesOf("game", { name: "只狼", targetHours: 12, finishDate: "2026-09-20" }).targetHours, "12",
  "每月目标回填成字符串（表单里一律是字符串）");

const subjHtml = formHtml("studyRecord", { subjectId: "s2" }, { subjects: [["s1", "数学"], ["s2", "英语"]] });
ok(subjHtml.includes('<option value="s2" selected>英语</option>'), "学习对象下拉接到运行时给的数据");

const emptyHtml = formHtml("fitness", {});
ok(emptyHtml.includes('id="item-moves"') && emptyHtml.includes('id="item-date"'), "空值也画得出来");

const projHtml = formHtml("devProject", { name: "小李", status: "已暂停", startDate: "2026-10-03" });
ok(projHtml.includes('id="item-description"'), "项目有详细描述那一栏");
ok(projHtml.includes('id="item-expectEndDate"'), "项目有预计结束日期");
ok(projHtml.includes('<option value="已暂停" selected>已暂停</option>'), "项目状态选到「已暂停」");
ok(projHtml.includes("<textarea"), "详细描述是多行");

/* ---------------- 项目的初始值 / 校验 / 新增 ---------------- */

eqDeep(defaultsOf("devProject"),
  { name: "", status: "进行中", startDate: "", intro: "", description: "", expectEndDate: "" },
  "新增项目的默认值（状态默认进行中，其它空着）");
eq(valuesOf("devProject", { name: "木头", status: "废弃", description: "先放着" }).status, "废弃",
  "编辑时状态回填");
eq(valuesOf("devProject", { name: "木头" }).description, "", "老项目没有详细描述就是空串");
eq(validate("devProject", { name: "  " }).error, "「项目名称」不能是空的", "项目名必填");
eq(validate("devProject", { name: "小李" }).ok, true, "只填名字也能存（其它都可选）");

/* ---------------- 初始值 ---------------- */

eqDeep(defaultsOf("game"),
  { name: "", platform: "PC", status: "想玩", targetHours: "", finishDate: "", hours: "", progress: "" },
  "新增游戏时的默认值");
eq(defaultsOf("studyItem").kind, "书", "新增学习对象默认类型是书");
eq(defaultsOf("devTodo").priority, "", "新增待办默认不标优先级");

eqDeep(valuesOf("game", { name: "只狼", status: "已通关" }),
  { name: "只狼", platform: "PC", status: "已通关", targetHours: "", finishDate: "",
    hours: "", progress: "" },
  "编辑时：记录里有的用记录的，没有的用默认值");
eq(valuesOf("game", { hours: 0 }).hours, "", "时长 0 当成没填，框里留空");
eq(valuesOf("game", { hours: 42 }).hours, "42", "时长有值就带出来");
eq(valuesOf("fitness", null, { date: "2026-10-01" }).date, "2026-10-01", "extra 能盖掉默认值（比如从某一天点进来）");

/* ---------------- 读表单 ---------------- */

const bag = { text: "  写方案  ", minutes: "", category: "生活" };
eqDeep(readValues("todayPlan", (name) => bag[name]),
  { text: "  写方案  ", time: "", category: "生活", priority: "", note: "" },
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
  isTodayPlan: false,
  text: "把月历氛围底调淡", imagePaths: [],
}, "新增一条开发待办：空壳 + 表单值 + imagePaths: []");

const plan = newRow("todayPlan", { text: "写方案", time: "09:00", category: "工作", note: "" }, ctx);
eq(plan.belong, "plan", "今日计划的任务 belong 是 plan");
eq(plan.date, "2026-10-07", "今日计划默认记到今天");
eq(plan.done, false, "新增的任务默认没完成");
eq(plan.priority, "", "新增的今日计划任务默认不标优先级");
eq(plan.isTodayPlan, false, "新增的今日计划任务默认不占那个跨模块开关");
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

const proj = newRow("devProject",
  { name: "小李", status: "进行中", startDate: "2026-10-03", intro: "本机小工具",
    description: "把十个模块串起来", expectEndDate: "2026-12-31" }, ctx);
eqDeep(proj, {
  id: "id-1", name: "小李", status: "进行中", intro: "本机小工具",
  description: "把十个模块串起来", startDate: "2026-10-03", expectEndDate: "2026-12-31",
  imagePaths: [],
}, "新增项目：空壳 + 七个字段 + 空图片数组");

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

const projTrash = trashPlan("devProject", { id: "p1", name: "小李" }, {
  tasks: [
    { id: "t1", belong: "dev:p1", text: "待办一" },
    { id: "t2", belong: "dev:p2", text: "别人的待办" },
    { id: "t3", belong: "plan", text: "今日计划里的" },
  ],
  issues: [
    { id: "i1", projectId: "p1", title: "问题一" },
    { id: "i2", projectId: "p2", title: "别人的问题" },
  ],
  progress: [
    { id: "g1", projectId: "p1", text: "进展一" },
  ],
});
eq(projTrash.label, "小李", "删项目用项目名当提示");
eq(projTrash.items.length, 4, "删项目要带走它的 1 条待办 + 1 个问题 + 1 条进展");
eqDeep(projTrash.items.map((i) => i.table), ["projects", "tasks", "issues", "progress"],
  "动的是这四张表");
eqDeep(projTrash.items.map((i) => i.row.id), ["p1", "t1", "i1", "g1"], "只带走属于它的那些");
eq(projTrash.extra, 3, "额外带走 3 条（给提示文案用）");
eq(trashPlan("devProject", { id: "p9", name: "空项目" }).items.length, 1, "没有附属内容时只动 projects");
eq(formOf("devProject").extraNote, "条待办 / 问题 / 进展", "删项目的提示语说清带走的是什么");
eq(formOf("studyItem").extraNote, "条学习记录", "删学习对象的提示语也是它自己那句");
eq(formOf("game").extraNote, undefined, "没有连带内容的类型不用写提示语");
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

/* ---------------- 模块目标那个弹窗 ---------------- */

const goalSpec = formOf("moduleGoal");
eq(goalSpec.table, "moduleGoals", "目标存在 moduleGoals 里（按模块分桶，不是普通表）");
eq(goalSpec.upload, undefined, "目标弹窗没有图片区");
eq(goalSpec.titleNew, "设置模块目标", "新增标题");
eq(goalSpec.titleEdit, "修改模块目标", "编辑标题");

const goalFields = goalSpec.fields.map((f) => f.name);
eqDeep(goalFields, ["moduleName", "mainTarget", "cycle", "startDate", "endDate",
  "dailyRule", "remark", "isActive", "autoTask"], "目标的九个字段，按顺序");
eq(formOf("moduleGoal").fields.find((f) => f.name === "moduleName").kind, "static",
  "「所属模块」是只读的一行");
eq(formOf("moduleGoal").fields.find((f) => f.name === "isActive").kind, "switch",
  "「启用目标」是开关");
eq(formOf("moduleGoal").fields.find((f) => f.name === "autoTask").kind, "switch",
  "「自动生成任务」也是开关");
eq(formOf("moduleGoal").fields.find((f) => f.name === "mainTarget").required, true,
  "核心目标是必填");

const goalForm = formHtml("moduleGoal",
  { moduleName: "健身计划", mainTarget: "减重 8kg", cycle: "月度",
    startDate: "2026-10-07", endDate: "", dailyRule: "每周一、三、五力量训练",
    remark: "", isActive: "true", autoTask: "true" },
  {});
ok(goalForm.includes("健身计划"), "只读那行把模块名画出来");
ok(goalForm.includes('value="减重 8kg"') || goalForm.includes("减重 8kg"), "核心目标回填");
ok(goalForm.includes('id="item-cycle"'), "周期是下拉");
ok(goalForm.includes("月度"), "周期选项里有月度");
ok(goalForm.includes("自定义起止日期"), "周期选项里有自定义起止日期");
ok(goalForm.includes('type="checkbox"'), "两个开关画成了 checkbox");
ok(goalForm.includes("checked"), "开着的开关是勾上的");
ok(!goalForm.includes('id="item-moduleName" type'), "只读字段不是输入框");

// 只读字段：读的时候不带、写的时候不碰
const goalValues = readValues("moduleGoal", (name) =>
  name === "mainTarget" ? "减重 8kg" : name === "isActive" ? "on" : "");
eq(goalValues.moduleName, undefined, "只读字段不进表单值");
const goalRow = { id: "g1", moduleId: "fitness", moduleName: "健身计划", mainTarget: "旧的" };
applyValues("moduleGoal", goalRow, { ...goalValues, isActive: "on", autoTask: "" });
eq(goalRow.moduleName, "健身计划", "只读的模块名没被冲掉");
eq(goalRow.mainTarget, "减重 8kg", "核心目标写回去了");
eq(goalRow.isActive, true, "开关勾着就是 true");
eq(goalRow.autoTask, false, "开关没勾就是 false");

const goalNew = newRow("moduleGoal",
  { mainTarget: "每天学 2 小时", cycle: "每日", startDate: "2026-10-07",
    endDate: "", dailyRule: "晚 7 点-9 点学习", remark: "", isActive: "on", autoTask: "on" },
  { uid: () => "goal-1", moduleId: "study", moduleName: "学习工作", date: "2026-10-07" });
eq(goalNew.moduleId, "study", "新目标带上模块 id");
eq(goalNew.id, "goal-1", "新目标走 uid");
eq(goalNew.isActive, true, "默认启用");
eq(goalNew.imagePaths, undefined, "目标不带图片数组（没有图片区）");

// 目标不进回收站：它自己给一份「只删配置」的计划
const goalTrash = trashPlan("moduleGoal", { id: "g1", mainTarget: "减重 8kg" });
eq(goalTrash.label, "减重 8kg", "删除确认里显示目标");
eq(goalTrash.items.length, 0, "不往回收站里放任何东西");
ok(typeof goalTrash.apply === "function", "删除动作自己做（从桶里摘掉）");
ok(goalTrash.note.includes("待办会留"), "提示里说清「已生成的待办会留着」");

/* ---------------- 游玩记录那个弹窗（2026-10-07 加的） ---------------- */

eq(formOf("gamePlayRecord").table, "gameRecords", "游玩记录存 gameRecords 表");
eq(formOf("gamePlayRecord").upload, "game_record", "游玩记录的图片单独一格");
eqDeep(formOf("gamePlayRecord").fields.map((f) => f.name),
  ["gameName", "playDate", "duration", "durationUnit", "remark"],
  "游玩记录五个字段：游戏名 / 日期 / 时长 / 单位 / 备注");
eq(formOf("gamePlayRecord").fields[0].kind, "combo",
  "游戏名是「下拉 + 手打」两用（清单里有就选，没有就自己打）");
eq(formOf("gamePlayRecord").fields[0].required, true, "游戏名必填");
eq(formOf("gamePlayRecord").fields[2].required, true, "时长必填（不然记了等于没记）");

eq(validate("gamePlayRecord", { gameName: "  " }).ok, false, "游戏名只填空格不算填");
eq(validate("gamePlayRecord", { gameName: "只狼", playDate: "2026-10-07" }).error,
  "「游玩时长」不能是空的", "时长没填要拦下来");
eq(validate("gamePlayRecord", { gameName: "只狼", playDate: "2026-10-07", duration: "2" }).ok,
  true, "名字 + 日期 + 时长填了就能存");

const playHtml = formHtml("gamePlayRecord",
  { gameName: "王者", playDate: "2026-10-07", duration: 2, durationUnit: "小时", remark: "" },
  { gameOptions: [{ value: "王者荣耀", label: "王者荣耀 · 在玩" }] });
ok(playHtml.includes('list="item-gameName-list"'), "游戏名画成带候选框的输入框");
ok(playHtml.includes('<option value="王者荣耀" label="王者荣耀 · 在玩">'), "候选项来自清单里的游戏");
ok(playHtml.includes('<option value="小时" selected>小时</option>'), "时长单位选到小时");
ok(playHtml.includes('id="item-duration"') && playHtml.includes('type="number"'), "时长是数字框");

// 编辑时：存的是分钟，框里按「数字 + 单位」回填
eq(valuesOf("gamePlayRecord", { durationMin: 120 }).duration, "2", "120 分钟回填成 2");
eq(valuesOf("gamePlayRecord", { durationMin: 120 }).durationUnit, "小时", "整小时就按小时回填");
eq(valuesOf("gamePlayRecord", { durationMin: 90 }).duration, "90", "90 分钟按分钟回填");
eq(valuesOf("gamePlayRecord", { durationMin: 90 }).durationUnit, "分钟", "不是整小时就按分钟");
eq(valuesOf("gamePlayRecord", {}).duration, "", "没有时长就留空，让占位提示露出来");

// 写回：把「数字 + 单位」拧成分钟，游戏名顺手绑上清单里的 id
const play = { id: "r1", gameId: "", gameName: "", playDate: "", durationMin: 0, remark: "" };
applyValues("gamePlayRecord", play,
  { gameName: "王者荣耀", playDate: "2026-10-07", duration: "2", durationUnit: "小时", remark: "排位" },
  { gameIdByName: { 王者荣耀: "g1" } });
eq(play.durationMin, 120, "2 小时落盘成 120 分钟");
eq(play.gameId, "g1", "选到清单里的游戏就自动绑上 id");
eq(play.gameName, "王者荣耀", "游戏名照旧存一份（清单里删了这款，记录还看得出玩的什么）");
eq(play.remark, "排位", "备注原样写回");
eq(play.duration, undefined, "表单里那个「数字」不落盘，数据里只有分钟");
eq(play.durationUnit, undefined, "单位也不落盘");

const loose = {};
applyValues("gamePlayRecord", loose, { gameName: "路边小游戏", duration: "45", durationUnit: "分钟" });
eq(loose.durationMin, 45, "临时玩的按分钟记");
eq(loose.gameId, "", "清单里没有的就留空，不瞎绑");

const playNew = newRow("gamePlayRecord",
  { gameName: "只狼", playDate: "2026-10-06", duration: "90", durationUnit: "分钟", remark: "" },
  { uid: () => "id-9", nowIso: () => "2026-10-06T20:00:00.000Z", date: "2026-10-07" });
eqDeep(playNew, {
  id: "id-9", gameId: "", gameName: "只狼", playDate: "2026-10-06", durationMin: 90,
  remark: "", createAt: "2026-10-06T20:00:00.000Z", imagePaths: [],
}, "新增游玩记录：空壳 + 表单值（时长拧成分钟）+ 空图片数组");

const playTrash = trashPlan("gamePlayRecord", { id: "r1", gameName: "只狼", playDate: "2026-10-07" });
eq(playTrash.items.length, 1, "删游玩记录只动 gameRecords 一张表");
eq(playTrash.items[0].table, "gameRecords", "进回收站也进对表");
ok(playTrash.label.includes("只狼"), "删除确认里带上游戏名");

// 游戏清单的两格新字段：写回时数字照旧转成数字，没填就是 0 / 空串
const gRow = { id: "g1", name: "只狼" };
applyValues("game", gRow, { name: "只狼", platform: "PC", status: "已通关",
  targetHours: "10", finishDate: "2026-09-20", hours: "", progress: "" });
eq(gRow.targetHours, 10, "每月目标写成数字");
eq(gRow.finishDate, "2026-09-20", "通关日期原样写回");

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
