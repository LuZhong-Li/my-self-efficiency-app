/* 自媒体「素材库」的真浏览器回归测试：建一份链接素材 + 一份真上传的图片素材 →
 * 作品弹窗里勾上 → 作品行上出现「素材 1」→ 素材页写着「用在 1 条作品上」→
 * 删素材时引用跟着摘掉（作品本身不动）。
 *
 * 为什么单独有一份：纯逻辑那份（tests\自媒体计算.test.mjs）盯的是规整与摘引用，
 * 盯不住「子页真切得过去没、图真传上去了没、勾选真存进作品没、删的时候作品动没动」。
 * 图片那一步走的是真上传（CDP 的 DOM.setFileInputFiles），不是往数据文件里塞一条 ——
 * 上传链路（压缩、落盘、路径写回）只有真走一遍才算验过。
 *
 * 跑法：node tests\自媒体素材.test.mjs
 *   要 Node 22+（内置 fetch / WebSocket 直接说 CDP，不装 puppeteer）；
 *   要本机有 Edge（找不到会退回 Chrome，也可以用 EDGE_PATH 指一个）。
 *   全程在一个临时数据目录里跑，不碰 数据\数据.json，跑完自己清干净。
 * 说明：和别的 .test.mjs 一样不进「自检.cmd」——自检保持纯 Python。
 *      这台机器上没有浏览器 / Python 时打印「跳过」并以 0 退出，
 *      免得换台电脑一跑就红（跳过不等于通过，别把它当成绿灯）。
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

/** 素材页此刻的样子 */
const assetsNow = () =>
  ev(`(()=>{
    const rows=[...document.querySelectorAll('.asset-row')];
    return {
      hash: location.hash,
      empty: (document.querySelector('.empty-state')||{}).textContent ? true : false,
      emptyText: ((document.querySelector('.empty-state')||{}).textContent || "").replace(/\\s+/g,' ').trim(),
      rows: rows.map(li=>({
        title: (li.querySelector('.i-title')||{}).textContent || "",
        meta: (li.querySelector('.i-meta')||{}).textContent || "",
        url: (li.querySelector('.asset-url')||{}).getAttribute ? li.querySelector('.asset-url').getAttribute('href') : "",
        img: !!li.querySelector('.asset-thumb img'),
      })),
    };
  })()`);

/** 作品行此刻的样子 */
const workRowNow = (title) =>
  ev(`(()=>{
    const li=[...document.querySelectorAll('.items > li')]
      .find(x=>x.textContent.includes(${JSON.stringify(String(title))}));
    return li ? { text: li.textContent.replace(/\\s+/g,' ').trim() } : null;
  })()`);

async function setFields(map) {
  await ev(`(()=>{
    const set=(id,v)=>{const el=document.getElementById(id); if(el) el.value=v;};
    ${Object.entries(map)
      .map(([id, v]) => `set(${JSON.stringify(id)}, ${JSON.stringify(String(v))});`)
      .join("")}
    return true;
  })()`);
  await sleep(150);
}

async function clickDialog(act) {
  const done = await ev(
    "(()=>{const b=document.querySelector('[data-dlg-act=\"" + act + "\"]');" +
      "if(!b)return false;b.click();return true;})()"
  );
  await sleep(400);
  return done;
}

/** 往弹窗里那个文件框塞一张真图片（CDP 的 setFileInputFiles 会顺带触发 change） */
async function attachFile(filePath) {
  const { root } = await cdp.send("DOM.getDocument");
  const { nodeId } = await cdp.send("DOM.querySelector", {
    nodeId: root.nodeId,
    selector: ".dlg .attach-input",
  });
  if (!nodeId) throw new Error("找不到弹窗里的文件输入框");
  await cdp.send("DOM.setFileInputFiles", { files: [filePath], nodeId });
  await sleep(600);   // 给它压缩 + 画预览的时间
}

const readData = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "小李-自媒体素材-"));
  const dataDir = path.join(tmp, "数据");
  const profile = path.join(tmp, "浏览器");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(profile, { recursive: true });

  // 拿来上传的那张图：直接用仓库自带的一张截图（真 PNG，必然解码得了）。
  // 手写一个 1×1 PNG 的 base64 试过，`createImageBitmap` 当场说「解不出来」——
  // 与其在测试里拼字节，不如拿一个肯定没问题的真文件。
  const pngPath = path.join(ROOT, "docs", "screenshots", "home-light.png");

  const dataFile = path.join(dataDir, "数据.json");
  fs.writeFileSync(
    dataFile,
    JSON.stringify({
      version: 1,
      rev: 0,
      memo: "",
      mediaAccounts: [
        { id: "acc-a", name: "B站小李", platform: "B站", intro: "", baseFollowers: 1000,
          targetFollowers: 5000, note: "", createdAt: "" },
      ],
      contents: [
        { id: "c1", accountId: "acc-a", platform: "B站", title: "第一期选题",
          status: "待发布", planDate: "", publishDate: "", link: "", views: 0, likes: 0,
          comments: 0, collects: 0, fansGain: 0, note: "", createdAt: "" },
      ],
      mediaFollowers: [],
      mediaAssets: [],
      settings: {},
      trash: [],
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

    await cdp.send("Page.navigate", { url: base + "#media" });
    await waitFor('document.readyState === "complete"', 15000);
    ok(await waitFor("!!document.querySelector('.fin-subtab')", 15000), "自媒体页起来了");

    /* ---- 子 Tab 切到素材页 ---- */
    console.log("\n子 Tab 里切到「素材」：一开始是空的");
    ok(
      await ev(`(()=>{
        const tab=[...document.querySelectorAll('.fin-subtab')].find(a=>a.textContent.includes('素材'));
        if(!tab) return false;
        tab.click();
        return true;
      })()`),
      "有「素材」子 Tab 并点得动"
    );
    await waitFor("location.hash === '#media/assets'", 5000);
    await waitFor("!!document.querySelector('.empty-state')", 5000);
    let view = await assetsNow();
    eq(view.hash, "#media/assets", "地址切到了 #media/assets");
    eq(view.empty, true, "空状态出来了");
    ok(view.emptyText.includes("还没有素材"), "空状态那句话（" + view.emptyText.slice(0, 20) + "…）");

    /* ---- 建一份链接素材 ---- */
    console.log("\n加一份链接素材：填标题和链接，列表里出现它");
    await ev("document.querySelector('[data-act=\"asset-new\"]').click()");
    ok(await waitFor("!!document.getElementById('asset-title')", 5000), "弹窗开了（默认是图片那一档）");
    await ev("document.querySelector('[data-act=\"asset-kind\"][data-kind=\"link\"]').click()");
    await waitFor("!!document.getElementById('asset-url')", 5000);
    await setFields({ "asset-title": "素材站参考", "asset-url": "https://example.com/ref" });
    await clickDialog("save");
    view = await assetsNow();
    eq(view.rows.length, 1, "列表里一份素材");
    eq(view.rows[0].title, "素材站参考", "标题对");
    eq(view.rows[0].url, "https://example.com/ref", "链接可点");
    eq(view.rows[0].meta, "还没被用过", "还没挂到作品上");

    console.log("\n链接填得不对：当场说一句、存不进去");
    await ev("document.querySelector('[data-act=\"asset-new\"]').click()");
    await waitFor("!!document.getElementById('asset-title')", 5000);
    await ev("document.querySelector('[data-act=\"asset-kind\"][data-kind=\"link\"]').click()");
    await waitFor("!!document.getElementById('asset-url')", 5000);
    await setFields({ "asset-title": "错的", "asset-url": "随便写的" });
    await clickDialog("save");
    ok(await ev("!!document.getElementById('asset-url')"), "弹窗没关（拦住了）");
    ok(
      (await ev("document.getElementById('asset-err').textContent")).includes("http"),
      "说清链接要 http 开头"
    );
    await clickDialog("cancel");

    /* ---- 建一份图片素材（真上传） ---- */
    console.log("\n加一份图片素材：真塞一张图进去，落到 attachments/media_asset/");
    await ev("document.querySelector('[data-act=\"asset-new\"]').click()");
    await waitFor("!!document.getElementById('asset-title')", 5000);
    await setFields({ "asset-title": "封面：第一期" });
    await attachFile(pngPath);
    await clickDialog("save");
    view = await assetsNow();
    eq(view.rows.length, 2, "两份素材了");
    const imgRow = view.rows.find((r) => r.title === "封面：第一期");
    ok(Boolean(imgRow), "图片那份在列表里");
    eq(imgRow.img, true, "它画出了缩略图（说明真有图）");
    // 2026-10-14 晚：素材搬去顶层 assets 表了（全站版），这里跟着改键名
    const saved = readData(dataFile).assets.find((a) => a.title === "封面：第一期");
    ok(saved.path.startsWith("attachments/media_asset/"), "路径落在新目录里（" + saved.path + "）");
    ok(fs.existsSync(path.join(dataDir, saved.path)), "那个文件真的写进数据目录了");

    /* ---- 作品弹窗里勾上 ---- */
    console.log("\n作品弹窗里勾上图片那份：保存后行上出现「素材 1」");
    await ev("location.hash='#media'");
    await waitFor("!!document.querySelector('[data-act=\"edit\"]')", 8000);
    await ev(`(()=>{
      const li=[...document.querySelectorAll('.items > li')].find(x=>x.textContent.includes('第一期选题'));
      li.querySelector('[data-act="edit"]').click();
      return true;
    })()`);
    ok(await waitFor("!!document.getElementById('w-assets')", 5000), "作品弹窗里有「素材」那一格");
    const picks = await ev(`(()=>[...document.querySelectorAll('#w-assets .asset-pick input')]
      .map(i=>({ id:i.value, label:i.closest('.asset-pick').textContent.trim() })))()`);
    eq(picks.length, 2, "两份素材都能勾");
    await ev(`(()=>{
      const box=[...document.querySelectorAll('#w-assets .asset-pick')]
        .find(x=>x.textContent.includes('封面：第一期'));
      box.querySelector('input').click();
      return true;
    })()`);
    await clickDialog("save");
    await sleep(300);
    const row = await workRowNow("第一期选题");
    ok(row && row.text.includes("素材 1"), "作品行上写着「素材 1」（" + (row && row.text) + "）");
    const content = readData(dataFile).contents.find((c) => c.id === "c1");
    eq(content.assetIds.length, 1, "作品里存着一个素材 id");
    eq(content.assetIds[0], saved.id, "存的就是刚勾的那一份");

    /* ---- 素材页那句「用在几条作品上」 ---- */
    console.log("\n回素材页：那一行写着「用在 1 条作品上」");
    await ev("location.hash='#media/assets'");
    await waitFor("!!document.querySelector('.asset-row')", 8000);
    view = await assetsNow();
    eq(view.rows.find((r) => r.title === "封面：第一期").meta, "被 1 处引用",
      "被用着的那份这么说（2026-10-14 起是全站口径，不再只数作品）");
    eq(view.rows.find((r) => r.title === "素材站参考").meta, "还没被用过", "另一份还是没人用");

    /* ---- 删掉没人用的那份 ---- */
    console.log("\n删掉没人用的那份：走确认框，删完列表只剩一份");
    await ev(`(()=>{
      const li=[...document.querySelectorAll('.asset-row')].find(x=>x.textContent.includes('素材站参考'));
      li.querySelector('[data-act="asset-del"]').click();
      return true;
    })()`);
    await waitFor("!!document.querySelector('.dlg-backdrop [data-dlg=\"yes\"]')", 5000);
    const plainMsg = await ev("document.querySelector('.dlg-copy p').textContent");
    ok(plainMsg.includes("还没有人引用它"), "确认框里说清没人用它（" + plainMsg.slice(0, 30) + "…）");
    await ev("document.querySelector('.dlg-backdrop [data-dlg=\"yes\"]').click()");
    await sleep(400);
    eq(readData(dataFile).assets.length, 1, "数据里只剩一份素材");

    /* ---- 删掉被作品用着的那份：引用要跟着摘掉 ---- */
    console.log("\n删掉被用着的那份：确认框写明，删完作品还在、引用摘掉");
    await waitFor("!!document.querySelector('.asset-row')", 5000);
    await ev(`(()=>{
      const li=[...document.querySelectorAll('.asset-row')].find(x=>x.textContent.includes('封面：第一期'));
      li.querySelector('[data-act="asset-del"]').click();
      return true;
    })()`);
    await waitFor("!!document.querySelector('.dlg-backdrop [data-dlg=\"yes\"]')", 5000);
    const usedMsg = await ev("document.querySelector('.dlg-copy p').textContent");
    ok(usedMsg.includes("被 1 处引用着") && usedMsg.includes("作品 1"),
      "确认框里写明几处引用、分别在哪（" + usedMsg.slice(0, 30) + "…）");
    await ev("document.querySelector('.dlg-backdrop [data-dlg=\"yes\"]').click()");
    await sleep(400);
    const after = readData(dataFile);
    eq(after.assets.length, 0, "素材全删完了");
    eq(after.contents.length, 1, "作品还在（删素材不动作品）");
    eq(after.contents[0].assetIds.length, 0, "作品里的引用被摘掉了");
    eq((await assetsNow()).empty, true, "素材页回到空状态");

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
        path.basename(full).startsWith("小李-自媒体素材-")) {
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
