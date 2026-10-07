/* 各模块「新增 / 编辑」弹窗的字段表 —— 纯逻辑，不碰 DOM、不碰 store。
 *
 * 为什么把字段写成一张表：今日计划、开发待办、学习记录、学习对象、训练打卡、
 * 游戏这六处的弹窗长得一模一样（标题 + 若干字段 + 附件区 + 取消/保存），
 * 区别只在「有哪些字段、存哪张表、图片放哪个文件夹」。写成声明式的一张表之后：
 *   · 画表单、读表单、校验、写回记录这四件事各只有一份实现（下面那几个函数）；
 *   · 加一个模块就是往 FORMS 里加一条，不用再抄一遍弹窗；
 *   · 这些函数全是纯的，`node tests\表单计算.test.mjs` 能一条条断言。
 */

import { rowPaths } from "./attachment-calc.js";
import { GOAL_CYCLES } from "./goal-calc.js";

/* 这里自带一个转义：store.js 里那个 esc 是给浏览器用的（那个文件会碰 window），
   纯模块 import 不了它。实现故意和 store.js 里那份保持一致。 */
function esc(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ---------------- 各模块共用的几个词表 ---------------- */

export const TASK_CATEGORIES = ["工作", "生活", "运动", "其他"];
export const PRIORITIES = ["高", "中", "低"];
export const PROJECT_STATUSES = ["进行中", "已暂停", "已完成", "废弃"];
export const STUDY_KINDS = ["书", "课程", "视频", "技能", "其它"];
export const GAME_STATUSES = ["在玩", "想玩", "已通关", "弃坑"];
export const GAME_PLATFORMS = ["PC", "Switch", "PS5", "手机", "其它"];

/* ---------------- 字段表 ----------------
 *
 * 一个字段长这样：
 *   { name, label, kind: "text"|"number"|"date"|"time"|"select"|"textarea",
 *     required, placeholder, maxlength, min, step, list, source, half, default }
 *
 *   list   —— 下拉的固定选项（字符串数组）
 *   source —— 下拉的选项来自运行时给的数据（见 formHtml 的 ctx）
 *   half   —— 连续两个 half 字段并排一行
 *   upload —— 图片存到 数据\attachments\<这个目录>\
 *   create —— 新增时先捏一个空壳（id、归属、创建时间这些不在表单里的字段）
 */

export const FORMS = {
  devProject: {
    table: "projects",
    upload: "dev_project",
    titleNew: "新增项目",
    titleEdit: "编辑项目",
    hint: "一个项目一条线：待办、问题、进展都挂在它下面。",
    fields: [
      { name: "name", label: "项目名称", kind: "text", required: true, maxlength: 80,
        placeholder: "比如：小李（个人工作台）" },
      { name: "status", label: "状态", kind: "select", list: PROJECT_STATUSES,
        half: true, default: "进行中" },
      { name: "startDate", label: "开始日期", kind: "date", half: true },
      { name: "intro", label: "一句话简介", kind: "text", maxlength: 120,
        placeholder: "这个项目是干什么的（可不填）" },
      { name: "description", label: "详细描述", kind: "textarea", rows: 5,
        maxlength: 2000, placeholder: "目标、规划、怎么算做完（可不填）" },
      { name: "expectEndDate", label: "预计结束日期", kind: "date",
        placeholder: "打算什么时候收尾（可不填）" },
    ],
    label: (row) => row.name || "（没写名字）",
    extraNote: "条待办 / 问题 / 进展",   // 删除确认里那句「它的 N … 也一起进回收站」
    create: (ctx) => ({
      id: ctx.uid(),
      name: "",
      status: "进行中",
      intro: "",
      description: "",
      startDate: "",
      expectEndDate: "",
    }),
  },

  todayPlan: {
    table: "tasks",
    upload: "today_plan",
    titleNew: "新增任务",
    titleEdit: "修改任务",
    hint: "今天的任务，做完记得勾上。",
    fields: [
      { name: "text", label: "任务", kind: "text", required: true, maxlength: 200,
        placeholder: "今天要做什么…" },
      { name: "time", label: "计划时间", kind: "time", half: true },
      { name: "category", label: "分类", kind: "select", list: TASK_CATEGORIES,
        half: true, default: "工作" },
      { name: "note", label: "备注", kind: "textarea", rows: 3, maxlength: 400,
        placeholder: "备注（可不填）" },
    ],
    label: (row) => row.text || "（没写内容）",
    create: (ctx) => ({
      id: ctx.uid(),
      date: ctx.date || "",
      time: "",
      category: "工作",
      done: false,
      note: "",
      belong: "plan",
      createdAt: ctx.nowIso(),
    }),
  },

  devTodo: {
    table: "tasks",
    upload: "dev_todo",
    titleNew: "新增待办",
    titleEdit: "修改待办",
    hint: "只属于这个项目的待办，不会出现在「今日计划」里。",
    fields: [
      { name: "text", label: "要做什么", kind: "text", required: true, maxlength: 200,
        placeholder: "这个项目要做什么…" },
      { name: "priority", label: "优先级", kind: "select", list: PRIORITIES,
        half: true, blank: "不标", default: "" },
      { name: "note", label: "备注", kind: "textarea", rows: 3, maxlength: 400,
        placeholder: "备注（可不填）" },
    ],
    label: (row) => row.text || "（没写内容）",
    create: (ctx) => ({
      id: ctx.uid(),
      date: "",
      time: "",
      category: "工作",
      done: false,
      note: "",
      priority: "",
      belong: "dev:" + (ctx.pid || ""),
      createdAt: ctx.nowIso(),
    }),
  },

  studyRecord: {
    table: "studies",
    upload: "study_record",
    titleNew: "记一条学习",
    titleEdit: "改这条学习",
    hint: "学了多久、学了什么、有什么心得，随手记一句就够。",
    fields: [
      { name: "date", label: "日期", kind: "date", required: true, half: true },
      { name: "subjectId", label: "学习对象", kind: "select", source: "subjects",
        half: true },
      { name: "minutes", label: "时长（分钟）", kind: "number", min: 0, step: 5,
        placeholder: "比如 45" },
      { name: "content", label: "学了什么", kind: "text", maxlength: 120,
        placeholder: "今天学了什么…" },
      { name: "takeaway", label: "心得 / 疑问", kind: "textarea", rows: 4,
        maxlength: 600, placeholder: "哪里没懂、哪句想抄下来（可不填）" },
    ],
    // 内容和心得至少写一句，不然记了等于没记（和改版前一个规矩）
    requireAny: ["content", "takeaway"],
    requireAnyError: "至少写一句学了什么",
    label: (row) => row.content || row.takeaway || "（没写学了什么）",
    create: (ctx) => ({
      id: ctx.uid(),
      date: ctx.date || "",
      subjectId: "",
      minutes: 0,
      content: "",
      takeaway: "",
      reviewed: false,
    }),
  },

  studyItem: {
    table: "subjects",
    upload: "study_item",
    titleNew: "新增学习对象",
    titleEdit: "改这个学习对象",
    hint: "先把想学的列出来，学的时候好归位。",
    fields: [
      { name: "name", label: "名称", kind: "text", required: true, maxlength: 60,
        placeholder: "书名 / 课程名 / 要练的技能…" },
      { name: "kind", label: "类型", kind: "select", list: STUDY_KINDS,
        half: true, default: "书" },
      { name: "source", label: "作者 / 平台", kind: "text", maxlength: 60,
        half: true, placeholder: "中信出版 / B 站…" },
      { name: "note", label: "备注", kind: "textarea", rows: 3, maxlength: 400,
        placeholder: "为什么想学、打算怎么学（可不填）" },
    ],
    label: (row) => row.name || "（没写名字）",
    extraNote: "条学习记录",
    create: (ctx) => ({
      id: ctx.uid(), name: "", kind: "书", source: "", note: "",
    }),
  },

  fitness: {
    table: "workoutLogs",
    upload: "fitness",
    titleNew: "记一次训练",
    titleEdit: "改这次训练",
    hint: "动作、组数、重量，或者今天跑了多远。",
    fields: [
      { name: "date", label: "打卡日期", kind: "date", required: true, half: true },
      { name: "moves", label: "训练内容", kind: "textarea", rows: 4, maxlength: 600,
        required: true, placeholder: "深蹲 3×12 / 硬拉 3×8，或者跑步 5 km" },
      { name: "note", label: "备注", kind: "textarea", rows: 3, maxlength: 400,
        placeholder: "今天感觉怎么样（可不填）" },
    ],
    label: (row) => row.moves || "（没写练了什么）",
    create: (ctx) => ({ id: ctx.uid(), date: ctx.date || "", moves: "", note: "" }),
  },

  game: {
    table: "games",
    upload: "game",
    titleNew: "新增游戏",
    titleEdit: "改这条游戏",
    hint: "想玩的、在玩的、通关的都记一下。",
    fields: [
      { name: "name", label: "游戏名称", kind: "text", required: true, maxlength: 80,
        placeholder: "游戏名…" },
      { name: "platform", label: "平台", kind: "select", list: GAME_PLATFORMS,
        half: true, blank: "不填", default: "PC" },
      { name: "status", label: "状态", kind: "select", list: GAME_STATUSES,
        half: true, default: "想玩" },
      { name: "hours", label: "游玩时长（小时）", kind: "number", min: 0, step: 1,
        placeholder: "比如 42" },
      { name: "progress", label: "进度备注", kind: "textarea", rows: 3, maxlength: 400,
        placeholder: "打到哪儿了、卡在哪儿（可不填）" },
    ],
    label: (row) => row.name || "（没写名字）",
    create: (ctx) => ({
      id: ctx.uid(), name: "", platform: "PC", status: "想玩", hours: 0, progress: "",
    }),
  },

  /* 模块目标（健身 / 学习 / 饮食）：没有图片区，也不是「往某张表 push 一条」——
   * 它按模块分桶存在 data.moduleGoals[moduleId] 里，所以下面自己写了
   * persist（怎么落盘）和 trashPlan（怎么移出）。两个钩子是 item-dialog.js 认的。 */
  moduleGoal: {
    table: "moduleGoals",
    titleNew: "设置模块目标",
    titleEdit: "修改模块目标",
    hint: "目标写在模块里，不跟待办混在一起；开着「自动生成任务」时，到点会自动往「今日计划」里放待办。",
    fields: [
      { name: "moduleName", label: "所属模块", kind: "static" },
      { name: "mainTarget", label: "核心目标", kind: "textarea", rows: 3, maxlength: 400,
        required: true, placeholder: "比如：3 个月减重 8kg，每周力量 3 次、有氧 2 次" },
      { name: "cycle", label: "目标周期", kind: "select", list: GOAL_CYCLES, default: "每日" },
      { name: "startDate", label: "开始日期", kind: "date", half: true },
      { name: "endDate", label: "结束日期", kind: "date", half: true },
      { name: "dailyRule", label: "自动任务规则", kind: "textarea", rows: 3, maxlength: 400,
        placeholder: "比如：每周一、三、五力量训练；周二、四有氧" },
      { name: "remark", label: "备注", kind: "textarea", rows: 2, maxlength: 400,
        placeholder: "想提醒自己的话（可不填）" },
      { name: "isActive", label: "启用目标", kind: "switch", half: true, default: "on" },
      { name: "autoTask", label: "自动生成任务", kind: "switch", half: true, default: "on" },
    ],
    label: (row) => row.mainTarget || "（没写目标）",
    create: (ctx) => ({
      id: ctx.uid(),
      moduleId: ctx.moduleId || "",
      moduleName: ctx.moduleName || "",
      mainTarget: "",
      cycle: "每日",
      startDate: ctx.date || "",
      endDate: "",
      dailyRule: "",
      remark: "",
      isActive: true,
      autoTask: true,
      lastRun: "",
    }),
    persist: (ctx, saved, created) => {
      if (created) (ctx.goals || []).push(saved);
    },
    trashPlan: (row) => ({
      label: row.mainTarget || "（没写目标）",
      extra: 0,
      items: [],
      note: "只删除目标设置；已经生成的待办会留在「今日计划」里，不会跟着消失。",
      apply: () => {},   // 真正从桶里摘掉由调用方做（见 goals.js 的 deleteGoal）
    }),
  },
};

export const ITEM_TYPES = Object.keys(FORMS);

export function formOf(type) {
  const spec = FORMS[type];
  if (!spec) throw new Error("没有这个弹窗类型：" + type);
  return spec;
}

/* ---------------- 选项 ---------------- */

/** 一个下拉的选项列表：[{ value, label }] */
export function optionsOf(field, ctx = {}) {
  if (field.source) {
    const list = (ctx[field.source] || []).map((o) =>
      Array.isArray(o) ? { value: String(o[0]), label: String(o[1]) } : o
    );
    if (list.length) return list;
    // 一个都没有的时候给一条占位，免得下拉是空的、看着像坏了
    return [{ value: "", label: "（还没有可选的对象）" }];
  }
  const list = (field.list || []).map((v) => ({ value: String(v), label: String(v) }));
  if (field.blank) list.unshift({ value: "", label: field.blank });
  return list;
}

/* ---------------- 画 ---------------- */

function fieldHtml(field, values, ctx) {
  const id = "item-" + field.name;
  const value = values[field.name] == null ? "" : String(values[field.name]);
  // 只读的一行（比如目标的「所属模块」）：不进表单，只看
  if (field.kind === "static") {
    return (
      `<label class="dlg-label">${esc(field.label)}</label>` +
      `<div class="dlg-static" id="${id}">${esc(value || "—")}</div>`
    );
  }
  // 开关：标签跟框并排，勾上 = on
  if (field.kind === "switch") {
    const on = ["on", "true", "1", "yes"].includes(value.toLowerCase());
    return (
      `<label class="dlg-switch" for="${id}">` +
      `<input type="checkbox" id="${id}"${on ? " checked" : ""}>` +
      `<span>${esc(field.label)}</span></label>`
    );
  }
  const label = `<label class="dlg-label" for="${id}">${esc(field.label)}</label>`;
  if (field.kind === "textarea") {
    return (
      label +
      `<textarea id="${id}" rows="${field.rows || 4}" maxlength="${field.maxlength || 1200}"` +
      ` placeholder="${esc(field.placeholder || "")}">${esc(value)}</textarea>`
    );
  }
  if (field.kind === "select") {
    const opts = optionsOf(field, ctx)
      .map(
        (o) =>
          `<option value="${esc(o.value)}"${o.value === value ? " selected" : ""}>${esc(o.label)}</option>`
      )
      .join("");
    return `${label}<select id="${id}">${opts}</select>`;
  }
  const attrs = [];
  if (field.kind === "number") {
    attrs.push('type="number"', `min="${field.min == null ? 0 : field.min}"`);
    if (field.step) attrs.push(`step="${field.step}"`);
  } else if (field.kind === "date") {
    attrs.push('type="date"');
  } else if (field.kind === "time") {
    attrs.push('type="time"');
  } else {
    attrs.push('type="text"', `maxlength="${field.maxlength || 200}"`);
  }
  if (field.placeholder) attrs.push(`placeholder="${esc(field.placeholder)}"`);
  return `${label}<input id="${id}" ${attrs.join(" ")} value="${esc(value)}">`;
}

/** 把一张字段表画成弹窗里的那段 HTML；连续两个 half 字段并排一行 */
export function formHtml(type, values = {}, ctx = {}) {
  const spec = formOf(type);
  const out = [];
  let pair = [];
  const flush = () => {
    if (!pair.length) return;
    out.push(`<div class="dlg-two">${pair.map((f) => `<div>${fieldHtml(f, values, ctx)}</div>`).join("")}</div>`);
    pair = [];
  };
  for (const field of spec.fields) {
    if (field.half) {
      pair.push(field);
      if (pair.length === 2) flush();
      continue;
    }
    flush();
    out.push(fieldHtml(field, values, ctx));
  }
  flush();
  return out.join("");
}

/* ---------------- 读、校验、写回 ---------------- */

/** 新增时的初始值：字段自己的 default，再被 extra 盖掉 */
export function defaultsOf(type, extra = {}) {
  const out = {};
  for (const field of formOf(type).fields) {
    out[field.name] = field.kind === "static" ? "" : field.default ?? "";
  }
  return { ...out, ...extra };
}

/** 编辑时的初始值：记录里有就用记录里的，没有就用默认值 */
export function valuesOf(type, row, extra = {}) {
  const out = defaultsOf(type, extra);
  const src = row && typeof row === "object" ? row : {};
  for (const field of formOf(type).fields) {
    if (field.kind === "static") continue;   // 只看不改的字段不用回填
    const v = src[field.name];
    if (v === undefined || v === null || v === "") continue;
    // 数字字段是 0（时长、小时数没填）就当没填，框里留空让占位提示露出来
    if (field.kind === "number" && Number(v) === 0) continue;
    out[field.name] = String(v);
  }
  return out;
}

/** 从表单里把值读出来。get(name) 由调用方提供（浏览器里就是读那个 input） */
export function readValues(type, get) {
  const out = {};
  for (const field of formOf(type).fields) {
    if (field.kind === "static") continue;
    const v = get(field.name);
    out[field.name] = v === undefined || v === null ? "" : String(v);
  }
  return out;
}

/** 校验：必填 + 「这几项至少写一个」。过不了就带一句人话出来。 */
export function validate(type, values) {
  const spec = formOf(type);
  for (const field of spec.fields) {
    if (field.required && !String(values[field.name] || "").trim()) {
      return { ok: false, error: `「${field.label}」不能是空的` };
    }
  }
  if (spec.requireAny) {
    const filled = spec.requireAny.some((name) => String(values[name] || "").trim());
    if (!filled) return { ok: false, error: spec.requireAnyError || "还有内容没填" };
  }
  return { ok: true, error: "" };
}

/** 把表单值写回一条记录：数字转数字、开关转布尔、文本去掉两头空白 */
export function applyValues(type, row, values) {
  for (const field of formOf(type).fields) {
    if (field.kind === "static") continue;   // 只读字段不回写，免得把它冲成空
    const raw = String(values[field.name] ?? "").trim();
    if (field.kind === "switch") row[field.name] = Boolean(raw) && raw !== "off";
    else row[field.name] = field.kind === "number" ? Number(raw) || 0 : raw;
  }
  return row;
}

/** 新增：先照 create() 捏一个空壳，再把表单值写上去 */
export function newRow(type, values, ctx = {}) {
  const spec = formOf(type);
  const row = spec.create(ctx) || {};
  applyValues(type, row, values);
  if (spec.upload) row.imagePaths = [];   // 有图片区的类型才带 imagePaths
  return row;
}

/**
 * 删一条要动哪些表：先写清楚，交给调用方去执行（这里保持纯函数）。
 * 两处会「连带」：删学习对象带走它的学习记录；删项目带走它的待办、问题和进展。
 */
export function trashPlan(type, row, rowsByTable = {}) {
  const spec = formOf(type);
  // 有些类型不在普通表里（模块目标按模块分桶存），自己给一份删除计划
  if (typeof spec.trashPlan === "function") return spec.trashPlan(row, rowsByTable);
  const label = spec.label(row);
  const items = [{ table: spec.table, row, label }];
  if (type === "studyItem") {
    for (const child of rowsByTable.studies || []) {
      if (child && child.subjectId === row.id) {
        items.push({ table: "studies", row: child, label: child.content || child.takeaway || "" });
      }
    }
  }
  if (type === "devProject") {
    // 待办是靠 belong 指过来的（"dev:<项目 id>"），问题和进展是靠 projectId
    for (const child of rowsByTable.tasks || []) {
      if (child && child.belong === "dev:" + row.id) {
        items.push({ table: "tasks", row: child, label: child.text || "" });
      }
    }
    for (const child of rowsByTable.issues || []) {
      if (child && child.projectId === row.id) {
        items.push({ table: "issues", row: child, label: child.title || "" });
      }
    }
    for (const child of rowsByTable.progress || []) {
      if (child && child.projectId === row.id) {
        items.push({ table: "progress", row: child, label: child.text || "" });
      }
    }
  }
  return { label, items, extra: items.length - 1 };
}

/** 记录上存着的图片路径（列表上那个小图标用） */
export function imagesOf(row) {
  return rowPaths(row);
}
