/* 工时统计的真浏览器回归测试：开发工作里那条 #dev/hours 子页 ——
 * 记一笔工时（项目 + 2 小时）→ 数字格、列表、柱状图、按项目分布都跟着变 →
 * 再记一笔别的项目，横条比例跟着变 → 改时长、删一笔 → 计时条起停。
 *
 * 为什么单独有一份：纯逻辑那份（tests\工时计算.test.mjs）盯的是汇总与分布算法，
 * 盯不住「子页真切得过去没、表单里的『2 小时』真落成 120 分钟没、
 * 图上和数字格是不是同一个数、秒表点得动没」。
 *
 * 跑法：node tests\工时统计.test.mjs
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

/** 工时页上某个数字格此刻写的数 */
const statAt = (label) =>
  ev("(()=>{const c=[...document.querySelectorAll('.wk-stat')]" +
     ".find(x=>x.textContent.includes('" + label + "'));" +
     "return c ? c.querySelector('strong').textContent : '';})()");

/** 记录列表最上面那一行 */
const firstRowNow = () =>
  ev("(()=>{const li=document.querySelector('.wk-row');" +
     "return li ? { text: li.textContent.replace(/\\s+/g,' ').trim()," +
     "chip:(li.querySelector('.chip')||{}).textContent||'' } : null;})()");

/** 按项目分布那几行 */
const byRowsNow = () =>
  ev("(()=>[...document.querySelectorAll('.wk-by-row')].map(li=>({" +
     "text: li.textContent.replace(/\\s+/g,' ').trim()," +
     "width: ((li.querySelector('.bar-fill')||{}).style||{}).width||'' })))()");

/** 往弹窗里几个框填值 */
const setDialog = (map) =>
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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "小李-工时统计-"));
  const dataDir = path.join(tmp, "数据");
  const profile = path.join(tmp, "浏览器");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(profile, { recursive: true });

  const pad = (n) => String(n).padStart(2, "0");
  const now = new Date();
  const TODAY = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

  const dataFile = path.join(dataDir, "数据.json");
  fs.writeFileSync(
    dataFile,
    JSON.stringify({
      version: 1, rev: 0, memo: "",
      projects: [
        { id: "p1", name: "小李（个人工作台）", status: "进行中", intro: "", description: "",
          startDate: "2026-10-01", expectEndDate: "", tags: [], imagePaths: [] },
        { id: "p2", name: "木子工作台", status: "进行中", intro: "", description: "",
          startDate: "2026-10-01", expectEndDate: "", tags: [], imagePaths: [] },
      ],
      workLogs: [],
      tasks: [], issues: [], progress: [], trash: [], settings: {},
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

    await cdp.send("Page.navigate", { url: base + "#dev/hours" });
    await waitFor('document.readyState === "complete"', 15000);
    ok(await waitFor('!!document.querySelector(".wk-stats")', 15000), "工时统计页起来了");
    ok(await ev('!!document.querySelector(\'[data-act="wk-add"]\')'), "头上有「记一笔工时」");
    eq(await statAt("累计"), "0 小时", "一条都没有时累计是 0 小时");
    ok(await ev('!!document.querySelector(".wk-empty")'), "列表给一句空状态");
    ok(await ev('!!document.querySelector(\'[data-act="wk-timer-start"]\')'), "有「开始计时」");

    /* ---- 记一笔：项目 + 2 小时 ---- */
    console.log("\n记一笔工时：数字格、列表、柱状图、分布都跟着变");
    await ev('document.querySelector(\'[data-act="wk-add"]\').click()');
    await waitFor('!!document.getElementById("item-duration")', 5000);
    ok(!(await ev('!!document.querySelector(".dlg .attach-host")')), "工时的弹窗里没有图片区");
    await setDialog({ "item-date": TODAY, "item-duration": "2" });
    await ev('document.getElementById("item-projectId").value = "p1"');
    await sleep(150);
    await ev('document.querySelector(\'[data-dlg-act="save"]\').click()');
    await sleep(500);
    const saved = readData(dataFile).workLogs[0];
    ok(Boolean(saved), "工时存进了数据");
    eq(saved.minutes, 120, "「2 小时」落盘成 120 分钟");
    eq(saved.projectId, "p1", "挂在选的项目上");
    eq(saved.duration, undefined, "数据里没有影子字段");
    eq(await statAt("今日"), "2 小时", "今日 = 2 小时");
    eq(await statAt("累计"), "2 小时", "累计 = 2 小时");
    const row1 = await firstRowNow();
    ok(Boolean(row1), "列表里出现了这一条");
    ok(row1.text.includes("小李（个人工作台）"), "行上写着项目名（" + row1.text + "）");
    eq(row1.chip, "2 小时", "行上那枚胶囊写着 2 小时");
    ok(await waitFor('!!document.querySelector(".chart-trend")', 6000), "柱状图出来了");
    eq(await ev('document.querySelectorAll(".chart-trend-bar").length'), 6, "6 根柱");
    const chartLast = await ev("(()=>{const bars=[...document.querySelectorAll('.chart-trend-bar')];" +
      "return { h: Number(bars[5].querySelector('rect').getAttribute('height'))," +
      "text: (bars[5].querySelector('.chart-trend-num')||{}).textContent||'' };})()");
    ok(chartLast.h > 0, "当月那根柱有高度");
    eq(chartLast.text, "2 小时", "柱顶写着 2 小时");
    let by = await byRowsNow();
    eq(by.length, 1, "分布里就一个项目");
    ok(by[0].text.includes("小李（个人工作台）"), "分布那一行写着项目名");
    eq(by[0].width, "100%", "第一名满格");

    /* ---- 再记一笔别的项目：比例跟着变 ---- */
    console.log("\n再记一笔别的项目：分布两行、条长按比例");
    await ev('document.querySelector(\'[data-act="wk-add"]\').click()');
    await waitFor('!!document.getElementById("item-duration")', 5000);
    await setDialog({ "item-date": TODAY, "item-duration": "1" });
    await ev('document.getElementById("item-projectId").value = "p2"');
    await sleep(150);
    await ev('document.querySelector(\'[data-dlg-act="save"]\').click()');
    await sleep(500);
    eq(readData(dataFile).workLogs.length, 2, "两条工时");
    eq(await statAt("今日"), "3 小时", "今日 = 2 + 1 = 3 小时");
    by = await byRowsNow();
    eq(by.length, 2, "分布两行");
    eq(by[0].width, "100%", "第一名还是满格");
    eq(by[1].width, "50%", "第二名 1 小时 / 2 小时 = 50%");

    /* ---- 编辑改时长 ---- */
    console.log("\n改一笔的时长：数字跟着变");
    await ev('document.querySelector(\'.wk-row [data-act="wk-edit"]\').click()');
    await waitFor('!!document.getElementById("item-duration")', 5000);
    eq(await ev('document.getElementById("item-duration").value'), "1",
      "编辑回填的是 1（列表最上面是最新那条，1 小时）");
    await ev('document.getElementById("item-duration").value = "4"');
    await ev('document.querySelector(\'[data-dlg-act="save"]\').click()');
    await sleep(500);
    eq(await statAt("今日"), "6 小时", "2 + 4 = 6 小时");

    /* ---- 删一笔 ---- */
    console.log("\n删一笔：列表少一行、数字跟着降");
    await ev('document.querySelector(\'.wk-row [data-act="wk-del"]\').click()');
    await waitFor('!!document.querySelector(\'.dlg-backdrop [data-dlg="yes"]\')', 5000);
    await ev('document.querySelector(\'.dlg-backdrop [data-dlg="yes"]\').click()');
    await sleep(400);
    eq(readData(dataFile).workLogs.length, 1, "数据里剩一条");
    eq(await statAt("今日"), "2 小时", "今日回到 2 小时");

    /* ---- 计时条 ---- */
    console.log("\n计时条：开始 → 秒表在走 → 取消 → 变回按钮");
    await ev('document.querySelector(\'[data-act="wk-timer-start"]\').click()');
    await sleep(400);
    ok(await ev('!!document.querySelector(".wk-timer b")'), "开始之后出现秒表");
    const tick = await ev('document.querySelector(".wk-timer b").textContent');
    ok(/^00:00:\d\d$/.test(tick), "秒表走的是 时:分:秒（" + tick + "）");
    await ev('document.querySelector(\'[data-act="wk-timer-cancel"]\').click()');
    await sleep(400);
    ok(await ev('!!document.querySelector(\'[data-act="wk-timer-start"]\')'),
      "取消之后变回「开始计时」");
    eq(readData(dataFile).workLogs.length, 1, "取消不会多记一条");

    /* ---- 项目列表 / 工时统计 两个子页切得过去 ---- */
    console.log("\n子 Tab：从工时页切回项目列表");
    ok(await ev('!!document.querySelector(\'.dev-subtab[href="#dev"]\')'), "页上有「项目列表」页签");
    await ev('location.hash = "#dev"');
    await waitFor('!!document.querySelector(".proj-grid, .card")', 8000);
    ok(await ev('!!document.querySelector(\'.dev-subtab[href="#dev/hours"]\')'),
      "回列表之后「工时统计」页签还在");

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
        path.basename(full).startsWith("小李-工时统计-")) {
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
