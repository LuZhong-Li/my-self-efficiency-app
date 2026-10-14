/* 通用的「新增 / 编辑」弹窗 —— 今日计划、开发待办、学习记录、学习对象、
 * 训练打卡、游戏六处共用这一个。
 *
 * 分工：
 *   · 有哪些字段、怎么画、怎么读、怎么校验、怎么写回记录 → item-form.js（纯逻辑）
 *   · 摆进弹窗、处理图片、删除、落盘 → 就是这个文件
 *   · 图片上传 / 预览 / 查看 → attachment.js（和记账、bug 登记同一套）
 *
 * 规矩和「记一笔」完全一致：Esc 关、点遮罩关、回车保存、Tab 在弹窗里绕圈；
 * 图片点「保存」才真的写进 数据\attachments\<模块>\，点「取消」一个字节都不留。
 */

import { touch, uid, table, nowText, todayStr, moveToTrash, store, esc } from "./store.js";
import { openDialog, askConfirm, toast } from "./dialog.js";
import { allTags } from "./search-calc.js";
import { normalizeTags, tagColor, tagInputError, TAG_LIMIT } from "./tag-calc.js";
import {
  createAttach, mountAttach, disposeAttach, uploadPending, commitUploads,
  purgeRowAttachments, rowPaths,
} from "./attachment.js";
import {
  formOf, formHtml, defaultsOf, valuesOf, readValues, validate, applyValues,
  newRow, trashPlan, parseSubtaskJson, SUBTASK_LIMIT, repeatRuleError,
} from "./item-form.js";
import { ruleSummary } from "./goal-calc.js";

/** 一条记录的删除计划（把要看的几张表读出来交给纯函数算） */
function planOf(type, row, ctx = {}) {
  return trashPlan(type, row, {
    studies: table("studies"),
    tasks: table("tasks"),
    issues: table("issues"),
    progress: table("progress"),
  }, ctx);
}

/**
 * 把一条记录按它自己的「连带规则」挪进回收站：
 * 删学习对象带走它的学习记录，删项目带走它的待办、问题、进展。
 * 弹窗里的「删除」和页面上那个删除按钮都走这里，免得两处各写一遍。
 */
export function trashItem(type, row) {
  const plan = planOf(type, row);
  for (const item of plan.items) moveToTrash(item.table, item.row, item.label);
  return plan;
}

/** 存一条：默认往它那张表 push；类型自己写了 persist 的（比如模块目标按桶存）就交给它 */
function persistRow(spec, ctx, saved, created) {
  if (typeof spec.persist === "function") spec.persist(ctx, saved, created);
  else if (created) table(spec.table).push(saved);
}

/**
 * 打开一个新增 / 编辑弹窗。
 *
 * @param {string} type    item-form.js 里的类型名（todayPlan / devTodo / …）
 * @param {object|null} row 编辑时传那条记录；新增传 null
 * @param {{date?: string, pid?: string, ctx?: object,
 *          extraHtml?: string,
 *          extraButtons?: {id: string, label: string}[],
 *          onExtraAction?: (id: string, el: HTMLElement) => (boolean | void),
 *          onSaved?: (row: object, created: boolean) => void}} options
 *        date  —— 从某一天点「添加」时的默认日期
 *        pid   —— 项目 id（开发待办要）
 *        ctx   —— 下拉的动态选项，比如 { subjects: [[id, 名称], …] }
 *        extraHtml / extraButtons / onExtraAction
 *              —— 编辑时额外加的一段说明和几个按钮（开发待办的「归档」就是这么进来的，
 *                 没有新开一种弹窗）。onExtraAction 返回 false 表示弹窗继续开着。
 *        onSaved —— 存完之后叫一下，让调用方跟着切日期 / 重画
 * @returns {{ el: HTMLElement, close: () => void }}
 */
export function openItemDialog(type, row, options = {}) {
  const spec = formOf(type);
  const editing = Boolean(row);
  const extraButtons = Array.isArray(options.extraButtons) ? options.extraButtons : [];
  const ctx = {
    uid,
    nowIso: () => new Date().toISOString(),
    nowText,
    date: options.date || todayStr(),
    pid: options.pid || "",
    ...(options.ctx || {}),
  };
  // 标签的候选：全站已经出现过的标签，打开弹窗时现算（不落盘）。
  // 有它才能「打个字就把以前用过的标签补出来」，不用记着自己起过什么名。
  if (spec.fields.some((f) => f.kind === "tags")) {
    ctx.tagOptions = allTags(store.data).map((t) => t.name);
  }
  // 从「某一天」点进来的（今日计划、学习记录、训练打卡、游玩记录），那一天的日期要预填上。
  // 字段名默认叫 date，游玩记录那边叫 playDate，所以让字段表自己声明（spec.dateField）。
  const seed = { ...options.defaults };
  const dateField = spec.dateField || "date";
  if (options.date && spec.fields.some((f) => f.name === dateField) && !seed[dateField]) {
    seed[dateField] = options.date;
  }
  const values = editing ? valuesOf(type, row, seed) : defaultsOf(type, seed);
  // 不是每种弹窗都要图片区（模块目标就没有），没有 upload 就不装配件
  const attach = spec.upload
    ? createAttach({ module: spec.upload, paths: editing ? rowPaths(row) : [] })
    : null;

  const dlg = openDialog({
    title: editing ? spec.titleEdit : spec.titleNew,
    bodyHtml: `
      ${spec.hint ? `<p class="dlg-hint">${spec.hint}</p>` : ""}
      <div class="dlg-fields">${formHtml(type, values, ctx)}</div>
      ${options.extraHtml || ""}
      ${attach ? `<div class="attach-host" id="item-attach"></div>` : ""}`,
    buttons: [
      ...(editing ? [{ id: "delete", label: "删除", kind: "danger" }] : []),
      ...extraButtons,
      { id: "cancel", label: "取消" },
      { id: "save", label: "保存", kind: "primary" },
    ],
    onClose: () => { if (attach) disposeAttach(attach); },
    onAction: (act, el) => {
      if (act === "cancel") return true;

      if (extraButtons.some((b) => b.id === act)) {
        return typeof options.onExtraAction === "function"
          ? options.onExtraAction(act, el)
          : true;
      }

      if (act === "delete") {
        // 先想清楚要动哪几张表（包括「删项目要连待办 / 问题 / 进展一起走」这种）
        const plan = planOf(type, row, ctx);
        (async () => {
          const ok = await askConfirm({
            title: `删除「${plan.label}」？`,
            message: plan.note ||
              (plan.extra
                ? `它的 ${plan.extra} ${spec.extraNote || "条内容"}也一起进回收站，` +
                  "误删可以去「数据与设置」找回。"
                : "会放进回收站，误删可以去「数据与设置」找回。"),
            confirmLabel: "删除",
            danger: true,
          });
          if (!ok) return;
          if (typeof plan.apply === "function") plan.apply();
          else for (const item of plan.items) moveToTrash(item.table, item.row, item.label);
          touch(true);
          dlg.close();
          toast(typeof plan.apply === "function" ? "已删除" : "已移入回收站");
          if (typeof options.onDeleted === "function") options.onDeleted(row);
        })();
        return false;   // 确认框接管了这里，别把弹窗先关了
      }

      if (act !== "save") return;
      // 保存分两步（先写图片、再动 JSON），异步的，所以先留住弹窗、做完再自己关
      (async () => {
        const form = readValues(type, (name) => {
          const input = el.querySelector("#item-" + name);
          if (!input) return "";
          return input.type === "checkbox" ? (input.checked ? "on" : "") : input.value;
        });
        const check = validate(type, form);
        if (!check.ok) {
          toast(check.error, "err");
          return;
        }
        let uploaded = [];
        if (attach) {
          try {
            uploaded = await uploadPending(attach);
          } catch (err) {
            toast("图片没存下：" + err.message, "err");
            return;
          }
          commitUploads(attach, uploaded);
        }
        const imagePaths = attach ? attach.paths.slice() : [];
        const saved = editing ? row : newRow(type, form, ctx);
        const before = editing ? rowPaths(row) : [];
        applyValues(type, saved, form, ctx);
        if (attach) saved.imagePaths = imagePaths;
        persistRow(spec, ctx, saved, !editing);
        touch(true);
        dlg.close();
        toast(editing ? "已保存" : "已添加");
        if (typeof options.onSaved === "function") options.onSaved(saved, !editing);
        const removed = before.filter((p) => !imagePaths.includes(p));
        if (removed.length) purgeRowAttachments({ imagePaths: removed });
      })();
      return false;
    },
  });

  if (attach) mountAttach(dlg.el.querySelector("#item-attach"), attach);
  bindConditionalFields(dlg.el, spec);
  bindTagPreview(dlg.el, spec);
  bindSubtasks(dlg.el, spec);
  bindRulePreview(dlg.el, spec);
  bindEnterToSave(dlg);
  const first = spec.fields.find((f) => f.kind !== "static");   // 只读那行不抢焦点
  if (first) setTimeout(() => dlg.el.querySelector("#item-" + first.name)?.focus(), 0);
  return dlg;
}

/**
 * 字段表里声明了 showWhen 的字段，跟着另一个下拉的当前值显隐。
 * 比如游戏清单里「通关日期」只在状态 = 已通关时才露出来：切下拉立刻显 / 隐，
 * 不用重画弹窗（重画会把已经填了一半的内容弄丢）。
 */
function bindConditionalFields(el, spec) {
  for (const field of spec.fields) {
    const rule = field.showWhen;
    if (!rule) continue;
    const box = el.querySelector(`[data-field="${field.name}"]`);
    const src = el.querySelector("#item-" + rule.field);
    if (!box || !src) continue;
    const sync = () => {
      box.hidden = src.value !== rule.equals;
    };
    src.addEventListener("change", sync);
    sync();
  }
}

/**
 * 标签输入框下面那行实时预览：边打边看「现在收成了哪几个标签」，
 * 顺手把「超量 / 单个太长」当场说出来（保存时 validate 还会再拦一道）。
 * 只改这一小块，不重画弹窗 —— 重画会把已经填了一半的内容弄丢。
 */
function bindTagPreview(el, spec) {
  for (const field of spec.fields.filter((f) => f.kind === "tags")) {
    const input = el.querySelector("#item-" + field.name);
    const box = el.querySelector(`[data-tags-preview="${field.name}"]`);
    if (!input || !box) continue;
    const sync = () => {
      const list = normalizeTags(input.value);
      const err = tagInputError(input.value);
      box.classList.toggle("over", Boolean(err));
      box.innerHTML =
        (list.length
          ? list
              .map((name) =>
                `<span class="chip tag-chip" data-c="${tagColor(name)}">${esc(name)}</span>`)
              .join("")
          : `<span class="dlg-tags-hint">逗号分开，最多 ${TAG_LIMIT} 个</span>`) +
        (err ? `<span class="dlg-tags-err">${esc(err)}</span>` : "");
    };
    input.addEventListener("input", sync);
    sync();          // 编辑老记录时进来就先把已有的标签画出来
  }
}

/**
 * 子任务清单那一小块：加一条、删一条、勾一条，全在这儿。
 *
 * 值和别处一样还是从表单走（kind: "subtasks" 读写的是一条隐藏 input 里的 JSON），
 * 所以这里只管把界面上的清单和那条隐藏 input 对齐 —— 校验、写回记录一个字都不重复。
 */
function bindSubtasks(el, spec) {
  for (const field of spec.fields.filter((f) => f.kind === "subtasks")) {
    const host = el.querySelector(`[data-subtasks="${field.name}"]`);
    if (!host) continue;
    const hidden = host.querySelector("#item-" + field.name);
    const listEl = host.querySelector(".sub-list");
    const input = host.querySelector(".sub-input");
    const hint = host.querySelector("[data-sub-hint]");
    if (!hidden || !listEl || !input || !hint) continue;

    const read = () => parseSubtaskJson(hidden.value);
    const draw = (list) => {
      listEl.innerHTML = list.length
        ? list
            .map(
              (s, i) =>
                `<li class="subtask${s.done ? " done" : ""}" data-i="${i}">` +
                  `<label class="check" title="这条做完了没">` +
                  `<input type="checkbox" data-sub-check${s.done ? " checked" : ""}></label>` +
                  `<span class="sub-text">${esc(s.text)}</span>` +
                  `<button type="button" class="link danger" data-sub-del>删除</button>` +
                `</li>`
            )
            .join("")
        : `<li class="sub-empty">还没加子任务</li>`;
      hint.textContent = list.length
        ? `${list.filter((s) => s.done).length} / ${list.length} 条已完成`
        : `最多 ${SUBTASK_LIMIT} 条`;
    };
    const write = (list) => {
      hidden.value = JSON.stringify(list);
      draw(list);
    };
    const addOne = () => {
      const text = String(input.value || "").trim();
      if (!text) return;
      const list = read();
      if (list.length >= SUBTASK_LIMIT) {
        hint.textContent = `最多 ${SUBTASK_LIMIT} 条，加不下了`;
        return;
      }
      list.push({ id: uid(), text, done: false });   // id 在这儿发：列表上那个勾选框靠它认人
      input.value = "";
      write(list);
      input.focus();
    };

    host.addEventListener("click", (e) => {
      const del = e.target.closest("[data-sub-del]");
      if (del) {
        const li = del.closest("[data-i]");
        const list = read();
        if (li) list.splice(Number(li.dataset.i), 1);
        write(list);
        return;
      }
      if (e.target.closest("[data-sub-add]")) addOne();
    });
    host.addEventListener("change", (e) => {
      const box = e.target.closest("[data-sub-check]");
      if (!box) return;
      const li = box.closest("[data-i]");
      const list = read();
      const item = li ? list[Number(li.dataset.i)] : null;
      if (item) item.done = box.checked;
      write(list);
    });
    // 回车在这儿是「加下一条」，所以得拦下来别让它冒到弹窗那层（那边回车 = 保存）；
    // 和备注那种多行输入一个规矩：正在加清单的时候回车不做保存。
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      e.stopPropagation();
      addOne();
    });
    draw(read());   // 编辑老记录时进来就把已有的清单画出来
  }
}

/**
 * 重复规则下面那行实时预览：边打边看这句话翻译成「什么时候」，
 * 顺手把「没写出哪几天」当场说出来（保存时 validate 还会再拦一道）。
 * 只改这一小块，不重画弹窗 —— 重画会把已经填了一半的内容弄丢。
 */
function bindRulePreview(el, spec) {
  for (const field of spec.fields.filter((f) => f.kind === "rule")) {
    const input = el.querySelector("#item-" + field.name);
    const box = el.querySelector(`[data-rule-preview="${field.name}"]`);
    if (!input || !box) continue;
    const sync = () => {
      const text = String(input.value || "").trim();
      if (!text) {
        box.innerHTML = `<span class="dlg-tags-hint">写一句「什么时候做」，比如：每周一、三、五</span>`;
        return;
      }
      const err = repeatRuleError(text);
      box.innerHTML = err
        ? `<span class="dlg-tags-err">${esc(err)}</span>`
        : `<span class="dlg-rule-ok">到那天会生成：${esc(ruleSummary(text, {}))}</span>`;
    };
    input.addEventListener("input", sync);
    sync();          // 编辑老规则时进来就先把这句话翻译一遍
  }
}

/** 回车 = 保存。只在输入框 / 下拉里按回车才算（多行描述里回车要能换行）。 */
function bindEnterToSave(dlg) {
  dlg.el.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const tag = e.target.tagName;
    if (tag !== "INPUT" && tag !== "SELECT") return;
    e.preventDefault();
    dlg.el.querySelector('[data-dlg-act="save"]')?.click();
  });
}
