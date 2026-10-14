/* 笔记模块的真浏览器回归测试：新建 → 写标题与正文（就地保存）→ 左边列表跟着变 →
 * 筛选、点着换一条 → 预览（Markdown 真渲染）→ 标签 → 贴一张真图 → 删掉进回收站。
 *
 * 为什么单独有一份：纯逻辑那份（tests\Markdown.test.mjs）盯的是渲染器，
 * 盯不住「模块入口通不通、打字真存进数据了没、列表跟着刷新没、预览接上了没、
 * 图片真落到 附件目录/note/ 没」。
 *
 * 跑法：node tests\笔记.test.mjs
 *   要 Node 22+（内置 fetch / WebSocket 直接说 CDP，不装 puppeteer）；
 *   要本机有 Edge（找不到会退回 Chrome，也可以用 EDGE_PATH 指一个）。
 *   全程在一个临时数据目录里跑，不碰 数据\数据.json，跑完自己清干净。
 * 说明：和别的 .test.mjs 一样不进「自检.cmd」——自检保持纯 Python。
 *      这台机器上没有浏览器 / Python 时打印「跳过」并以 0 退出，免得换台电脑一跑就红。
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
let fail = 0;

function eq(actual, expected, label) {
  if (actual === expected) {
    pass += 1;
    console.log("  ok   " + label);
  } else {
    fail += 1;
    console.log(
      "  FAIL " + label + "：期望 " + JSON.stringify(expected) +
        "，实际 " + JSON.stringify(actual)
    );
  }
}

function ok(cond, label) {
  eq(Boolean(cond), true, label);
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
    pass += 1;
    console.log("  ok   " + label);
  } else {
    fail += 1;
    console.log(
      "  FAIL " + label + "：期望 " + JSON.stringify(expected) +
        "，实际 " + JSON.stringify(actual)
    );
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stopTree(proc) {
  if (!proc || proc.killed || proc.exitCode !== null) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      proc.kill();
    }
  } catch {
    /* 关不掉就算了，删目录那步还有重试 */
  }
}

function firstExisting(list) {
  for (const p of list) if (p && fs.existsSync(p)) return p;
  return "";
}

function findBrowser() {
  if (process.env.EDGE_PATH) return firstExisting([process.env.EDGE_PATH]);
  const local = process.env.LOCALAPPDATA || "";
  return firstExisting([
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    path.join(local, "Microsoft", "Edge", "Application", "msedge.exe"),
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
  ]);
}

function findPython() {
  const cands = [];
  if (process.env.XIAOLI_PYTHON) cands.push(process.env.XIAOLI_PYTHON);
  const bases = [
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Python"),
    "C:\\Program Files",
  ];
  for (const base of bases) {
    try {
      for (const name of fs.readdirSync(base)) {
        if (/^Python\d/i.test(name)) cands.push(path.join(base, name, "python.exe"));
      }
    } catch {
      /* 这个目录不存在就算了 */
    }
  }
  const found = spawnSync("where.exe", ["python.exe"], { encoding: "utf8" });
  if (found.status === 0) {
    for (const line of String(found.stdout || "").split(/\r?\n/)) {
      if (line.trim()) cands.push(line.trim());
    }
  }
  cands.push("D:\\msys64\\ucrt64\\bin\\python.exe");
  for (const p of cands) {
    if (!p || !fs.existsSync(p)) continue;
    const r = spawnSync(p, ["-c", "import http.server, json, mimetypes, urllib.request"], {
      stdio: "ignore",
    });
    if (r.status === 0) return p;
  }
  return "";
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.pageErrors = [];
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(JSON.stringify(m.error)));
        else p.resolve(m.result);
        return;
      }
      if (m.method === "Runtime.exceptionThrown") {
        const d = (m.params && m.params.exceptionDetails) || {};
        this.pageErrors.push(
          "未捕获异常：" + ((d.exception && d.exception.description) || d.text || "?")
        );
      }
      if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
        this.pageErrors.push("console.error：" + JSON.stringify(m.params.args));
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

let cdp = null;

async function ev(expr) {
  const r = await cdp.send("Runtime.evaluate", {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(
      "页面里的表达式报错了：" + ((d.exception && d.exception.description) || d.text || "?")
    );
  }
  return r.result.value;
}

async function waitFor(expr, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let got = false;
    try {
      got = Boolean(await ev(expr));
    } catch {
      got = false;
    }
    if (got) return true;
    if (Date.now() > deadline) return false;
    await sleep(100);
  }
}

const readData = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

/** 往弹窗 / 编辑器里几个框填值（这里也用来填笔记的标题正文） */
const setFields = (map) =>
  ev("(()=>{const set=(id,v)=>{const el=document.getElementById(id);if(el)el.value=v;};" +
     Object.entries(map).map(([k, v]) => "set('" + k + "','" + v + "');").join("") +
     "return true;})()");

/** 往笔记的图片区塞一张真图（CDP 的 setFileInputFiles 会顺带触发 change） */
async function attachFile(filePath) {
  const { root } = await cdp.send("DOM.getDocument");
  const { nodeId } = await cdp.send("DOM.querySelector", {
    nodeId: root.nodeId,
    selector: ".note-main .attach-input",
  });
  if (!nodeId) throw new Error("找不到笔记图片区里的文件输入框");
  await cdp.send("DOM.setFileInputFiles", { files: [filePath], nodeId });
  await sleep(700);   // 给它压缩 + 画预览的时间
}

async function main() {
  if (typeof WebSocket !== "function") {
    console.log("\n⚠ 跳过：Node 太老（要 22+，用它内置的 fetch / WebSocket 说 CDP）。");
    return "skip";
  }
  const browser = findBrowser();
  if (!browser) {
    console.log("\n⚠ 跳过：这台机器上没找到 Edge / Chrome。");
    return "skip";
  }
  const python = findPython();
  if (!python) {
    console.log("\n⚠ 跳过：没找到能用的 Python 3（要能 import http.server）。");
    return "skip";
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "小李-笔记-"));
  const dataDir = path.join(tmp, "数据");
  const profile = path.join(tmp, "浏览器");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(profile, { recursive: true });

  const dataFile = path.join(dataDir, "数据.json");
  fs.writeFileSync(
    dataFile,
    JSON.stringify({
      version: 1, rev: 0, memo: "",
      notes: [],
      tasks: [], projects: [], trash: [], settings: {},
    }),
    "utf8"
  );

  let server = null;
  let edge = null;
  try {
    const port = await freePort();
    server = spawn(
      python,
      [path.join(ROOT, "app", "服务.py"), "--port", String(port), "--no-browser"],
      {
        env: { ...process.env, XIAOLI_DATA_DIR: dataDir, PYTHONIOENCODING: "utf-8" },
        windowsHide: true,
      }
    );
    server.serverLog = "";
    for (const stream of [server.stdout, server.stderr]) {
      stream.on("data", (chunk) => {
        server.serverLog += chunk.toString("utf8");
      });
    }

    const base = "http://127.0.0.1:" + port + "/";
    let up = false;
    for (let i = 0; i < 80 && !up; i += 1) {
      try {
        const res = await fetch(base + "api/health");
        up = res.ok;
      } catch {
        up = false;
      }
      if (!up) await sleep(250);
    }
    if (!up) {
      console.log("\n服务没起来，它自己这么说：");
      console.log(server.serverLog.trim() || "（一个字都没输出）");
      ok(false, "临时服务起得来");
      return;
    }
    console.log("临时数据目录：" + dataDir);

    const debugPort = await freePort();
    edge = spawn(
      browser,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--window-size=1280,900",
        "--user-data-dir=" + profile,
        "--remote-debugging-port=" + debugPort,
        "about:blank",
      ],
      { windowsHide: true, stdio: "ignore" }
    );

    let target = null;
    for (let i = 0; i < 80 && !target; i += 1) {
      try {
        const list = await (await fetch("http://127.0.0.1:" + debugPort + "/json/list")).json();
        target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl) || null;
      } catch {
        target = null;
      }
      if (!target) await sleep(250);
    }
    if (!target) {
      ok(false, "无头浏览器起得来（调试端口没响应）");
      return;
    }

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    cdp = new CDP(ws);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("DOM.enable");
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });

    await cdp.send("Page.navigate", { url: base + "#note" });
    await waitFor('document.readyState === "complete"', 15000);
    ok(await waitFor('!!document.querySelector(\'[data-act="note-new"]\')', 15000),
      "笔记页起来了");
    ok(await ev('!!document.querySelector(".note-empty")'), "还没有笔记时给一句空状态");
    ok(await ev('!!document.querySelector(".note-pick-hint")'), "右边写着「选一条或新建」");

    /* ---- 新建一条并写正文 ---- */
    console.log("\n新建一条：写标题与正文，左边列表跟着出现");
    await ev('document.querySelector(\'[data-act="note-new"]\').click()');
    ok(await waitFor('!!document.getElementById("note-body")', 5000), "编辑器出来了");
    await sleep(400);     // 落盘是异步的（先写内存、再 POST），等它落下来
    eq(readData(dataFile).notes.length, 1, "数据里多了一条空笔记");
    await ev('(()=>{const t=document.getElementById("note-title");t.value="第一篇";' +
      't.dispatchEvent(new Event("input",{bubbles:true}));return true;})()');
    await ev('(()=>{const b=document.getElementById("note-body");' +
      'b.value="# 你好\\n\\n- 一\\n- 二";b.dispatchEvent(new Event("input",{bubbles:true}));' +
      'return true;})()');
    await sleep(700);     // 打字走的是「静默保存」，写盘延迟 400ms
    const saved = readData(dataFile).notes[0];
    eq(saved.title, "第一篇", "标题静默存下了");
    eq(saved.body, "# 你好\n\n- 一\n- 二", "正文原样存（Markdown 源码）");
    // 打字时不重画（免得光标跳），所以左边列表要等「离开输入框」那一下才刷新
    await ev('document.getElementById("note-body").dispatchEvent(new Event("change",{bubbles:true}))');
    await sleep(400);
    eq(await ev('document.querySelector(".note-row .nr-title").textContent'), "第一篇",
      "左边列表上写着标题");
    ok((await ev('document.querySelector(".note-row .nr-sub").textContent')).includes("你好"),
      "列表上给了一句摘要");

    /* ---- 改标题、离开输入框：列表刷新 ---- */
    console.log("\n改标题、离开输入框：列表跟着刷新（就地保存）");
    await ev('(()=>{const t=document.getElementById("note-title");t.value="第一篇（改过）";' +
      't.dispatchEvent(new Event("change",{bubbles:true}));return true;})()');
    await sleep(700);
    eq(await ev('document.querySelector(".note-row .nr-title").textContent'), "第一篇（改过）",
      "列表上的标题也跟着变了");
    eq(readData(dataFile).notes[0].title, "第一篇（改过）", "数据里也存下了");

    /* ---- 再建一条 + 列表筛选 ---- */
    console.log("\n再建一条，然后用筛选框就地筛");
    await ev('document.querySelector(\'[data-act="note-new"]\').click()');
    await waitFor('!!document.getElementById("note-body")', 5000);
    await ev('(()=>{const t=document.getElementById("note-title");t.value="第二篇";' +
      't.dispatchEvent(new Event("input",{bubbles:true}));return true;})()');
    await sleep(300);
    eq(await ev('document.querySelectorAll(".note-row").length'), 2, "列表里两条");
    await ev('(()=>{const f=document.getElementById("note-filter");f.value="第二";' +
      'f.dispatchEvent(new Event("input",{bubbles:true}));return true;})()');
    await sleep(300);
    eq(await ev('document.querySelectorAll(".note-row").length'), 1, "筛完只剩一条");
    eq(await ev('document.querySelector(".note-row .nr-title").textContent'), "第二篇",
      "剩下的是第二篇");
    ok(await ev('!!document.getElementById("note-body")'), "筛完编辑器还在（没被冲掉）");
    await ev('(()=>{const f=document.getElementById("note-filter");f.value="";' +
      'f.dispatchEvent(new Event("input",{bubbles:true}));return true;})()');
    await sleep(300);
    eq(await ev('document.querySelectorAll(".note-row").length'), 2, "清空筛选又都回来了");

    /* ---- 点列表换着写 ---- */
    console.log("\n点左边列表换着写");
    await ev('(()=>{const rows=[...document.querySelectorAll(".note-row")];rows[1].click();return true;})()');
    await sleep(400);
    eq(await ev('document.getElementById("note-title").value'), "第一篇（改过）",
      "点第二条（更早那条）→ 编辑器换成它");
    ok(await ev('!!document.querySelector(".note-row.active")'), "选中的那条在列表上标出来了");

    /* ---- 预览：Markdown 真渲染出来了 ---- */
    console.log("\n打开预览：h1 和列表真渲染出来了");
    ok(await ev('!!document.querySelector(\'[data-act="note-preview"]\')'), "有「预览」开关");
    await ev('(()=>{const b=document.getElementById("note-body");' +
      'b.value="# 标题一\\n\\n- 甲\\n- 乙";b.dispatchEvent(new Event("change",{bubbles:true}));' +
      'return true;})()');
    await sleep(400);
    await ev('document.querySelector(\'[data-act="note-preview"]\').click()');
    ok(await waitFor('!!document.querySelector(".note-render")', 5000), "预览区出来了");
    eq(await ev('document.querySelector(".note-render .md-h1").textContent'), "标题一",
      "预览里 h1 出来了");
    eq(await ev('document.querySelectorAll(".note-render .md-li").length'), 2, "两条列表项");
    await ev('document.querySelector(\'[data-act="note-preview"]\').click()');
    await sleep(300);
    eq(await ev('!!document.querySelector(".note-render")'), false, "再点一下收起预览");

    /* ---- 标签：输进去、存下来、列表上出胶囊 ---- */
    console.log("\n标签：输入 → 存进数据 → 列表上出胶囊");
    await ev('(()=>{const t=document.getElementById("note-tags");t.value="想法, 开发";' +
      't.dispatchEvent(new Event("change",{bubbles:true}));return true;})()');
    await sleep(400);
    // 这会儿编辑器里开着的是「第一篇（改过）」（上面点过它），所以标签落在它身上
    eqDeep(readData(dataFile).notes.find((n) => n.title === "第一篇（改过）").tags,
      ["想法", "开发"], "标签存成了数组");
    ok(await ev('(()=>{const row=[...document.querySelectorAll(".note-row")]' +
      '.find(r=>r.textContent.includes("第一篇（改过）"));' +
      'return !!row && !!row.querySelector(".tag-chip");})()'), "列表那一行上有标签胶囊");

    /* ---- 贴图：真上传一张 ---- */
    console.log("\n贴一张图：真上传，路径写进这条笔记");
    await attachFile(path.join(ROOT, "docs", "screenshots", "home-light.png"));
    ok(await ev('!!document.querySelector(\'[data-act="note-save-img"]\')'),
      "有图待存时出现「保存图片」按钮");
    await ev('document.querySelector(\'[data-act="note-save-img"]\').click()');
    await sleep(900);
    const withImg = readData(dataFile).notes.find((n) => n.title === "第一篇（改过）");
    eq(withImg.imagePaths.length, 1, "图片路径写进了这条笔记");
    ok(withImg.imagePaths[0].startsWith("attachments/note/"),
      "存的是 note 这个目录（" + withImg.imagePaths[0] + "）");

    /* ---- 删掉进回收站 ---- */
    console.log("\n删掉一条：进回收站，列表少一条");
    await ev('document.querySelector(\'[data-act="note-del"]\').click()');
    ok(await waitFor('!!document.querySelector(\'.dlg-backdrop [data-dlg="yes"]\')', 5000),
      "删除前问了一句");
    await ev('document.querySelector(\'.dlg-backdrop [data-dlg="yes"]\').click()');
    await sleep(400);
    eq(readData(dataFile).notes.length, 1, "数据里剩一条");
    eq(await ev('document.querySelectorAll(".note-row").length'), 1, "列表里也剩一条");
    eq(readData(dataFile).trash.length, 1, "删掉的那条进了回收站");
    ok(await ev('!!document.querySelector(".note-pick-hint")'), "删完右边回到「选一条」的提示");

    /* ---- 全程不该冒 JS 报错 ---- */
    const errors = cdp.pageErrors.filter((t) => !/favicon/i.test(t));
    eq(errors.length, 0, "整个过程页面里没冒出 JS 报错");
    if (errors.length) console.log("      " + errors.slice(0, 3).join("\n      "));
  } finally {
    stopTree(edge);
    stopTree(server);
    await sleep(600);
    const full = path.resolve(tmp);
    const rel = path.relative(path.resolve(os.tmpdir()), full);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel) &&
        path.basename(full).startsWith("小李-笔记-")) {
      try {
        fs.rmSync(full, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      } catch {
        console.log("（临时目录这次没删掉：" + full + "，手动删掉就行，不影响上面的结论）");
      }
    } else {
      console.log("（临时目录没敢删，路径看着不对：" + full + "）");
    }
  }
  return "ran";
}

let how = "ran";
try {
  how = await main();
} catch (err) {
  fail += 1;
  console.log("\n  FAIL 测试脚本自己挂了：" + (err && err.message ? err.message : err));
}

if (how === "skip") {
  console.log("\n（这台机器上没有浏览器 / Python，这次跳过，不算通过。）");
} else {
  console.log("\n通过 " + pass + " 项，失败 " + fail + " 项");
  if (fail > 0) process.exitCode = 1;
}
