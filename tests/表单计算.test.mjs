/* 各模块弹窗字段表（app/web/item-form.js）的单元测试。
 * 跑法：node tests\表单计算.test.mjs   （本机 Node v24，不需要 package.json）
 * 说明：和别的 .test.mjs 一样，不进「自检.cmd」——自检是给用户一键跑的，保持纯 Python。 */

import {
  FORMS, ITEM_TYPES, formOf, optionsOf, formHtml,
  defaultsOf, valuesOf, readValues, validate, applyValues, newRow, trashPlan, imagesOf,
  parseSubtaskJson, repeatRuleError,
  TASK_CATEGORIES, PRIORITIES, PROJECT_STATUSES, STUDY_KINDS, GAME_STATUSES, GAME_PLATFORMS,
} from "../app/web/item-form.js";
import { ATTACH_MODULES } from "../app/web/attachment-calc.js";
import { isRepeatRule } from "../app/web/task-calc.js";

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
    "gamePlayRecord", "moduleGoal", "repeatRule", "workLog", "food", "mealItem"],
  "十三个弹窗类型都在，按顺序（菜谱与吃了什么是 2026-10-14 加的）");
eq(formOf("devProject").table, "projects", "项目存 projects 表");
eq(formOf("devProject").upload, "dev_project", "项目的图片单独一格");
eq(formOf("game").table, "games", "游戏存 games 表");
eq(formOf("studyRecord").table, "studies", "学习记录存 studies 表");
eq(formOf("studyItem").table, "subjects", "学习对象存 subjects 表");
eq(formOf("fitness").table, "workoutLogs", "训练打卡存 workoutLogs 表");
eq(formOf("todayPlan").table, "tasks", "今日计划存 tasks 表");
eq(formOf("devTodo").table, "tasks", "开发待办也存 tasks 表（靠 belong 区分）");
eq(formOf("repeatRule").table, "tasks", "重复任务也存 tasks 表（靠 repeat 有内容区分）");
ok(!formOf("repeatRule").upload,
  "重复任务不带图片区（实例不继承图片，规则自己存图没地方用）");
eq(formOf("workLog").table, "workLogs", "工时存 workLogs 表");
ok(!formOf("workLog").upload, "工时不带图片区（一条工时没有值得存图的场景）");
eq(formOf("food").table, "foods", "菜谱存 foods 表");
ok(!formOf("food").upload, "菜谱不带图片区");
eq(formOf("mealItem").table, "", "吃了什么不进顶层表（挂在 meals 那条的 items 上）");

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
  { name: "", status: "进行中", startDate: "", intro: "", description: "", expectEndDate: "",
    tags: "" },
  "新增项目的默认值（状态默认进行中，其它空着）");
eq(valuesOf("devProject", { name: "木头", status: "废弃", description: "先放着" }).status, "废弃",
  "编辑时状态回填");
eq(valuesOf("devProject", { name: "木头" }).description, "", "老项目没有详细描述就是空串");
eq(validate("devProject", { name: "  " }).error, "「项目名称」不能是空的", "项目名必填");
eq(validate("devProject", { name: "小李" }).ok, true, "只填名字也能存（其它都可选）");

/* ---------------- 初始值 ---------------- */

eqDeep(defaultsOf("game"),
  { name: "", platform: "PC", status: "想玩", targetHours: "", finishDate: "",
    tags: "", hours: "", progress: "" },
  "新增游戏时的默认值");
eq(defaultsOf("studyItem").kind, "书", "新增学习对象默认类型是书");
eq(defaultsOf("devTodo").priority, "", "新增待办默认不标优先级");

eqDeep(valuesOf("game", { name: "只狼", status: "已通关" }),
  { name: "只狼", platform: "PC", status: "已通关", targetHours: "", finishDate: "",
    tags: "", hours: "", progress: "" },
  "编辑时：记录里有的用记录的，没有的用默认值");
eq(valuesOf("game", { hours: 0 }).hours, "", "时长 0 当成没填，框里留空");
eq(valuesOf("game", { hours: 42 }).hours, "42", "时长有值就带出来");
eq(valuesOf("fitness", null, { date: "2026-10-01" }).date, "2026-10-01", "extra 能盖掉默认值（比如从某一天点进来）");

/* ---------------- 读表单 ---------------- */

const bag = { text: "  写方案  ", minutes: "", category: "生活" };
eqDeep(readValues("todayPlan", (name) => bag[name]),
  { text: "  写方案  ", time: "", category: "生活", priority: "", tags: "", subtasks: "", note: "" },
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
  text: "把月历氛围底调淡", tags: [], subtasks: [], imagePaths: [],
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
  tags: [], imagePaths: [],
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
eq(formOf("devProject").extraNote, "条待办 / 问题 / 进展 / 工时",
  "删项目的提示语说清带走的是什么（工时也一起走）");
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
eqDeep(goalFields, ["moduleName", "mainTarget", "cycle", "tags", "startDate", "endDate",
  "dailyRule", "remark", "isActive", "autoTask"], "目标的十个字段，按顺序（标签插在周期后面）");
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
  ["gameName", "playDate", "duration", "durationUnit", "tags", "remark"],
  "游玩记录六个字段：游戏名 / 日期 / 时长 / 单位 / 标签 / 备注");
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
  remark: "", createAt: "2026-10-06T20:00:00.000Z", tags: [], imagePaths: [],
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

/* ---------------- 标签字段（2026-10-11 加的） ----------------
   表单里它是「一行文本」，记录里它是数组：进和出都在这儿转换，
   页面那边不许自己拆字符串。 */

for (const type of ITEM_TYPES) {
  const field = formOf(type).fields.find((f) => f.kind === "tags");
  ok(Boolean(field), `${type} 挂了标签字段`);
  eq(field && field.name, "tags", `${type} 的标签字段名就叫 tags`);
}

const tagForm = { ...defaultsOf("todayPlan"), text: "写标签系统", tags: "工作, 本周、工作" };
const tagRow = newRow("todayPlan", tagForm,
  { uid: () => "t-tags", nowIso: () => "2026-10-11T10:00:00.000Z", date: "2026-10-11" });
eqDeep(tagRow.tags, ["工作", "本周"], "记录里存的是干净数组（重复的、混着写分隔符都收拾好）");
eq(tagRow.text, "写标签系统", "别的字段照旧（标签没把表单读坏）");

eq(valuesOf("todayPlan", { id: "t1", text: "x", tags: ["工作", "本周"] }, {}).tags, "工作、本周",
  "编辑时回填成一行文本");
eq(valuesOf("todayPlan", { id: "t1", text: "x" }, {}).tags, "", "老记录没标签 → 空框");

eq(validate("todayPlan", { ...tagForm, tags: "一,二,三,四,五,六,七,八,九" }).ok, false,
  "9 个标签过不了校验");
eq(validate("todayPlan", { ...tagForm, tags: "一,二,三,四,五,六,七,八" }).ok, true,
  "8 个刚好放行");
eq(validate("todayPlan", { ...tagForm, tags: "长".repeat(25) }).error.indexOf("24") >= 0, true,
  "单个标签太长时，提示里带上限（人看得见该改多少）");
eq(validate("todayPlan", { ...tagForm, tags: "工作" }).ok, true, "正常标签放行");

const cleared = { id: "t2", text: "老记录", tags: ["旧的"] };
applyValues("todayPlan", cleared, { ...tagForm, tags: "" });
eqDeep(cleared.tags, [], "标签框清空 = 字段清成空数组（不是留着旧值）");

const tagHtml = formHtml("todayPlan", { tags: "工作" }, { tagOptions: ["工作", "本周"] });
ok(tagHtml.indexOf('id="item-tags"') >= 0, "弹窗里画出了标签输入框");
ok(tagHtml.indexOf('list="item-tags-list"') >= 0, "输入框挂着候选列表（打一个字就有得补）");
ok(tagHtml.indexOf('<option value="本周">') >= 0, "候选里是全站已经出现过的标签");
ok(formHtml("todayPlan", {}, {}).indexOf('id="item-tags"') >= 0,
  "一个候选都没有时，输入框照样在（不该整块消失）");
ok(tagHtml.indexOf('data-tags-preview="tags"') >= 0, "输入框下面留着那行实时预览的位置");

/* ---------------- 子任务字段（2026-10-14 加的） ----------------
   表单里它是一块可增删的小列表，底下藏着一条隐藏 input（里面是 JSON 字符串）——
   读值 / 写回走的还是表单那一套，所以校验、落盘一个字都不重复。 */

const subHtml = formHtml("devTodo", { subtasks: "[]" }, {});
ok(subHtml.indexOf('data-subtasks="subtasks"') >= 0, "弹窗里画出了子任务那一块");
ok(subHtml.indexOf('id="item-subtasks"') >= 0, "底下那条隐藏 input 在（值从它走）");
ok(subHtml.indexOf('type="hidden"') >= 0, "它是隐藏的（不占地方）");
eq(defaultsOf("devTodo", {}).subtasks, "[]", "新增时清单默认给一个空数组的 JSON");
eq(valuesOf("devTodo", { id: "t1", subtasks: [{ id: "s1", text: "改侧栏", done: true }] }, {}).subtasks,
  '[{"id":"s1","text":"改侧栏","done":true}]', "编辑时把清单编码成 JSON 回填");
eq(valuesOf("devTodo", { id: "t1" }, {}).subtasks, "[]", "老记录没有清单 → 空数组的 JSON");

const subRow = newRow("devTodo", { ...defaultsOf("devTodo"), text: "改版",
  subtasks: '[{"id":"s1","text":" 改侧栏 ","done":true},{"id":"","text":"","done":false}]' },
  { uid: () => "t-subs", nowIso: () => "2026-10-14T10:00:00.000Z", pid: "p1" });
eqDeep(subRow.subtasks, [{ id: "s1", text: "改侧栏", done: true }],
  "写回记录时是数组：两头空白掐掉、空条目扔掉");

const clearedSubs = { id: "t2", text: "老记录", subtasks: [{ id: "s1", text: "旧的", done: true }] };
applyValues("devTodo", clearedSubs, { ...defaultsOf("devTodo"), text: "x", subtasks: "[]" });
eqDeep(clearedSubs.subtasks, [], "清单清空 = 记录里清成空数组（不是留着旧值）");
eqDeep(parseSubtaskJson("这不是 JSON"), [], "读不出 JSON 时当空的，不抛错");
eqDeep(parseSubtaskJson(""), [], "空串当空的");
eqDeep(parseSubtaskJson('[{"id":"s1","text":"a","done":1}]'), [{ id: "s1", text: "a", done: true }],
  "done 不是布尔也认（转成布尔）");

const manySubs = JSON.stringify(
  Array.from({ length: 31 }, (_, i) => ({ id: "s" + i, text: "第" + i, done: false })));
eq(validate("devTodo", { ...defaultsOf("devTodo"), text: "x", subtasks: manySubs }).ok, false,
  "31 条子任务过不了校验");
ok(validate("devTodo", { ...defaultsOf("devTodo"), text: "x", subtasks: manySubs }).error.indexOf("30") >= 0,
  "提示里带上限 30");
eq(validate("devTodo", { ...defaultsOf("devTodo"), text: "x",
  subtasks: JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ id: "s" + i, text: "第" + i }))) }).ok,
  true, "刚好 30 条放行");

/* ---------------- 重复任务表单（2026-10-14 加的） ---------------- */

const ruleHtml = formHtml("repeatRule", defaultsOf("repeatRule", {}), {});
ok(ruleHtml.indexOf('id="item-repeat"') >= 0, "画出了「重复」那一格");
ok(ruleHtml.indexOf('data-rule-preview="repeat"') >= 0, "下面带着实时预览那行");
ok(ruleHtml.indexOf('id="item-subtasks"') >= 0, "规则上面也能挂子任务清单");
eq(defaultsOf("repeatRule", {}).repeat, "", "新增时重复规则是空的");
eq(validate("repeatRule", { ...defaultsOf("repeatRule"), text: "散步", repeat: "" }).ok, false,
  "不写重复规则过不了校验");
eq(validate("repeatRule", { ...defaultsOf("repeatRule"), text: "散步", repeat: "随便写写" }).ok, false,
  "写了但没写出哪几天，也过不了");
ok(validate("repeatRule", { ...defaultsOf("repeatRule"), text: "散步", repeat: "随便写写" })
  .error.indexOf("每周一") >= 0, "提示里给一个能抄的例子");
eq(validate("repeatRule", { ...defaultsOf("repeatRule"), text: "散步", repeat: "每周一、三、五" }).ok,
  true, "「每周一、三、五」放行");
eq(validate("repeatRule", { ...defaultsOf("repeatRule"), text: "交房租", repeat: "每月 1 号" }).ok, true,
  "「每月 1 号」也放行");
eq(validate("repeatRule", { ...defaultsOf("repeatRule"), text: "散步", repeat: "每天跑步" }).ok, true,
  "「每天」是合法的（有「每天」两个字就算写出了日子）");
eq(repeatRuleError(""), "", "空串没有错误信息（必填那条交给 required 报）");
eq(repeatRuleError("每周一、三、五"), "", "写清楚了就没毛病");
ok(repeatRuleError("跑步").indexOf("哪几天") >= 0, "没写出哪几天时给的那句话");

const ruleRow = newRow("repeatRule", { ...defaultsOf("repeatRule"), text: "跑步 5 公里",
  repeat: "每周一、三、五", repeatUntil: "2026-12-31", time: "07:30", priority: "中",
  category: "运动", tags: "运动, 每天", subtasks: '[{"text":"换跑鞋"}]' },
  { uid: () => "t-rule-1", nowIso: () => "2026-10-14T10:00:00.000Z" });
eq(ruleRow.date, "", "规则不占某一天（date 空着）");
eq(ruleRow.belong, "plan", "规则落在今日计划这堆里");
eq(ruleRow.repeat, "每周一、三、五", "规则原样存着");
eq(ruleRow.repeatUntil, "2026-12-31", "「重复到哪天」原样存着");
eq(ruleRow.lastRun, "", "lastRun 从空开始");
eqDeep(ruleRow.tags, ["运动", "每天"], "标签照样能贴");
eqDeep(ruleRow.subtasks.map((s) => s.text), ["换跑鞋"], "规则能带子任务清单");
eq(isRepeatRule(ruleRow), true, "存下来的这条就是一条规则");

/* ---------------- 工时表单（2026-10-14 加的） ---------------- */

const workForm = { ...defaultsOf("workLog"), date: "2026-10-14", projectId: "p1",
  duration: "2", durationUnit: "小时", note: "把工时页画完", tags: "开发" };
const workRow = newRow("workLog", workForm,
  { uid: () => "w1", nowIso: () => "2026-10-14T10:00:00.000Z" });
eq(workRow.minutes, 120, "表单里填的「2 小时」落盘成 120 分钟");
eq(workRow.duration, undefined, "数据里不留影子字段（duration）");
eq(workRow.durationUnit, undefined, "数据里不留影子字段（durationUnit）");
eq(workRow.projectId, "p1", "项目照原样存");
eqDeep(workRow.tags, ["开发"], "标签照旧");
eq(workRow.id, "w1", "id 用 ctx.uid 发的");
eq(defaultsOf("workLog").durationUnit, "小时", "新增时单位默认「小时」（工时按小时说更顺）");
eq(validate("workLog", { ...workForm, date: "" }).ok, false, "日期必填");
eq(validate("workLog", { ...workForm, duration: "" }).ok, false, "时长必填");
eq(validate("workLog", { ...workForm, projectId: "" }).ok, true, "不挑项目也能存");
eq(valuesOf("workLog", { id: "w1", minutes: 90 }, {}).duration, "90", "编辑回填：90 分钟按分钟填");
eq(valuesOf("workLog", { id: "w1", minutes: 120 }, {}).duration, "2", "整小时按小时填");
eq(valuesOf("workLog", { id: "w1", minutes: 120 }, {}).durationUnit, "小时", "单位跟着回填");
eq(valuesOf("workLog", { id: "w1", minutes: 30 }, {}).durationUnit, "分钟", "零头按分钟填");
eq(trashPlan("workLog", { id: "w1", note: "写文档" }).label, "写文档", "删除确认里用备注当名字");
eq(trashPlan("workLog", { id: "w2", date: "2026-10-14" }).label, "2026-10-14 工时",
  "没备注就用日期凑一个名字");

// 删项目要把它的工时也收走（和待办 / 问题 / 进展一个待遇）
const projPlan = trashPlan("devProject", { id: "p1", name: "工作台" },
  { tasks: [], issues: [], progress: [],
    workLogs: [{ id: "w1", projectId: "p1", note: "写文档", date: "2026-10-14" },
               { id: "w2", projectId: "p2", note: "别人的", date: "2026-10-14" }] });
eqDeep(projPlan.items.filter((i) => i.table === "workLogs").map((i) => i.row.id), ["w1"],
  "只带走这个项目的工时（别的项目的不动）");
eq(projPlan.extra, 1, "连带条数算上了它");

/* ---------------- 菜谱与「吃了什么」（2026-10-14 加的） ---------------- */

const foodRow = newRow("food", { ...defaultsOf("food"), name: "米饭", unit: "碗",
  kcal: "200", protein: "4", fat: "0.5", carb: "44", tags: "主食", note: "一小碗" },
  { uid: () => "f1", nowIso: () => "2026-10-14T10:00:00.000Z" });
eq(foodRow.kcal, 200, "热量转成数字");
eq(foodRow.fat, 0.5, "脂肪能是小数");
eqDeep(foodRow.tags, ["主食"], "标签照旧");
eq(validate("food", { ...defaultsOf("food"), name: "" }).ok, false, "名称必填");
eq(validate("food", { ...defaultsOf("food"), name: "米饭" }).ok, true, "只填名字也能存");
eq(validate("food", { ...defaultsOf("food"), name: "米饭", kcal: "" }).ok, true,
  "热量留空也能存（先记个名字、回头再补）");
eq(formOf("food").fields.find((f) => f.name === "kcal").kind, "number", "热量是数字格");

const itemForm = { ...defaultsOf("mealItem"), slot: "早餐", name: "米饭", unit: "碗",
  amount: "1.5", kcal: "200", protein: "4", fat: "0.5", carb: "44" };
eq(defaultsOf("mealItem").slot, "早餐", "新增时默认早餐");
eq(formOf("mealItem").fields.find((f) => f.name === "name").autoFill, "foods",
  "名称那一格声明了「从菜谱库自动带出」");
const itemRow = newRow("mealItem", itemForm, { uid: () => "mi1" });
eq(itemRow.slot, "breakfast", "「早餐」这一格落盘成 breakfast");
eq(itemRow.name, "米饭", "名字留着");
eq(itemRow.amount, 1.5, "份数能是小数");
eq(itemRow.kcal, 200, "每份热量照存（不是乘完的总数）");
eq(validate("mealItem", { ...itemForm, name: "" }).ok, false, "名字必填");
eq(newRow("mealItem", { ...itemForm, slot: "夜宵" }, { uid: () => "mi2" }).slot, "snack",
  "认不出的餐次归加餐（脏数据也不丢）");

// 「吃了什么」不进顶层表：落盘走 persist，删除走 apply（都不碰回收站）
const bucket = { items: [] };
const mealSpec = formOf("mealItem");
mealSpec.persist({ meal: bucket }, itemRow, true);
eqDeep(bucket.items.map((i) => i.id), ["mi1"], "persist 把它挂到那一餐上");
eq(bucket.items[0].slot, "breakfast", "挂上去的那条餐次已经换成了键");
const mealPlan = trashPlan("mealItem", itemRow, {}, { meal: bucket });
eqDeep(mealPlan.items, [], "删除计划不走回收站");
mealPlan.apply();
eq(bucket.items.length, 0, "apply 把它从那一餐里摘掉");

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
