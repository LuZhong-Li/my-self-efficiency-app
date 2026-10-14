/* 素材库（全站版）的真浏览器回归测试：在素材库建一份「文本片段」→ 去今日计划加一条任务、
 * 弹窗里勾上它 → 任务上只存素材 id → 回素材库看「被 1 处引用」→ 删素材 → 那条任务的
 * 引用被摘干净。
 *
 * 为什么单独有一份：纯逻辑那份（tests\素材计算.test.mjs）盯的是计数与摘引用，
 * 盯不住「素材真搬到了顶层表没、别的模块弹窗里真能勾到没、跨表那句『被 N 处引用』
 * 是不是现算的、删素材时真把各处的引用摘了没」。
 *
 * 跑法：node tests\素材全站.test.mjs
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

const setFields = (map) =>
  ev("(()=>{const set=(id,v)=>{const el=document.getElementById(id);if(el)el.value=v;};" +
     Object.entries(map).map(([k, v]) => "set('" + k + "','" + v + "');").join("") +
     "return true;})()");

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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "小李-素材全站-"));
  const dataDir = path.join(tmp, "数据");
  const profile = path.join(tmp, "浏览器");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(profile, { recursive: true });

  const dataFile = path.join(dataDir, "数据.json");
  fs.writeFileSync(
    dataFile,
    JSON.stringify({
      version: 1, rev: 0, memo: "",
      assets: [], mediaAssets: [],
      tasks: [], contents: [], notes: [], trash: [], settings: {},
      finance: { accounts: [{ id: "acc-1", name: "现金", initialBalanceCents: 0 }],
                 transactions: [], transfers: [], templates: [],
                 budget: { monthlyTotalCents: 0, categoryCents: {} } },
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

    /* 1) 在素材库建一份「文本片段」 */
    await cdp.send("Page.navigate", { url: base + "#media/assets" });
    await waitFor('document.readyState === "complete"', 15000);
    ok(await waitFor('!!document.querySelector(\'[data-act="asset-new"]\')', 15000),
      "素材库页起来了");
    await ev('document.querySelector(\'[data-act="asset-new"]\').click()');
    ok(await waitFor('!!document.getElementById("asset-title")', 5000), "素材弹窗开了");
    ok(await ev('!!document.querySelector(\'[data-act="asset-kind"][data-kind="text"]\')'),
      "素材弹窗里有「文本片段」这一档");
    await ev('document.querySelector(\'[data-act="asset-kind"][data-kind="text"]\').click()');
    await sleep(200);
    await setFields({ "asset-title": "常用话术", "asset-text": "你好，我是小李" });
    await ev('document.querySelector(\'[data-dlg-act="save"]\').click()');
    await sleep(500);
    const asset = readData(dataFile).assets[0];
    ok(Boolean(asset), "文本片段存进了顶层 assets 表");
    eq(asset.kind, "text", "类型是文本片段");
    eq(asset.text, "你好，我是小李", "正文存下来了");

    /* 2) 去今日计划加一条任务，弹窗里勾上它 */
    console.log("\n别的模块的弹窗里也能勾素材（今日计划）");
    await ev('location.hash = "#plan"');
    await waitFor('!!document.querySelector(\'[data-act="add"]\')', 8000);
    await ev('document.querySelector(\'[data-act="add"]\').click()');
    ok(await waitFor('!!document.querySelector(\'[data-assets="assetIds"]\')', 5000),
      "今日计划的弹窗里有素材那一块");
    ok(await ev('document.querySelector(".asset-pick-list").textContent.includes("常用话术")'),
      "清单里看得到刚建的那份素材");
    await ev('(()=>{const b=document.querySelector(\'[data-assets="assetIds"] [data-asset-pick]\');' +
      'b.checked=true;b.dispatchEvent(new Event("change",{bubbles:true}));return true;})()');
    await setFields({ "item-text": "引用一份素材" });
    await ev('document.querySelector(\'[data-dlg-act="save"]\').click()');
    await sleep(600);
    eqDeep(readData(dataFile).tasks[0].assetIds, [asset.id], "任务上只存了那份素材的 id");
    ok(await ev('[...document.querySelectorAll(".task")].some(li=>li.textContent.includes("素材 1"))'),
      "今日计划那一行上带着「素材 1」的标记");

    /* 3) 回素材库看「被 1 处引用」 */
    console.log("\n回素材库：那句引用计数是跨表现算的");
    await ev('location.hash = "#media/assets"');
    await waitFor('!!document.querySelector(".asset-row")', 8000);
    eq(await ev('document.querySelector(".asset-row .i-meta").textContent'), "被 1 处引用",
      "素材行上写着「被 1 处引用」");
    ok((await ev('document.querySelector(".asset-row .i-meta").title')).includes("待办 1"),
      "悬停提示里说清是「待办 1」");

    /* 4) 记账的弹窗里也能勾素材（手写弹窗也接上了） */
    console.log("\n记账的弹窗里也能勾素材");
    await ev('location.hash = "#finance"');
    await waitFor('!!document.querySelector(\'[data-act="add"]\')', 8000);
    await ev('document.querySelector(\'[data-act="add"]\').click()');
    ok(await waitFor('!!document.querySelector("[data-assets=\'tx-assets\']")', 5000),
      "记账弹窗里有素材那一块");
    await ev('(()=>{const b=document.querySelector(\'[data-assets="tx-assets"] [data-asset-pick]\');' +
      'b.checked=true;b.dispatchEvent(new Event("change",{bubbles:true}));return true;})()');
    await setFields({ "tx-amount": "12", "tx-note": "带素材的一笔" });
    await ev('document.querySelector(\'[data-dlg-act="save"]\').click()');
    await sleep(600);
    const tx = readData(dataFile).finance.transactions[0];
    ok(Boolean(tx), "账目存下来了");
    eqDeep(tx.assetIds, [asset.id], "账目上只存了那份素材的 id");

    /* 5) 笔记编辑器里也能挂素材 */
    console.log("\n笔记编辑器里也能挂素材");
    await ev('location.hash = "#note"');
    await waitFor('!!document.querySelector(\'[data-act="note-new"]\')', 8000);
    await ev('document.querySelector(\'[data-act="note-new"]\').click()');
    ok(await waitFor('!!document.querySelector("[data-assets=\'note-assets\']")', 5000),
      "笔记编辑器里有素材那一块");
    await ev('(()=>{const b=document.querySelector(\'[data-assets="note-assets"] [data-asset-pick]\');' +
      'b.checked=true;b.dispatchEvent(new Event("change",{bubbles:true}));return true;})()');
    await sleep(500);
    eqDeep(readData(dataFile).notes[0].assetIds, [asset.id], "笔记上只存了那份素材的 id");

    /* 6) 删素材 → 各处的引用都被摘干净 */
    console.log("\n删素材：各处的引用跟着摘掉（记录本身不动）");
    await ev('location.hash = "#media/assets"');
    await waitFor('!!document.querySelector(".asset-row")', 8000);
    eq(await ev('document.querySelector(".asset-row .i-meta").textContent'), "被 3 处引用",
      "现在写着「被 3 处引用」（待办 + 账目 + 笔记）");
    await ev('document.querySelector(\'.asset-row [data-act="asset-del"]\').click()');
    await waitFor('!!document.querySelector(\'.dlg-backdrop [data-dlg="yes"]\')', 5000);
    const delMsg = await ev('document.querySelector(".dlg-copy p").textContent');
    ok(delMsg.includes("被 3 处引用着") && delMsg.includes("待办 1")
      && delMsg.includes("账目 1") && delMsg.includes("笔记 1"),
      "确认框里写明几处、在哪（" + delMsg.slice(0, 28) + "…）");
    await ev('document.querySelector(\'.dlg-backdrop [data-dlg="yes"]\').click()');
    await sleep(500);
    const after = readData(dataFile);
    eq(after.assets.length, 0, "素材删掉了（进回收站）");
    eqDeep(after.tasks[0].assetIds, [], "那条任务的引用被摘干净了");
    eqDeep(after.finance.transactions[0].assetIds, [], "那笔账目的引用也被摘干净了");
    eqDeep(after.notes[0].assetIds, [], "那篇笔记的引用也被摘干净了");
    ok(after.tasks[0].text === "引用一份素材", "任务本身一个字没动");

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
        path.basename(full).startsWith("小李-素材全站-")) {
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
