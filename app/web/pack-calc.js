/* 自定义适配（适配包）：纯逻辑，不碰 DOM、不碰 store、不发网络请求，
 * 方便用 Node 直接跑单测。真正的读盘 / 装包 / 拉取都在 服务.py。
 *
 * 一期只管「我是谁」：
 *   应用名（标题栏、品牌位、首页问候语、窗口标题、任务栏）
 *   图标（任务栏 / favicon）
 *   标语
 *   —— 界面元素、模块级定制、整份 CSS 是后面的期数，这里先把字段留好位置。
 *
 * 一个适配包 = 一个目录（或一个 zip），里面：
 *   manifest.json   清单，必须
 *   icon.png        图标，可选（清单里 icon 指哪个就用哪个）
 */

/** 清单格式版本。以后加字段就往上加，老清单还能读。 */
export const PACK_SCHEMA = 1;

/** 应用名最长多少个字符。顶栏那个位置放不下更长的。 */
export const NAME_MAX = 24;
/** 标语最长多少个字符。 */
export const SLOGAN_MAX = 40;

/** 没装适配包、或者装的包坏了，一律退回这个。 */
export const DEFAULT_PACK = {
  id: "",
  appName: "小李",
  slogan: "把时间花在看得见的地方",
  icon: "",
};

/** id 只允许字母数字下划线连字符：要当目录名用，不能有 ../ 这类东西。 */
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
/** 图标文件名只允许单层文件名，不许带路径。 */
const ICON_RE = /^[A-Za-z0-9_.-]{1,80}\.(png|jpg|jpeg|ico|webp|svg)$/i;

/** 把任何东西塞进字符串位：不是字符串就当空串，顺手去掉控制字符和首尾空白。 */
export function cleanText(value) {
  if (typeof value !== "string") return "";
  // 控制字符（含换行 / 制表）一律清掉，标题栏里塞换行会很难看
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
}

/** 按码点截断，不把 emoji 劈成半个。 */
export function clip(value, max) {
  const text = cleanText(value);
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

/**
 * 校验一个清单对象。返回 { ok, pack, errors, warnings }。
 *
 * ok 为 false 时 pack 是 null——调用方不该安装它。
 * errors 是「不能装」的理由，warnings 是「能装但你可能想改改」。
 */
export function normalizeManifest(raw) {
  const errors = [];
  const warnings = [];

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, pack: null, errors: ["manifest.json 不是一个对象"], warnings };
  }

  const schema = raw.schema === undefined ? PACK_SCHEMA : raw.schema;
  if (schema !== PACK_SCHEMA) {
    if (typeof schema === "number" && schema > PACK_SCHEMA) {
      errors.push("这个适配包用的是更新版本的格式（schema " + schema + "），当前程序读不了");
    } else {
      errors.push("schema 不对，应该是 " + PACK_SCHEMA);
    }
  }

  const id = cleanText(raw.id);
  if (!id) {
    errors.push("缺少 id（适配包的唯一名字，只能用字母数字下划线连字符）");
  } else if (!ID_RE.test(id)) {
    errors.push("id 只能用字母、数字、下划线、连字符，长度 1~40：" + id);
  }

  const appName = clip(raw.appName, NAME_MAX);
  if (!appName) {
    errors.push("缺少 appName（要显示的应用名）");
  } else if (Array.from(cleanText(raw.appName)).length > NAME_MAX) {
    warnings.push("appName 太长了，只取前 " + NAME_MAX + " 个字符");
  }

  let icon = "";
  const rawIcon = cleanText(raw.icon);
  if (rawIcon) {
    if (!ICON_RE.test(rawIcon)) {
      errors.push("icon 只能写图标文件名（png / jpg / ico / webp / svg），不能带路径：" + rawIcon);
    } else {
      icon = rawIcon;
    }
  }

  const slogan = clip(raw.slogan, SLOGAN_MAX);
  if (raw.slogan && Array.from(cleanText(raw.slogan)).length > SLOGAN_MAX) {
    warnings.push("slogan 太长了，只取前 " + SLOGAN_MAX + " 个字符");
  }

  if (errors.length) return { ok: false, pack: null, errors, warnings };

  return {
    ok: true,
    errors,
    warnings,
    pack: {
      id,
      appName,
      slogan,
      icon,
      version: cleanText(raw.version),
      author: cleanText(raw.author),
    },
  };
}

/**
 * 从「当前设的是哪个包」+「装了哪些包」推出真正该用的那个。
 *
 * 三种情况：
 *   1. 没设 / 设的那个没装 / 装的那个坏了 → 默认的「小李」
 *   2. 设了且装得好 → 用它
 *   3. 设了但包里的字段是空的 → 那一项单独退回默认值
 *
 * packs 是 { [id]: manifest 对象 }，服务端读盘后整理成这个形状。
 */
export function resolvePack(activeId, packs) {
  const table = packs && typeof packs === "object" ? packs : {};
  const id = cleanText(activeId);
  const raw = id ? table[id] : null;
  if (!raw) return { ...DEFAULT_PACK };

  const { ok, pack } = normalizeManifest(raw);
  if (!ok || !pack) return { ...DEFAULT_PACK };

  return {
    id: pack.id,
    appName: pack.appName || DEFAULT_PACK.appName,
    // 标语：包里没写就空着，不硬塞默认那句 —— 首页那句标语本来就有
    // settings.slogan 这个独立开关，塞了会和它对不上。和服务端 read_pack 一致。
    slogan: pack.slogan || "",
    icon: pack.icon || "",
  };
}

/**
 * 列表里每条该显示成什么样。装在盘上但清单坏了的包也要列出来，
 * 这样用户能在设置页看见「这个包装坏了，删掉它」，而不是无声消失。
 */
export function packRows(manifests) {
  const list = Array.isArray(manifests) ? manifests : [];
  const rows = [];

  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const { ok, pack, errors } = normalizeManifest(item);
    if (ok && pack) {
      rows.push({
        id: pack.id,
        appName: pack.appName,
        slogan: pack.slogan,
        icon: pack.icon,
        version: pack.version,
        author: pack.author,
        broken: false,
        reason: "",
      });
    } else {
      // 坏掉的也要有 id 才能删；id 取不到就用目录名（服务端会给）
      const id = cleanText(item.id) || cleanText(item.dirName);
      if (!id) continue;
      rows.push({
        id,
        appName: id,
        slogan: "",
        icon: "",
        version: "",
        author: "",
        broken: true,
        reason: errors.join("；") || "清单读不出来",
      });
    }
  }

  rows.sort((a, b) => {
    if (a.broken !== b.broken) return a.broken ? 1 : -1;
    return a.appName.localeCompare(b.appName, "zh-CN");
  });
  return rows;
}

/** 图标的 URL：没装适配包或者没指定图标，返回空串（前端就保持默认）。 */
export function iconUrl(pack) {
  if (!pack || !pack.id || !pack.icon) return "";
  return "pack-icon/" + encodeURIComponent(pack.id) + "/" + encodeURIComponent(pack.icon);
}

/**
 * 校验「从 GitHub 拉取」的输入，只真的解析出 owner / repo / ref。
 *
 * 这里**不拼下载地址**：界面这一层不许出现任何外部网址 —— 自检里有一条
 * 盯着 app/web/ 下每一个 .js（「断网也能用」的承诺全靠它）。真正拼地址、
 * 发请求的只有 服务.py，前端把这三段原样交给它。
 *
 * 接受：owner/repo、owner/repo@tag，或者一整条 github.com 的仓库网址
 * （带 /tree/分支 的那种也认）。注释里不写完整网址 —— 自检那条扫描不区分
 * 注释，写了也会被算成「界面里有个外部链接」。
 * 返回 { ok, owner, repo, ref, errors }
 */
export function parseGitHubInput(text) {
  const errors = [];
  let raw = cleanText(text);
  if (!raw) return { ok: false, owner: "", repo: "", ref: "", errors: ["先填仓库地址"] };

  let ref = "";
  // 带 @ref 的简短写法
  const at = raw.lastIndexOf("@");
  if (at > 0 && !raw.slice(at).includes("/")) {
    ref = raw.slice(at + 1).trim();
    raw = raw.slice(0, at).trim();
  }

  // 网址写法
  if (/^https?:\/\//i.test(raw)) {
    const m = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/(.+?))?(?:\/|$)/i.exec(raw);
    if (!m) return { ok: false, owner: "", repo: "", ref: "", errors: ["只支持 github.com 的仓库地址"] };
    const owner = m[1];
    const repo = m[2];
    if (!ref && m[3]) ref = decodeURIComponent(m[3]).replace(/^\/+|\/+$/g, "");
    return finish(owner, repo, ref, errors);
  }

  // owner/repo 写法
  const parts = raw.split("/").filter(Boolean);
  if (parts.length !== 2) {
    return { ok: false, owner: "", repo: "", ref: "", errors: ["写成 用户名/仓库名，比如 LuZhong-Li/xx-pack"] };
  }
  return finish(parts[0], parts[1], ref, errors);

  function finish(owner, repo, refText, errs) {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) errs.push("用户名不合法：" + owner);
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo)) errs.push("仓库名不合法：" + repo);
    if (refText && !/^[A-Za-z0-9._\/-]{1,100}$/.test(refText)) errs.push("分支 / 标签名不合法：" + refText);
    if (errs.length) return { ok: false, owner: "", repo: "", ref: "", errors: errs };
    return { ok: true, owner, repo, ref: refText, errors: [] };
  }
}
