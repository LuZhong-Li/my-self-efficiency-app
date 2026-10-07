/* 图片附件纯逻辑的单元测试：只测 app/web/attachment-calc.js。
 * 跑法：node tests\附件计算.test.mjs   （本机 Node v24，不需要 package.json）
 * 说明：和别的 .test.mjs 一样，不进「自检.cmd」——自检是给用户一键跑的，保持纯 Python。 */

import {
  IMAGE_TYPES, MAX_UPLOAD_BYTES, MAX_PICK_BYTES, RECOMPRESS_BYTES, JPEG_QUALITY,
  COMPRESS_PRESETS, DEFAULT_ATTACH_SETTINGS, ATTACH_MODULES,
  normalizeAttachSettings, presetLabel,
  extForMime, extOfName, checkImageFile, rowPaths,
  fitEdge, decideEncode, stampOf, uniqueName,
  attachmentPath, parseAttachmentPath, isValidAttachmentPath, fileNameOf,
  viewerStep, humanSize,
} from "../app/web/attachment-calc.js";

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

/* ---------------- 设置项 ---------------- */

eqDeep(normalizeAttachSettings(null), DEFAULT_ATTACH_SETTINGS, "没设置过 → 默认（不删文件、压到 1920）");
eqDeep(normalizeAttachSettings({}), DEFAULT_ATTACH_SETTINGS, "空对象也是默认");
eqDeep(
  normalizeAttachSettings({ pruneOnDelete: true, maxEdge: 2560 }),
  { pruneOnDelete: true, maxEdge: 2560 },
  "正常值原样认"
);
eqDeep(
  normalizeAttachSettings({ pruneOnDelete: "yes", maxEdge: "2560" }),
  { pruneOnDelete: true, maxEdge: 2560 },
  "字符串也认（设置文件被人手改过的情形）"
);
eq(normalizeAttachSettings({ maxEdge: 999 }).maxEdge, 1920, "档位里没有的尺寸退回默认 1920");
eq(normalizeAttachSettings({ maxEdge: 0 }).maxEdge, 0, "0 是合法档位（原图，不缩）");
eq(normalizeAttachSettings({ maxEdge: -5 }).maxEdge, 1920, "负数不是档位，退回默认");

eq(presetLabel(1920), "1080P（长边 1920px）", "1920 的档位文字");
eq(presetLabel(2560), "2K（长边 2560px）", "2560 的档位文字");
eq(presetLabel(0), "原图，不压缩", "0 的档位文字");
eq(presetLabel(1234), COMPRESS_PRESETS[0].label, "认不出的档位按默认那一档显示");
eq(COMPRESS_PRESETS.length, 3, "一共三档：1080P / 2K / 原图");
eq(ATTACH_MODULES.includes("finance") && ATTACH_MODULES.includes("buglog"), true, "记账和 bug 登记都在白名单里");

/* ---------------- 挑文件 ---------------- */

eq(IMAGE_TYPES.length, 3, "只收 png / jpeg / webp 三种");
eq(extForMime("image/png"), "png", "png 的扩展名");
eq(extForMime("image/jpeg"), "jpg", "jpeg 写出来是 jpg");
eq(extForMime("image/webp"), "webp", "webp 的扩展名");
eq(extForMime("image/gif"), "", "gif 不在白名单，给空串");
eq(extForMime(""), "", "空 mime 给空串");

eq(extOfName("小票.PNG"), "png", "后缀不区分大小写");
eq(extOfName("a.b.jpeg"), "jpg", "jpeg 归一成 jpg");
eq(extOfName("没有后缀"), "", "没有后缀给空串");

eq(checkImageFile({ type: "image/png", size: 1024, name: "a.png" }).ok, true, "png 小图可以");
eq(checkImageFile({ type: "image/jpeg", size: 1024, name: "a.jpg" }).ok, true, "jpg 可以");
eq(checkImageFile({ type: "image/webp", size: 1024, name: "a.webp" }).ok, true, "webp 可以");
eq(checkImageFile({ type: "image/gif", size: 1024, name: "a.gif" }).ok, false, "gif 不收");
eq(checkImageFile({ type: "application/pdf", size: 1024, name: "a.pdf" }).ok, false, "pdf 不收");
eq(checkImageFile({ type: "image/png", size: MAX_PICK_BYTES + 1, name: "a.png" }).error,
  "这张图太大了（超过 30MB），先压一下再加", "超过 30MB 的说法");
eq(checkImageFile({ type: "image/png", size: MAX_PICK_BYTES, name: "a.png" }).ok, true,
  "正好 30MB 放行（压完存下来的才是 10MB 那条线）");
eq(checkImageFile({ type: "image/png", size: MAX_UPLOAD_BYTES * 1.5, name: "a.png" }).ok, true,
  "12MB 的手机照片照样收 —— 压完通常只有几百 KB，不该在这里就挡掉");
eq(decideEncode({ type: "image/png", size: MAX_UPLOAD_BYTES * 1.5, width: 4000, height: 3000, maxEdge: 1920 }).reencode,
  true, "超过 10MB 的原图一定会走重新编码那条路");
eq(checkImageFile({ type: "", size: 1024, name: "截图.png" }).ok, true,
  "系统给不出 mime 时看后缀（是白名单后缀就认）");
eq(checkImageFile({ type: "", size: 1024, name: "截图.gif" }).ok, false,
  "系统给不出 mime、后缀也不认 → 不收");

/* ---------------- 老数据兼容 ---------------- */

eqDeep(rowPaths({ id: "x" }), [], "老记录没有 imagePaths → 空数组");
eqDeep(rowPaths({ imagePaths: null }), [], "字段是 null → 空数组");
eqDeep(rowPaths({ imagePaths: "attachments/finance/a.png" }), [], "字段被写成了字符串 → 空数组");
eqDeep(
  rowPaths({ imagePaths: ["attachments/finance/a.png", "", null, "attachments/finance/b.jpg"] }),
  ["attachments/finance/a.png", "attachments/finance/b.jpg"],
  "空串和 null 会被筛掉"
);
eqDeep(rowPaths(null), [], "整行都没有也给空数组");

/* ---------------- 压缩口径 ---------------- */

eqDeep(fitEdge(4000, 3000, 1920), { width: 1920, height: 1440, scaled: true }, "横图缩到长边 1920");
eqDeep(fitEdge(3000, 4000, 1920), { width: 1440, height: 1920, scaled: true }, "竖图按长边缩");
eqDeep(fitEdge(800, 600, 1920), { width: 800, height: 600, scaled: false }, "本来就小 → 不动");
eqDeep(fitEdge(1920, 1080, 1920), { width: 1920, height: 1080, scaled: false }, "正好等于上限 → 不动");
eqDeep(fitEdge(4000, 3000, 0), { width: 4000, height: 3000, scaled: false }, "选了原图档 → 不缩");
eqDeep(fitEdge(4000, 3000, 2560), { width: 2560, height: 1920, scaled: true }, "2K 档按 2560 缩");
eqDeep(fitEdge(0, 0, 1920), { width: 0, height: 0, scaled: false }, "读不出尺寸 → 不缩，交给原图");
eqDeep(fitEdge(101, 100, 100).width, 100, "极端长条也按长边收");
eq(fitEdge(1, 4000, 1).height, 1, "缩完至少留 1 像素，不能变成 0");

const small = decideEncode({ type: "image/png", size: 300 * 1024, width: 1200, height: 900, maxEdge: 1920 });
eq(small.reencode, false, "尺寸和体积都不超 → 原样存");
eq(small.mime, "", "原样存时不带输出格式");

const bigEdge = decideEncode({ type: "image/jpeg", size: 800 * 1024, width: 5000, height: 3000, maxEdge: 1920 });
eq(bigEdge.reencode, true, "长边超档位 → 重新画");
eq(bigEdge.scale, true, "并且确实缩了");
eq(bigEdge.mime, "image/jpeg", "jpg 还是输出 jpg");
eq(bigEdge.quality, JPEG_QUALITY, "jpg 带上质量参数");
eqDeep([bigEdge.width, bigEdge.height], [1920, 1152], "缩完的尺寸照 fitEdge 来");

const bigBytes = decideEncode({ type: "image/png", size: RECOMPRESS_BYTES + 1, width: 800, height: 600, maxEdge: 1920 });
eq(bigBytes.reencode, true, "尺寸没超但体积超 1.5MB → 也重新编码");
eq(bigBytes.scale, false, "这种情况下不缩尺寸");
eq(bigBytes.mime, "image/png", "png 保持 png（截图重新压成 jpg 会糊）");
eq(bigBytes.quality, undefined, "png 不带质量参数");

const webp = decideEncode({ type: "image/webp", size: 5 * 1024 * 1024, width: 3000, height: 3000, maxEdge: 2560 });
eq(webp.mime, "image/webp", "webp 保持 webp");
eq(webp.quality, undefined, "webp 不走 jpeg 质量参数");

const unknown = decideEncode({ type: "", size: 3 * 1024 * 1024, width: 100, height: 100, maxEdge: 1920 });
eq(unknown.mime, "image/jpeg", "认不出的格式统一收成 jpeg");

eq(decideEncode({ type: "image/png", size: 100, width: 100, height: 100, maxEdge: 0 }).reencode, false,
  "原图档 + 小图 → 完全不动它");

/* ---------------- 命名与路径 ---------------- */

eq(stampOf(new Date(2026, 9, 7)), "20261007", "日期戳是本地年月日（月份从 0 数）");
eq(uniqueName(new Date(2026, 9, 7), "ABC123def", "JPG"), "20261007_abc123def.jpg", "文件名 = 日期_随机.扩展名");
eq(uniqueName(new Date(2026, 0, 3), "aa11", ".png"), "20260103_aa11.png", "扩展名前面带点也认");
eq(uniqueName(new Date(2026, 0, 3), "aa11", "jpeg"), "20260103_aa11.jpg", "jpeg 统一写成 jpg");

eq(attachmentPath("finance", "20261007_ab12cd34.jpg"), "attachments/finance/20261007_ab12cd34.jpg",
  "记账的图片路径");
eq(attachmentPath("buglog", "20261007_ab12cd34.png"), "attachments/buglog/20261007_ab12cd34.png",
  "bug 登记的图片路径");

const parsed = parseAttachmentPath("attachments/finance/20261007_ab12cd34.jpg");
eq(parsed && parsed.module, "finance", "能解析出模块");
eq(parsed && parsed.file, "20261007_ab12cd34.jpg", "能解析出文件名");
eq(parseAttachmentPath("attachments/finance/../数据.json"), null, "带 .. 的不认");
eq(parseAttachmentPath("attachments/finance/../../数据.json"), null, "往外跳两级也不认");
eq(parseAttachmentPath("attachments/buglog/note.txt"), null, "不是图片后缀的不认");
eq(parseAttachmentPath("attachments/unknown/20261007_ab12cd34.jpg"), null, "模块不在白名单不认");
eq(parseAttachmentPath("attachments/finance/小票.jpg"), null, "文件名不是「日期_随机」的不认");
eq(parseAttachmentPath("数据/数据.json"), null, "数据文件本身不认");
eq(parseAttachmentPath("/etc/passwd"), null, "绝对路径不认");
eq(parseAttachmentPath(""), null, "空串不认");
eq(parseAttachmentPath(null), null, "null 不认");
eq(parseAttachmentPath("attachments\\finance\\20261007_ab12cd34.jpg") !== null, true,
  "反斜杠也当路径分隔符（Windows 上复制粘贴过来的一律当外部输入）");
eq(isValidAttachmentPath("attachments/note/20260101_deadbeef.webp"), true, "合法路径认得出来");
eq(isValidAttachmentPath("attachments/note/2026_deadbeef.webp"), false, "日期不是 8 位不认");
eq(parseAttachmentPath("attachments/finance/20261007_a.jpg"), null, "随机串太短不认");
eq(fileNameOf("attachments/finance/20261007_ab12cd34.jpg"), "20261007_ab12cd34.jpg", "取文件名");
eq(fileNameOf("随便一个/不合法.jpg"), "不合法.jpg", "不合法的路径尽力取最后一段（只用来显示）");

/* ---------------- 查看器 ---------------- */

eq(viewerStep(0, 3, 1), 1, "往后一张");
eq(viewerStep(2, 3, 1), 0, "最后一张再往后 → 绕回第一张");
eq(viewerStep(0, 3, -1), 2, "第一张往前 → 绕到最后一张");
eq(viewerStep(1, 1, 1), 0, "只有一张时原地不动");
eq(viewerStep(0, 0, 1), 0, "一张都没有也不炸");
eq(viewerStep(0, 3, -4), 2, "跨多张也绕得回来（0 往前 4 张 = 2）");
eq(viewerStep(1, 3, 7), 2, "往前跨两圈也绕得回来（1 往后 7 张 = 2）");

/* ---------------- 体积显示 ---------------- */

eq(humanSize(0), "0 字节", "0 字节");
eq(humanSize(1023), "1023 字节", "不到 1KB 就按字节");
eq(humanSize(1024), "1.0 KB", "1024 起按 KB");
eq(humanSize(1536), "1.5 KB", "1.5KB 保留一位");
eq(humanSize(3 * 1024 * 1024), "3.00 MB", "MB 保留两位");

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
