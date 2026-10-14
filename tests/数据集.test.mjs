/* 多数据集（多套数据文件）的真浏览器回归：设置页那张卡片 → 列表 → 点「用这份」→
 * 页面重载 → 状态栏写着新数据集 → 两边的数据互不串（在一份里加东西，另一份里看不见）。
 *
 * 为什么单独有一份：纯逻辑那份（tests\数据集计算.test.mjs）盯的是名字规则和列表顺序，
 * 盯不住「设置页真画出来了没、点一下服务端真换目录了没、切完真重载了没、
 * 状态栏有没有告诉你现在在改哪一份、两份数据会不会串」。
 *
 * 跑法：node tests\数据集.test.mjs
 *   要 Node 22+（内置 fetch / WebSocket 直接说 CDP，不装 puppeteer）；
 *   要本机有 Edge（找不到会退回 Chrome，也可以用 EDGE_PATH 指一个）。
 *   全程在一个临时「数据根目录」里跑，不碰 数据\数据.json，跑完自己清干净。
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

const textOf = (selector) =>
  ev("(()=>{const el=document.querySelector('" + selector + "');return el?el.textContent:null;})()");

/** 点一下「切过去」，然后等页面自己重载完 —— 等的是重载之后才可能成立的那句话 */
async function waitReload(expr, label) {
  await sleep(600);                 // 给 location.reload() 一点时间起步
  const got = await waitFor(expr, 15000);
  ok(got, label);
  return got;
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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "小李-数据集-"));
  // 数据根目录：新布局（一份数据一个子文件夹），一开始就有两份
  const root = path.join(tmp, "数据");
  const profile = path.join(tmp, "浏览器");
  fs.mkdirSync(path.join(root, "默认"), { recursive: true });
  fs.mkdirSync(path.join(root, "工作"), { recursive: true });
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(root, "当前数据集.txt"), "默认\n", "utf8");

  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const today = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());

  const fileY = path.join(root, "默认", "数据.json");
  const fileG = path.join(root, "工作", "数据.json");
  fs.writeFileSync(
    fileY,
    JSON.stringify({
      version: 1, rev: 1, memo: "默认这份",
      tasks: [{
        id: "t-1", date: today, text: "默认里的待办", time: "", category: "工作",
        done: false, note: "", belong: "plan", isTodayPlan: true,
        isArchived: false, archivedAt: "", tags: [], subtasks: [],
      }],
      settings: {}, trash: [],
    }),
    "utf8"
  );
  fs.writeFileSync(
    fileG,
    JSON.stringify({ version: 1, rev: 0, memo: "", tasks: [], settings: {}, trash: [] }),
    "utf8"
  );

  let server = null;
  let edge = null;
  try {
    const port = await freePort();
    const env = { ...process.env, PYTHONIOENCODING: "utf-8", XIAOLI_DATA_ROOT: root };
    delete env.XIAOLI_DATA_DIR;      // 留着它数据集功能就是关着的，这条测试要的是开着
    server = spawn(
      python,
      [path.join(ROOT, "app", "服务.py"), "--port", String(port), "--no-browser"],
      { env, windowsHide: true }
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
    console.log("临时数据根目录：" + root);

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

    /* 1) 设置页那张卡片：现在在用哪一份、有哪些 */
    console.log("\n设置页：数据集列表");
    await cdp.send("Page.navigate", { url: base + "#data" });
    await waitFor('document.readyState === "complete"', 15000);
    ok(await waitFor('!!document.getElementById("ds-list")', 15000), "设置页有数据集列表");
    eq(await textOf("#ds-current"), "默认", "「现在在用」写着 默认");
    const rows = await ev(
      '[...document.querySelectorAll("#ds-list .ds-row")].map(li=>li.textContent)'
    );
    eq(rows.length, 2, "列表里两份都在");
    ok(rows.some((t) => t.includes("默认")) && rows.some((t) => t.includes("工作")),
      "两份的名字都画出来了");
    ok(rows.some((t) => t.includes("默认") && t.includes("在用")),
      "当前那份标着「在用」（" + rows.find((t) => t.includes("默认")) + "）");
    ok(
      await ev('document.querySelector("#ds-msg").textContent.includes("数据根目录")'),
      "写着数据根目录在哪"
    );
    ok(
      await ev('(document.getElementById("foot-file").textContent||"").includes("数据集「默认」")'),
      "状态栏写着「数据集「默认」」（一眼看出在改哪一份）"
    );

    /* 2) 点「用这份」切到另一份 → 整页重载 */
    console.log("\n切到「工作」：先确认，再整页重载");
    await ev('document.querySelector(\'[data-ds-act="use"][data-ds-name="工作"]\').click()');
    ok(await waitFor('!!document.querySelector(\'.dlg-backdrop [data-dlg="yes"]\')', 5000),
      "先弹一个确认框");
    const askMsg = await ev('document.querySelector(".dlg-copy p").textContent');
    ok(askMsg.includes("重载"), "确认框里说清了「会整页重载」（" + askMsg.slice(0, 24) + "…）");
    await ev('document.querySelector(\'.dlg-backdrop [data-dlg="yes"]\').click()');
    await waitReload(
      '(document.getElementById("foot-file")||{textContent:""}).textContent.includes("数据集「工作」")',
      "切过去之后状态栏写着「数据集「工作」」"
    );

    /* 3) 切过去就是另一份数据：那份是空的 */
    console.log("\n切过去之后看的是另一份数据（互不串）");
    eq(fs.readFileSync(path.join(root, "当前数据集.txt"), "utf8").trim(), "工作",
      "当前数据集.txt 换成了 工作");
    await ev('location.hash = "#plan"');
    ok(await waitFor('!!document.querySelector(\'[data-act="add"]\')', 10000), "今日计划页起来了");
    eq(await ev('document.querySelectorAll(".task").length'), 0, "「工作」里一条待办都没有");

    console.log("\n在「工作」里记一条，默认那份不该有这个字");
    await ev('document.querySelector(\'[data-act="add"]\').click()');
    await waitFor('!!document.getElementById("item-text")', 5000);
    await setFields({ "item-text": "工作在写的待办" });
    await ev('document.querySelector(\'[data-dlg-act="save"]\').click()');
    await sleep(700);
    eq(readData(fileG).tasks.length, 1, "「工作」的数据文件里多了一条");
    eq(readData(fileG).tasks[0].text, "工作在写的待办", "就是刚写的那条");
    ok(!JSON.stringify(readData(fileY)).includes("工作在写的待办"),
      "「默认」的数据文件里一个字都没沾上（两边各存各的）");

    /* 4) 切回「默认」：原来那条还在，工作那条不在 */
    console.log("\n切回「默认」：原来的数据还在");
    await ev('location.hash = "#data"');
    ok(await waitFor('!!document.querySelector(\'[data-ds-act="use"][data-ds-name="默认"]\')', 10000),
      "卡片刻着「默认」那一行还有「用这份」");
    await ev('document.querySelector(\'[data-ds-act="use"][data-ds-name="默认"]\').click()');
    await waitFor('!!document.querySelector(\'.dlg-backdrop [data-dlg="yes"]\')', 5000);
    await ev('document.querySelector(\'.dlg-backdrop [data-dlg="yes"]\').click()');
    await waitReload(
      '(document.getElementById("foot-file")||{textContent:""}).textContent.includes("数据集「默认」")',
      "切回来之后状态栏写着「数据集「默认」」"
    );
    eq(fs.readFileSync(path.join(root, "当前数据集.txt"), "utf8").trim(), "默认",
      "当前数据集.txt 换回了 默认");
    await ev('location.hash = "#plan"');
    ok(await waitFor('document.querySelectorAll(".task").length > 0', 10000),
      "今日计划里看得见「默认」那条待办");
    const texts = await ev('[...document.querySelectorAll(".task")].map(li=>li.textContent)');
    ok(texts.some((t) => t.includes("默认里的待办")), "就是「默认」原来那条");
    ok(!texts.some((t) => t.includes("工作在写的待办")), "「工作」那条没跟过来");

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
        path.basename(full).startsWith("小李-数据集-")) {
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
