/* 图片附件：上传 / 预览 / 单独移除 / 全屏查看，记账、bug 登记、笔记三个模块共用这一套。
 *
 * 为什么图片不进主数据文件：
 *   1. base64 塞进 JSON 会让它膨胀三分之一还多，数据文件就不「一眼看得懂」了；
 *   2. 备份逻辑现在是「整个 数据 目录复制走」，图片放在 数据\attachments\ 里
 *      跟着一起走，一行都不用改；
 *   3. 图片坏没坏、丢没丢是文件的事，不该连累整份数据读不出来。
 *
 * 三条交互上的约定：
 *   · 选中的图先在内存里（blob + 预览地址），点「保存」才真的写到磁盘 ——
 *     点「取消」什么都不会留下，不会攒一堆没人认领的图片；
 *   · 写盘和 JSON 保存的顺序是「先写图片，再存 JSON」，和原来的落盘逻辑一致；
 *   · 移除某张图 / 删掉这条记录时，要不要连文件一起删由设置里那个开关决定。
 */

import { store, esc, touch } from "./store.js";
import { icon } from "./icons.js";
import {
  normalizeAttachSettings, checkImageFile, decideEncode, extForMime, extOfName,
  rowPaths, fileNameOf, viewerStep, MAX_UPLOAD_BYTES, JPEG_QUALITY, PNG_FALLBACK_BYTES,
  clipboardImages, clipboardHasText,
} from "./attachment-calc.js";

export { rowPaths } from "./attachment-calc.js";

/** 图片在页面上的地址：JSON 里存的是 attachments/finance/x.jpg，前面加个斜杠就是 URL */
export function attachUrl(path) {
  const text = String(path || "");
  return text.startsWith("/") ? text : "/" + text;
}

/* ---------------- 设置项 ---------------- */

/** 附件设置（认不出就退回默认：不跟着删文件、压到长边 1920） */
export function attachmentSettings() {
  const settings = (store.data && store.data.settings) || {};
  return normalizeAttachSettings(settings.attachments);
}

/** 改附件设置，顺手落盘 */
export function setAttachmentSettings(patch) {
  if (!store.data) return normalizeAttachSettings(null);
  if (!store.data.settings) store.data.settings = {};
  const next = { ...attachmentSettings(), ...patch };
  store.data.settings.attachments = next;
  touch(true);
  return next;
}

/* ---------------- 选图与压缩 ---------------- */

let seq = 0;

/** 读取图片的原始尺寸：优先 createImageBitmap，老浏览器退回 <img> */
async function readImage(file) {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file);
    return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close && bitmap.close() };
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  const loaded = new Promise((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("读不出这张图"));
  });
  img.src = url;
  await loaded;
  return {
    source: img, width: img.naturalWidth, height: img.naturalHeight,
    release: () => URL.revokeObjectURL(url),
  };
}

function toBlob(canvas, mime, quality) {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), mime, quality);
    } catch {
      resolve(null);
    }
  });
}

/**
 * 挑进来的一张图 → 待上传的一项：{ key, blob, name, ext, url, bytes, ... }
 * 长边超档位、或者体积超过 1.5MB 才重新画一遍；否则原样存，
 * 尤其是不动截图那种 png（重新压成 jpg 字会糊）。
 */
export async function prepareImage(file, maxEdge) {
  const info = await readImage(file);
  const plan = decideEncode({
    type: file.type, size: file.size, width: info.width, height: info.height, maxEdge,
  });
  let blob = file;
  let ext = extOfName(file.name) || extForMime(file.type) || "jpg";
  try {
    if (plan.reencode) {
      const canvas = document.createElement("canvas");
      canvas.width = plan.width || info.width;
      canvas.height = plan.height || info.height;
      canvas.getContext("2d").drawImage(info.source, 0, 0, canvas.width, canvas.height);
      let out = await toBlob(canvas, plan.mime, plan.quality);
      // png 重新画完有时还是好几兆（照片存成 png 的尤其如此）。
      // 这种情况下再压一版 jpg 比一比，谁小用谁 —— 宁可损失一点画质，
      // 也别让一张图占掉好几兆。
      if (out && out.size > PNG_FALLBACK_BYTES && plan.mime !== "image/jpeg") {
        const jpeg = await toBlob(canvas, "image/jpeg", JPEG_QUALITY);
        if (jpeg && jpeg.size < out.size) {
          out = jpeg;
          ext = "jpg";
        }
      }
      if (out && out.size) {
        blob = out;
        ext = extForMime(out.type) || ext;
      }
    }
  } finally {
    info.release();
  }
  // 压完还超过 10MB（极端大的原图）就当这一张没收，别悄悄写一个巨型文件进去
  if (blob.size > MAX_UPLOAD_BYTES) {
    throw new Error("这张图压完还是超过 10MB，换一张试试");
  }
  return {
    key: "new-" + ++seq,
    blob,
    name: file.name || "图片",
    ext,
    url: URL.createObjectURL(blob),
    bytes: blob.size,
    originalBytes: file.size,
    width: info.width,
    height: info.height,
  };
}

/* ---------------- 待上传的那几张，攒在一个 state 里 ---------------- */

/**
 * @param {{module?: string, paths?: string[], files?: object[]}} options
 *        module 决定存到 attachments 下面哪一格；
 *        paths 是这条记录已经有的图片，files 是刚挑进来还没写盘的。
 */
export function createAttach({ module = "finance", paths = [], files = [] } = {}) {
  return { module, paths: rowPaths({ imagePaths: paths }), files: files.slice(), error: "" };
}

/** 弹窗关掉时把预览地址还回去（没写盘的图一个字节都没落盘，不用管） */
export function disposeAttach(state) {
  for (const item of state.files || []) {
    try {
      URL.revokeObjectURL(item.url);
    } catch {
      /* 已经回收过就算了 */
    }
  }
  state.files = [];
}

/**
 * 把待上传的图真的写进 数据\attachments\，返回写好的相对路径。
 * 中途有一张失败：把前面已经写进去的删掉再抛错，不留半截。
 */
export async function uploadPending(state) {
  const done = [];
  for (const item of state.files) {
    try {
      const data = await blobToBase64(item.blob);
      const res = await fetch("/api/attachment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ module: state.module, ext: item.ext, name: item.name, data }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) throw new Error(body.error || "HTTP " + res.status);
      done.push(body.path);
    } catch (err) {
      if (done.length) await deleteAttachments(done).catch(() => {});
      throw err;
    }
  }
  return done;
}

/** 上传成功之后收尾：预览地址还掉，路径并进记录里 */
export function commitUploads(state, uploaded) {
  disposeAttach(state);
  state.paths = state.paths.concat(uploaded || []);
  return state.paths;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] || "");
    reader.onerror = () => reject(new Error("图片读不出来"));
    reader.readAsDataURL(blob);
  });
}

/* ---------------- 删文件 ---------------- */

export async function deleteAttachments(paths) {
  const list = (paths || []).filter((p) => typeof p === "string" && p);
  if (!list.length) return { deleted: 0, missing: 0, refused: 0 };
  const res = await fetch("/api/attachment-delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths: list }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) throw new Error(body.error || "HTTP " + res.status);
  return body;
}

/** 整个数据文件里还有谁在引用这张图（回收站里的也算有人认领） */
function referencedElsewhere(path) {
  const data = store.data || {};
  const rows = [];
  for (const key of ["tasks", "contents", "projects", "issues", "progress", "studies",
                     "workoutLogs", "weights", "games", "gameRecords", "subjects"]) {
    if (Array.isArray(data[key])) rows.push(...data[key]);
  }
  if (data.finance && Array.isArray(data.finance.transactions)) rows.push(...data.finance.transactions);
  if (Array.isArray(data.trash)) {
    for (const entry of data.trash) if (entry && entry.row) rows.push(entry.row);
  }
  return rows.some((row) => rowPaths(row).includes(path));
}

/**
 * 一条记录被彻底删掉之后，按设置决定它的图片要不要跟着删。
 * 设置里那个开关关着（默认）就什么都不做 —— 图片留在文件夹里，误删了还能找回来。
 * 删文件失败不该把主流程弄断，所以这里吞掉错误，最多是没删成。
 */
export async function purgeRowAttachments(row) {
  if (!attachmentSettings().pruneOnDelete) return 0;
  const orphans = rowPaths(row).filter((p) => !referencedElsewhere(p));
  if (!orphans.length) return 0;
  try {
    const result = await deleteAttachments(orphans);
    return result.deleted || 0;
  } catch {
    return 0;
  }
}

/* ---------------- 画 ---------------- */

function tileHtml({ key, src, label, removable }) {
  return (
    `<figure class="thumb" role="button" tabindex="0" data-attach-src="${esc(src)}" ` +
    `data-attach-label="${esc(label)}" title="点开看大图">` +
    `<img src="${esc(src)}" alt="${esc(label || "图片备注")}" loading="lazy">` +
    (removable
      ? `<button type="button" class="thumb-x" data-attach-act="drop" data-key="${esc(key)}" ` +
        `title="移除这张（不关弹窗）" aria-label="移除这张图片">${icon("x", 12)}</button>`
      : "") +
    `</figure>`
  );
}

/** 弹窗里的缩略图：已经存下的 + 刚挑进来还没写盘的，两种都能单独移除 */
function pickerTilesHtml(state) {
  const saved = state.paths.map((p) => ({
    key: p, src: attachUrl(p), label: fileNameOf(p), removable: true,
  }));
  const fresh = state.files.map((f) => ({
    key: f.key, src: f.url, label: f.name, removable: true,
  }));
  return saved.concat(fresh).map(tileHtml).join("");
}

/**
 * 只读的缩略图行：记账明细、bug 行里用。
 * 没有图片就返回空串 —— 调用方直接拼进模板，没图时那个位置一点空白都不占。
 */
export function thumbsHtml(paths) {
  const list = rowPaths({ imagePaths: paths });
  if (!list.length) return "";
  return `<div class="thumb-row">${list
    .map((p) => tileHtml({ key: p, src: attachUrl(p), label: fileNameOf(p), removable: false }))
    .join("")}</div>`;
}

/**
 * 列表行上的「有图片」小标记：有图才显示，没有就返回空串（一点空白都不占）。
 * 各个模块的列表都用这一个，样子和提示语才会一致。
 *
 * 传了 options.act 就变成能点的（比如项目卡片上那个：点它看大图，
 * 点卡片别处还是进项目详情）。
 */
export function imgBadge(paths, what = "图", options = {}) {
  const n = rowPaths({ imagePaths: paths }).length;
  if (!n) return "";
  const attrs = [`title="${esc(options.title || `带 ${n} 张${what}`)}"`];
  if (options.act) attrs.push(`data-act="${esc(options.act)}"`);
  if (options.act && options.id) attrs.push(`data-id="${esc(options.id)}"`);
  return `<span class="img-flag${options.act ? " img-flag-act" : ""}" ${attrs.join(" ")}>${icon("image", 14)}</span>`;
}

/* ---------------- 附件区（弹窗 / 表单里那块） ---------------- */

const mounted = new WeakMap();

function attachInnerHtml() {
  return `
    <div class="attach-bar">
      <button type="button" class="attach-btn" data-attach-act="pick">
        ${icon("image", 16)}添加图片备注
      </button>
      <span class="attach-hint">或在弹窗里按 <kbd>Ctrl</kbd>+<kbd>V</kbd> 贴截图</span>
      <span class="attach-count"></span>
    </div>
    <input type="file" class="attach-input" accept="image/png,image/jpeg,image/webp" multiple hidden>
    <div class="attach-list"></div>
    <p class="attach-tip">可选，能加多张：截图（Win+Shift+S）之后直接按 Ctrl+V 就贴进来了，
      小票截图、付款截图都行；点缩略图看大图，右上角的 × 单独移除。</p>
    <p class="attach-err" hidden></p>`;
}

/**
 * 把一批文件收进这个附件区：查一道、压一道、进预览列表。
 * 「点按钮选本地文件」和「Ctrl+V 粘贴截图」两条路都走这里，规则只有一份。
 * 收了图就轻轻闪一下，给个「贴进来了」的反馈。
 */
async function absorbFiles(entry, files) {
  const state = entry.state;
  state.error = "";
  const maxEdge = attachmentSettings().maxEdge;
  let added = 0;
  for (const file of files) {
    const check = checkImageFile({ type: file.type, size: file.size, name: file.name });
    if (!check.ok) {
      state.error = check.error;
      continue;
    }
    try {
      state.files.push(await prepareImage(file, maxEdge));
      added++;
    } catch (err) {
      state.error = (err && err.message) || "这张图读不出来，换一张试试";
    }
  }
  if (added) entry.flash();
  entry.paint();
  entry.changed();
}

/**
 * 把一个附件区挂到 host 上（host 里原来有什么都会被换掉）。
 * 同一个 host 再挂一次只是重画，不会把事件叠两遍。
 *
 * @param {HTMLElement} host 那个空的 <div> 容器
 * @param {object} state     createAttach() 的返回值
 * @param {{onChange?: Function}} options
 */
export function mountAttach(host, state, options = {}) {
  if (!host) return state;
  const existing = mounted.get(host);
  if (existing) {
    existing.state = state;
    existing.options = options;
    existing.paint();
    return state;
  }

  host.className = "attach";
  host.innerHTML = attachInnerHtml();
  const list = host.querySelector(".attach-list");
  const count = host.querySelector(".attach-count");
  const error = host.querySelector(".attach-err");
  const input = host.querySelector(".attach-input");

  // 事件都按 entry.state 走（不是挂载时那个 state），弹窗里换过一版状态也不会画错
  const entry = { state, options, paint, changed, flash };

  function paint() {
    list.innerHTML = pickerTilesHtml(entry.state);
    const n = entry.state.paths.length + entry.state.files.length;
    count.textContent = n ? `已选 ${n} 张` : "";
    error.textContent = entry.state.error || "";
    error.hidden = !entry.state.error;
  }

  function changed() {
    const fn = entry.options && entry.options.onChange;
    if (typeof fn === "function") fn(entry.state);
  }

  /** 刚收下图片时整块闪一下；连贴两张也要能重新播一遍动画 */
  function flash() {
    host.classList.remove("flash");
    void host.offsetWidth;
    host.classList.add("flash");
    window.setTimeout(() => host.classList.remove("flash"), 600);
  }

  paint();

  host.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-attach-act]");
    if (!btn) return;   // 点缩略图看图那件事由下面全局那套代理接手
    if (btn.dataset.attachAct === "pick") {
      input.click();
      return;
    }
    if (btn.dataset.attachAct !== "drop") return;
    const key = btn.dataset.key;
    const at = entry.state.files.findIndex((f) => f.key === key);
    if (at >= 0) {
      try {
        URL.revokeObjectURL(entry.state.files[at].url);
      } catch {
        /* 已经回收过就算了 */
      }
      entry.state.files.splice(at, 1);
    } else {
      entry.state.paths = entry.state.paths.filter((p) => p !== key);
    }
    entry.state.error = "";
    paint();
    changed();
  });

  input.addEventListener("change", async () => {
    const picked = Array.from(input.files || []);
    input.value = "";   // 同一张图连选两次也要能触发 change
    if (!picked.length) return;
    await absorbFiles(entry, picked);
  });

  mounted.set(host, entry);
  return state;
}

/* ---------------- 粘贴（Ctrl+V） ----------------
 * 截图（Win+Shift+S）截完，图就在剪贴板里；在弹窗里按 Ctrl+V 直接进附件区，
 * 省掉「先另存成文件 → 再点按钮去挑」那两步。
 *
 * 两条克制的规矩：
 *   · 只认「当前那个弹窗里的附件区」—— 页面正文、搜索框里按 Ctrl+V 一切照旧；
 *   · 剪贴板里同时夹着文字就不抢这次粘贴（Excel / 网页里复制来的常常图文一起，
 *     文字该照常落进输入框）；截图只有图片，不受这条影响。
 */

/** 当前开着的弹窗里的附件区；没有（或只是摆设）就返回 null */
function activeAttachHost() {
  if (typeof document === "undefined") return null;
  const backdrops = document.querySelectorAll(".dlg-backdrop");
  for (let i = backdrops.length - 1; i >= 0; i--) {
    const host = backdrops[i].querySelector(".attach");
    if (host && mounted.has(host)) return host;
  }
  return null;
}

let pasteReady = false;

export function installPasteHandler() {
  if (pasteReady || typeof document === "undefined") return;
  pasteReady = true;
  document.addEventListener("paste", (e) => {
    if (document.querySelector(".viewer-backdrop")) return;   // 正在看大图，别抢
    const host = activeAttachHost();
    if (!host) return;
    const items = e.clipboardData ? e.clipboardData.items : null;
    const images = clipboardImages(items);
    if (!images.length || clipboardHasText(items)) return;
    e.preventDefault();   // 图已经收下了，别让它再落进底下的输入框
    absorbFiles(mounted.get(host), images);
  });
}

installPasteHandler();

/* ---------------- 全屏查看 ---------------- */

/**
 * 全屏看图：左右翻页、Esc 关、点空白关。
 * @param {{src: string, label?: string}[]} items
 * @param {number} index 从哪一张打开
 */
export function openViewer(items, index = 0) {
  const list = (items || []).filter((it) => it && it.src);
  if (!list.length) return null;
  let at = Math.max(0, Math.min(list.length - 1, Math.round(Number(index) || 0)));

  const el = document.createElement("div");
  el.className = "viewer-backdrop";
  el.innerHTML = `
    <div class="viewer" role="dialog" aria-modal="true" aria-label="看图">
      <button class="viewer-x" data-view-act="close" title="关闭（Esc）" aria-label="关闭">${icon("x", 18)}</button>
      <div class="viewer-stage">
        <img class="viewer-img" alt="图片备注">
        <p class="viewer-lost" hidden>图片丢失</p>
      </div>
      ${
        list.length > 1
          ? `<button class="viewer-nav prev" data-view-act="prev" title="上一张（←）" aria-label="上一张">‹</button>
             <button class="viewer-nav next" data-view-act="next" title="下一张（→）" aria-label="下一张">›</button>`
          : ""
      }
      <div class="viewer-bar">
        <span class="viewer-count"></span>
        <span class="viewer-name"></span>
        <span class="viewer-hint">${list.length > 1 ? "← → 翻页 · " : ""}Esc 关闭</span>
      </div>
    </div>`;
  document.body.appendChild(el);

  const img = el.querySelector(".viewer-img");
  const lost = el.querySelector(".viewer-lost");
  const countEl = el.querySelector(".viewer-count");
  const nameEl = el.querySelector(".viewer-name");

  const paint = () => {
    const item = list[at];
    img.hidden = false;
    lost.hidden = true;
    img.src = item.src;
    img.alt = item.label || "图片备注";
    countEl.textContent = list.length > 1 ? `${at + 1} / ${list.length}` : "";
    nameEl.textContent = item.label || "";
  };
  // 文件被手动删掉的情形：不弹错、不崩，写一句「图片丢失」就完事
  img.addEventListener("error", () => {
    img.hidden = true;
    lost.hidden = false;
  });
  paint();

  function close() {
    document.removeEventListener("keydown", onKey, true);
    el.remove();
  }
  function step(delta) {
    at = viewerStep(at, list.length, delta);
    paint();
  }
  function onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      step(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      step(1);
    }
  }

  el.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-view-act]");
    if (btn) {
      const act = btn.dataset.viewAct;
      if (act === "close") close();
      else step(act === "prev" ? -1 : 1);
      return;
    }
    // 点图片以外的地方（遮罩 / 舞台空白）也关掉
    if (!e.target.closest(".viewer-img")) close();
  });
  document.addEventListener("keydown", onKey, true);
  return { el, close };
}

/** 只有一堆路径、没有额外信息时用这个（项目卡片上的图片标记点开就是它） */
export function openPathViewer(paths, index = 0) {
  const list = rowPaths({ imagePaths: paths }).map((p) => ({
    src: attachUrl(p), label: fileNameOf(p),
  }));
  return openViewer(list, index);
}

/* ---------------- 全局代理（缩略图点击 / 图片读不出来） ----------------
 * 缩略图到处都是（弹窗里、列表里），一个个绑太碎；
 * 这里挂一次，谁身上有 .thumb 就归它管。 */

let delegatesReady = false;

function rowItems(tile) {
  const row = tile.parentElement;
  if (!row) return [];
  return [...row.children].map((child) => ({
    src: child.dataset.attachSrc || "",
    label: child.dataset.attachLabel || "",
  }));
}

function openTile(tile) {
  const row = tile.parentElement;
  if (!row) return;
  openViewer(rowItems(tile), [...row.children].indexOf(tile));
}

export function installAttachmentDelegates() {
  if (delegatesReady || typeof document === "undefined") return;
  delegatesReady = true;

  document.addEventListener("click", (e) => {
    const tile = e.target.closest(".thumb");
    if (!tile || e.target.closest(".thumb-x")) return;
    openTile(tile);
  });

  // 缩略图是 role=button，回车 / 空格也应该能打开
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const tile = e.target.closest ? e.target.closest(".thumb") : null;
    if (!tile) return;
    e.preventDefault();
    openTile(tile);
  });

  // 文件被手动删掉 / 挪走：缩略图显示占位，条目本身照常显示
  document.addEventListener(
    "error",
    (e) => {
      const img = e.target;
      if (!img || img.tagName !== "IMG" || !img.closest) return;
      const tile = img.closest(".thumb");
      if (!tile) return;
      tile.classList.add("missing");
      tile.title = "图片丢失（文件被删了或者挪走了）";
    },
    true
  );
}

installAttachmentDelegates();
