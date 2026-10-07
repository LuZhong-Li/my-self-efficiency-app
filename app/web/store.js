/* 数据层：整份读进来、整份写回去，改完自动保存到 数据\数据.json
 *
 * 设计取舍：个人自用、数据量小，所以不做增量接口——内存里拿一份完整数据，
 * 任何修改都整份写回。这样前端每个模块只需要「改内存 + 标记要保存」两件事，
 * 不用为每个字段写接口。
 */

import { normalizeHomeView, normalizeMemoCollapsed } from "./home-view.js";

const changeHandlers = [];
const statusHandlers = [];

export const store = {
  data: null,
  loaded: false,
  saving: false,
  pendingSave: false,
  dirty: false,   // 有改动还没落盘
  pendingForm: false, // 有表单填了一半还没提交（关窗口前要提醒）
  timer: null,
  lastSavedAt: null,
};

export function onChange(fn) {
  changeHandlers.push(fn);
}

export function onStatus(fn) {
  statusHandlers.push(fn);
}

function emitChange() {
  for (const fn of changeHandlers) fn();
}

export function setStatus(text, kind) {
  for (const fn of statusHandlers) fn(text, kind);
}

/* ---------------- 读 ---------------- */

export async function initStore() {
  setupChannel();
  return readFromDisk();
}

export async function readFromDisk() {
  setStatus("正在从磁盘读取…");
  try {
    const res = await fetch("/api/data", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    store.data = await res.json();
    store.loaded = true;
    applyTheme(themeOf());
    applySkin(skinOf());
    emitChange();
    setStatus("已连接 · 数据读取正常", "ok");
  } catch (err) {
    setStatus("连不上服务：" + err.message, "err");
    throw err;
  }
  return store.data;
}

/* ---------------- 写 ---------------- */

/**
 * 改完数据后叫一声，就自动保存。
 * @param {boolean} immediate 立刻保存（增/删/改这类明确动作），
 *                            否则等 400ms（连续输入时不会写十几次盘）。
 * @param {boolean} silent 只保存、不重画界面。正在输入框里打字时必须用它，
 *                         否则重画会把输入框换掉，光标和已输入的内容会跳。
 */
export function touch(immediate = false, silent = false) {
  if (!store.data) return Promise.resolve();
  if (!silent) emitChange();
  store.dirty = true;
  clearTimeout(store.timer);
  if (immediate) {
    return saveNow();
  }
  setStatus("正在保存…");
  store.timer = setTimeout(saveNow, 400);
  return Promise.resolve();
}

async function saveNow() {
  if (!store.data) return;
  if (store.saving) {
    store.pendingSave = true;
    return;
  }
  store.saving = true;
  try {
    const res = await fetch("/api/data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(store.data),
    });
    const body = await res.json().catch(() => ({}));

    // 409：另一个窗口在我们读取之后先写过了。别覆盖它，重新读一份。
    if (res.status === 409 && body.conflict) {
      store.dirty = false;
      await readFromDisk();
      setStatus("另一个窗口刚改过数据，已重新载入", "err");
      return;
    }
    if (!res.ok || !body.ok) throw new Error(body.error || ("HTTP " + res.status));
    if (typeof body.rev === "number") store.data.rev = body.rev;
    store.dirty = false;
    store.lastSavedAt = body.savedAt;
    setStatus("已保存 · " + body.savedAt, "ok");
    broadcast({ type: "saved", rev: store.data.rev });
  } catch (err) {
    setStatus("保存失败：" + err.message, "err");
  } finally {
    store.saving = false;
    if (store.pendingSave) {
      store.pendingSave = false;
      saveNow();
    }
  }
}

window.addEventListener("beforeunload", (e) => {
  if (store.saving || store.dirty || store.pendingForm) {
    e.preventDefault();
    e.returnValue = "";
  }
});

/** 表单填了一半（没点保存/添加）时打个标记，关窗口前会提醒一句 */
export function markPendingForm(on) {
  const next = Boolean(on);
  if (store.pendingForm === next) return;
  store.pendingForm = next;
  if (next) setStatus("有还没保存的改动（记得点保存）", "err");
  else setStatus("已连接 · 数据读取正常", "ok");
}

// 这些字段是「停笔即存」的，不用算进「没保存的改动」里
const AUTOSAVE_FIELDS =
  "#memo, [data-slot], [data-day], #slogan, #keep-input, #project-filter, #project-status-filter, " +
  "#budget-input, #media-filter, #media-cal-platform, #media-list-platform, #media-list-status, " +
  "#media-list-sort";

document.addEventListener(
  "input",
  (e) => {
    const el = e.target;
    if (!el || !el.matches || !el.closest("main")) return;
    if (el.matches(AUTOSAVE_FIELDS)) return;
    if (el.matches("input, textarea, select")) markPendingForm(true);
  },
  true
);

// 提交表单、或点了任何带 data-act 的按钮（保存/取消/删除…），就不再算「没保存」
document.addEventListener("submit", () => markPendingForm(false), true);
document.addEventListener(
  "click",
  (e) => {
    if (e.target.closest("[data-act]")) markPendingForm(false);
  },
  true
);

/* ---------------- 多个窗口之间同步 ----------------
 * 双击两次启动文件会开两个标签页，两边各拿一份数据。用浏览器自带的
 * BroadcastChannel 让它们互相知会一声，免得你在这边改了、那边还显示旧的。 */

let channel = null;

function setupChannel() {
  if (channel || typeof BroadcastChannel !== "function") return;
  try {
    channel = new BroadcastChannel("xiaoli");
    channel.onmessage = async (e) => {
      const msg = e.data || {};
      if (msg.type !== "saved") return;
      if (msg.rev === (store.data && store.data.rev)) return;
      if (store.dirty) {
        setStatus("另一个窗口改了数据，你这边还有没保存的改动，刷新一下更稳妥", "err");
        return;
      }
      await readFromDisk();
      setStatus("另一个窗口保存了数据，已经同步过来", "ok");
    };
  } catch {
    channel = null;
  }
}

function broadcast(msg) {
  try {
    if (channel) channel.postMessage(msg);
  } catch {
    /* 通道不可用就算了，不影响保存 */
  }
}

/* ---------------- 回收站 ----------------
 * 删除不直接抹掉，先挪进回收站：误删了能从「数据与设置」里捞回来。
 * 回收站最多留 200 条，再多就把最旧的挤出去。 */

const TRASH_MAX = 200;

export function trash() {
  if (!store.data) return [];
  if (!Array.isArray(store.data.trash)) store.data.trash = [];
  return store.data.trash;
}

/** 把一条记录从它那张表里挪进回收站（只管改内存，保存由调用方 touch） */
export function moveToTrash(tableName, row, label) {
  const rows = table(tableName);
  const index = rows.indexOf(row);
  if (index >= 0) rows.splice(index, 1);
  const labelText =
    label || row.text || row.name || row.title || row.moves || row.topic || "(没写内容)";
  trash().unshift({
    id: uid(),
    table: tableName,
    label: String(labelText).slice(0, 80),
    deletedAt: nowText(), // 本地时间，和别处显示的格式一致
    row,
  });
  const list = trash();
  while (list.length > TRASH_MAX) list.pop();
}

/** 从回收站放回原来的表（原来那条要是还在，就不重复放） */
export function restoreFromTrash(entry) {
  const rows = table(entry.table);
  if (!rows.some((r) => r && r.id === entry.row.id)) rows.push(entry.row);
  const list = trash();
  const index = list.indexOf(entry);
  if (index >= 0) list.splice(index, 1);
}

export function dropFromTrash(entry) {
  const list = trash();
  const index = list.indexOf(entry);
  if (index >= 0) list.splice(index, 1);
}

export function emptyTrash() {
  store.data.trash = [];
}

/** 回收站里那条属于哪个模块，显示用 */
export const TRASH_TABLE_LABEL = {
  tasks: "任务",
  contents: "自媒体",
  mediaAccounts: "自媒体账号",
  mediaFollowers: "粉丝记录",
  projects: "项目",
  issues: "问题",
  progress: "进展",
  subjects: "学习对象",
  studies: "学习记录",
  workoutLogs: "训练打卡",
  weights: "体重记录",
  meals: "饮食记录",
  water: "饮水记录",
  games: "游戏",
  "finance.transactions": "账目",
  "finance.accounts": "账户",
  "debt.items": "债务",
};

/* ---------------- 小工具 ---------------- */

export function uid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

/** 本地时间文本：2026-10-06 18:18（不要用 toISOString，那是 UTC，晚上会差一天） */
export function nowText() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ---------------- 主题 ---------------- */

export function themeOf() {
  const t = store.data && store.data.settings && store.data.settings.theme;
  return t === "dark" ? "dark" : "light";
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === "dark" ? "dark" : "light";
}

export function setTheme(theme) {
  if (!store.data) return;
  if (!store.data.settings) store.data.settings = {};
  store.data.settings.theme = theme === "dark" ? "dark" : "light";
  applyTheme(store.data.settings.theme);
  touch(true);
}

/* ---------------- 皮肤（外观）----------------
 * 和明暗无关：skin 决定长相（极简 / 笔记 / 粗野），theme 决定亮还是暗。 */

const SKINS = ["glass", "default", "notebook", "neo"];

export function skinOf() {
  const s = store.data && store.data.settings && store.data.settings.skin;
  return SKINS.includes(s) ? s : "glass"; // 没设置过就用液态玻璃
}

export function applySkin(skin) {
  const value = SKINS.includes(skin) ? skin : "glass";
  if (value === "default") document.documentElement.removeAttribute("data-skin");
  else document.documentElement.dataset.skin = value;
}

export function setSkin(skin) {
  if (!store.data) return;
  if (!store.data.settings) store.data.settings = {};
  store.data.settings.skin = SKINS.includes(skin) ? skin : "glass";
  applySkin(store.data.settings.skin);
  touch(true);
}

/* ---------------- 首页视图（简洁 / 完整） ----------------
 * 和主题、皮肤一样存在 settings 里，不用 localStorage：
 * 换数据文件跟着走，两个窗口开着也会同步过去（走的是同一套保存机制）。 */

export function homeViewOf() {
  const settings = (store.data && store.data.settings) || {};
  return normalizeHomeView(settings.homeView);
}

export function setHomeView(view) {
  if (!store.data) return;
  if (!store.data.settings) store.data.settings = {};
  store.data.settings.homeView = normalizeHomeView(view);
  touch(true);
}

/* 快速备忘的收起状态：和视图选择一样存进 settings，刷新、换窗口都记得 */

export function memoCollapsedOf() {
  const settings = (store.data && store.data.settings) || {};
  return normalizeMemoCollapsed(settings.memoCollapsed);
}

export function setMemoCollapsed(collapsed) {
  if (!store.data) return;
  if (!store.data.settings) store.data.settings = {};
  store.data.settings.memoCollapsed = normalizeMemoCollapsed(collapsed);
  touch(true);
}

/** 本地时区的 YYYY-MM-DD，不能用 toISOString（那是 UTC，晚上会差一天） */
export function dateStr(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return date.getFullYear() + "-" + p(date.getMonth() + 1) + "-" + p(date.getDate());
}

export function todayStr() {
  return dateStr();
}

export function shiftDate(str, days) {
  const [y, m, d] = str.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return dateStr(dt);
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

export function formatDateCN(str) {
  const [y, m, d] = str.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return `${y}年${m}月${d}日 星期${WEEKDAYS[dt.getDay()]}`;
}

/** 取某张表，顺便容忍老数据里没有这个键的情况。
 *  支持 "finance.transactions" 这种带点的路径——记账的数据嵌在一个
 *  finance 键里（模块的数据归模块），但回收站、搜索这些通用零件只认
 *  一个表名，所以在这一层把路径打通，别的代码就不用知道它是嵌套的。 */
export function table(key) {
  if (!store.data) return [];
  const parts = String(key).split(".");
  let holder = store.data;
  for (const part of parts.slice(0, -1)) {
    if (typeof holder[part] !== "object" || holder[part] === null) holder[part] = {};
    holder = holder[part];
  }
  const last = parts[parts.length - 1];
  if (!Array.isArray(holder[last])) holder[last] = [];
  return holder[last];
}

/** 把用户输入塞进 HTML 之前先转义，避免内容里的尖括号把页面搞乱 */
export function esc(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
