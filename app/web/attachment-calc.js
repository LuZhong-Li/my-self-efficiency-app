/* 图片附件的纯逻辑：只吃数字、字符串和普通对象，不碰 DOM、不碰 store。
 *
 * 为什么单独一个文件：这套附件组件记账 / bug 登记 / 笔记三个模块共用，
 * 命名规则、压缩口径、路径校验只要错一处就是三处一起错。抽成纯函数之后
 * `node tests\附件计算.test.mjs` 就能一条条断言，不用开浏览器。
 */

/** 只收这三种图（和 <input accept> 对齐；gif / 动图不要，免得压缩那步出错） */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

/** 存下来的单张上限 10MB。挑进来的图比它大，会先压一轮再存（见 decideEncode） */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** 挑进来超过这个数就直接不收：手机照片一般十几兆，真有 30MB 以上的，
 *  压起来又慢又吃内存，不如让用户自己先处理一张 */
export const MAX_PICK_BYTES = 30 * 1024 * 1024;

/** 超过这个大小才重新编码。小图原样存，省掉一次没必要的（有损）转换。
 *  它比 MAX_UPLOAD_BYTES 小，所以十几兆的原图一定会走「重新画一遍」那条路，
 *  压完通常远小于 10MB，不必因为原图大就把人挡在门外。 */
export const RECOMPRESS_BYTES = 1.5 * 1024 * 1024;

/** 重新编码成 jpeg 时的质量：0.86 是肉眼看不出、体积又明显小下去的那一档 */
export const JPEG_QUALITY = 0.86;

/** png 重新画完还超过这个大小 → 再压一版 jpg 比一比，谁小用谁。
 *  真截图（png）一般几百 KB，不会碰到这条线；照片存成 png 的会，转 jpg 能小十倍。 */
export const PNG_FALLBACK_BYTES = 2 * 1024 * 1024;

/** 压缩档位：长边上限（0 = 原图，不缩） */
export const COMPRESS_PRESETS = [
  { value: 1920, label: "1080P（长边 1920px）" },
  { value: 2560, label: "2K（长边 2560px）" },
  { value: 0, label: "原图，不压缩" },
];

export const DEFAULT_ATTACH_SETTINGS = { pruneOnDelete: false, maxEdge: 1920 };

/** 图片按模块分格存：接下去加新模块，往这里补一个名字就行
 *  （服务端 服务.py 的 ATTACH_MODULES 要保持一致） */
export const ATTACH_MODULES = [
  "finance", "buglog", "progress",
  "today_plan", "dev_project", "dev_todo", "study_record", "study_item",
  "fitness", "game", "game_record",
  "note",
];

export const MODULE_LABEL = {
  finance: "记账", buglog: "bug 登记", progress: "项目进展",
  today_plan: "今日计划", dev_project: "开发项目", dev_todo: "开发待办",
  study_record: "学习记录", study_item: "学习对象", fitness: "训练打卡", game: "游戏",
  game_record: "游玩记录",
  note: "笔记",
};

/** 附件在 JSON 里统一用这个前缀（相对路径，不带盘符，换机器也认） */
export const ATTACH_ROOT = "attachments";

const EXT_BY_MIME = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/** 设置里那一小块，读出来先规整一遍：认得出就用，认不出退回默认 */
export function normalizeAttachSettings(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const edge = Number(src.maxEdge);
  const known = COMPRESS_PRESETS.some((p) => p.value === edge);
  return {
    pruneOnDelete: Boolean(src.pruneOnDelete),
    maxEdge: known ? edge : DEFAULT_ATTACH_SETTINGS.maxEdge,
  };
}

/** 1920 → "1080P（长边 1920px）"；认不出的值按默认那一档写 */
export function presetLabel(maxEdge) {
  const hit = COMPRESS_PRESETS.find((p) => p.value === Number(maxEdge));
  return (hit || COMPRESS_PRESETS[0]).label;
}

/** mime → 扩展名；不认识就给空串 */
export function extForMime(mime) {
  return EXT_BY_MIME[String(mime || "").toLowerCase()] || "";
}

/** 文件名 → 扩展名（jpeg 统一写成 jpg，免得同一个格式两个后缀） */
export function extOfName(name) {
  const text = String(name || "");
  const dot = text.lastIndexOf(".");
  if (dot < 0) return "";
  const ext = text.slice(dot + 1).toLowerCase();
  return ext === "jpeg" ? "jpg" : ext;
}

/** 挑进来的这个文件收不收？不收的话把原因写清楚，让界面直接显示。
 *  注意这里只管「是不是图片」和「是不是大得离谱」，10MB 那条线是压完之后
 *  才卡的（见 prepareImage），不然一张 12MB 的手机照片会被无谓地拒掉。 */
export function checkImageFile({ type, size, name } = {}) {
  const mime = String(type || "").toLowerCase();
  const ext = extOfName(name);
  const byMime = IMAGE_TYPES.includes(mime);
  // 有些系统给不出 mime，这种时候看后缀（后缀也是白名单里的才行）
  const byExt = !mime && ["png", "jpg", "webp"].includes(ext);
  if (!byMime && !byExt) return { ok: false, error: "只收 png / jpg / webp 的图片" };
  if (Number(size) > MAX_PICK_BYTES) {
    return { ok: false, error: "这张图太大了（超过 30MB），先压一下再加" };
  }
  return { ok: true, error: "" };
}

/** 一条记录上的图片路径（老数据没有这个字段，一律当空数组） */
export function rowPaths(row) {
  const list = row && row.imagePaths;
  if (!Array.isArray(list)) return [];
  return list.filter((p) => typeof p === "string" && p.trim());
}

/** 长边缩到 maxEdge，等比；maxEdge 是 0、或者本来就够小，就原样返回 */
export function fitEdge(width, height, maxEdge) {
  const w = Math.max(0, Math.round(Number(width) || 0));
  const h = Math.max(0, Math.round(Number(height) || 0));
  const cap = Math.max(0, Math.round(Number(maxEdge) || 0));
  if (!cap || !w || !h || Math.max(w, h) <= cap) {
    return { width: w, height: h, scaled: false };
  }
  const k = cap / Math.max(w, h);
  return {
    width: Math.max(1, Math.round(w * k)),
    height: Math.max(1, Math.round(h * k)),
    scaled: true,
  };
}

/**
 * 这张图要不要重新画一遍。
 *  · 太大（长边超档位）→ 缩；
 *  · 体积超 1.5MB → 重新编码一次，几乎必然小一截；
 *  · 两条都不占 → 原样存（不动它的像素，也不动它的格式）。
 * png / webp 尽量保持原格式，其余（含 jpg）统一收成 jpeg。
 */
export function decideEncode({ type, size, width, height, maxEdge } = {}) {
  const fit = fitEdge(width, height, maxEdge);
  const bytes = Math.max(0, Number(size) || 0);
  const mime = String(type || "").toLowerCase();
  const reencode = fit.scaled || bytes > RECOMPRESS_BYTES;
  const outMime = EXT_BY_MIME[mime] ? mime : "image/jpeg";
  return {
    scale: fit.scaled,
    width: fit.width,
    height: fit.height,
    reencode,
    mime: reencode ? outMime : "",
    quality: reencode && outMime === "image/jpeg" ? JPEG_QUALITY : undefined,
  };
}

/** 附件文件名：日期 + 随机串 + 扩展名。日期让文件夹里按天挨着排，随机串防重名 */
export function stampOf(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`;
}

export function uniqueName(date, rand, ext) {
  const clean = String(ext || "").replace(/^\./, "").toLowerCase();
  const suffix = clean === "jpeg" ? "jpg" : clean;
  return `${stampOf(date)}_${String(rand || "").toLowerCase()}.${suffix}`;
}

/** 模块名 + 文件名 → JSON 里存的那条相对路径 */
export function attachmentPath(module, fileName) {
  return `${ATTACH_ROOT}/${module}/${fileName}`;
}

/**
 * 反过来解析一条相对路径；不合法就返回 null。
 * 这是「外面递进来的字符串不能直接当文件路径用」的那道闸：
 * 目录必须是 attachments、模块必须是白名单、文件名必须是「日期_随机.扩展」，
 * 所以 `attachments/finance/../../数据.json` 这种一定过不了。
 */
export function parseAttachmentPath(path) {
  const text = String(path == null ? "" : path)
    .replace(/\\/g, "/")
    .trim();
  const parts = text.split("/");
  if (parts.length !== 3) return null;
  const [root, module, file] = parts;
  if (root !== ATTACH_ROOT) return null;
  if (!ATTACH_MODULES.includes(module)) return null;
  if (!/^\d{8}_[a-z0-9]{4,32}\.(png|jpg|webp)$/i.test(file)) return null;
  return { module, file };
}

export function isValidAttachmentPath(path) {
  return parseAttachmentPath(path) !== null;
}

/** 路径里最后那一段（查看器上显示用的文件名） */
export function fileNameOf(path) {
  const parsed = parseAttachmentPath(path);
  return parsed ? parsed.file : String(path || "").split("/").pop();
}

/** 查看器翻页：到头绕回另一头（只有一张时原地不动） */
export function viewerStep(index, total, delta) {
  const n = Math.max(0, Math.round(Number(total) || 0));
  if (n <= 0) return 0;
  const i = Math.round(Number(index) || 0);
  return (((i + delta) % n) + n) % n;
}

/** 1024 → "1.0 KB"，给设置页显示附件占用用 */
export function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + " 字节";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(2) + " MB";
}
