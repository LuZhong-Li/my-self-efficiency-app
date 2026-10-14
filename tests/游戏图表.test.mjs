/* 游戏娱乐「图表」的真浏览器回归测试：TOP 排行每行铺一条横条（第一名满格）、
 * 近 6 个月柱状图（6 根柱、当月那根和数字卡片上的「本月」一模一样、
 * 没记录的月份是零高柱）。
 *
 * 为什么单独有一份：纯逻辑那份（tests\图表计算.test.mjs）盯的是比例与几何，
 * 盯不住「条真铺到那一行上了没、柱子真画出来几根、图上和卡片上的数是不是同一个」。
 *
 * 跑法：node tests\游戏图表.test.mjs
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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "小李-游戏图表-"));
  const dataDir = path.join(tmp, "数据");
  const profile = path.join(tmp, "浏览器");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(profile, { recursive: true });

  const pad = (n) => String(n).padStart(2, "0");
  const now = new Date();
  const TODAY = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const THIS_MONTH = TODAY.slice(0, 7);
  const LAST_MONTH = (() => {              // 上个月（跨年也算得对）
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  })();

  const dataFile = path.join(dataDir, "数据.json");
  fs.writeFileSync(
    dataFile,
    JSON.stringify({
      version: 1, rev: 0, memo: "",
      games: [
        { id: "g1", name: "只狼", platform: "PC", status: "在玩", targetHours: 0,
          finishDate: "", hours: 0, progress: "", tags: [], imagePaths: [] },
        { id: "g2", name: "空洞骑士", platform: "Switch", status: "在玩", targetHours: 0,
          finishDate: "", hours: 0, progress: "", tags: [], imagePaths: [] },
      ],
      gameRecords: [
        { id: "r1", gameId: "g1", gameName: "只狼", playDate: TODAY, durationMin: 180,
          remark: "", tags: [], imagePaths: [], createAt: "" },
        { id: "r2", gameId: "g2", gameName: "空洞骑士", playDate: TODAY, durationMin: 60,
          remark: "", tags: [], imagePaths: [], createAt: "" },
        { id: "r3", gameId: "g1", gameName: "只狼", playDate: LAST_MONTH + "-05",
          durationMin: 240, remark: "", tags: [], imagePaths: [], createAt: "" },
      ],
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

    await cdp.send("Page.navigate", { url: base + "#game" });
    await waitFor('document.readyState === "complete"', 15000);
    ok(await waitFor('!!document.querySelector(".gm-top")', 15000), "游戏页的 TOP 榜起来了");

    /* ---- TOP 排行：每行都有横条，第一名满格 ---- */
    console.log("\nTOP 榜每行铺一条横条，第一名满格");
    const tops = await ev(`(()=>{
      return [...document.querySelectorAll('.gm-top')].map(li=>({
        name: (li.querySelector('.i-title')||{}).textContent || "",
        chip: (li.querySelector('.chip')||{}).textContent || "",
        width: ((li.querySelector('.bar-fill')||{}).style||{}).width || "",
      }));
    })()`);
    eq(tops.length, 2, "两条记录、两款游戏 → 榜单两行");
    eq(tops[0].name, "只狼", "玩得最多的排第一（这次 3 小时 + 上个月 4 小时）");
    eq(tops[0].chip, "7 小时", "胶囊写着累计时长（" + tops[0].chip + "）");
    eq(tops[0].width, "100%", "第一名满格");
    eq(tops[1].name, "空洞骑士", "第二名是另一款");
    eq(tops[1].width, "14%", "第二名按比例（1 小时 / 7 小时 ≈ 14%）");

    /* ---- 近 6 个月柱状图 ---- */
    console.log("\n柱状图：6 根柱，当月那根和卡片上的「本月」一致");
    ok(await waitFor('!!document.querySelector(".chart-trend")', 8000), "柱状图出来了");
    eq(await ev('document.querySelectorAll(".chart-trend-bar").length'), 6, "正好 6 根柱");
    eq(await ev('document.querySelectorAll(".chart-trend-bar.now").length'), 1, "只有当月那根带 now");
    const months = await ev(
      "[...document.querySelectorAll('.chart-trend-label')].map(t=>t.textContent)");
    eq(months[5], Number(THIS_MONTH.slice(5)) + "月", "最后一根是当月（" + months[5] + "）");
    const chartThis = await ev(`(()=>{
      const bars=[...document.querySelectorAll('.chart-trend-bar')];
      const num=bars[5].querySelector('.chart-trend-num');
      return { text: num ? num.textContent : "",
               h: Number(bars[5].querySelector('rect').getAttribute('height')) };
    })()`);
    ok(chartThis.h > 0, "当月那根柱是有高度的（今天记了 4 小时）");
    eq(chartThis.text, "4 小时", "柱顶写着 4 小时");
    eq(await ev(`(()=>{
      const cell=[...document.querySelectorAll('.gm-stat')].find(x=>x.textContent.includes('本月'));
      return cell.querySelector('strong').textContent;
    })()`), "4 小时", "数字卡片上的「本月」也是 4 小时 —— 图和卡片同源");
    eq(await ev(`(()=>{
      const bars=[...document.querySelectorAll('.chart-trend-bar')];
      return Number(bars[0].querySelector('rect').getAttribute('height'));
    })()`), 0, "半年前那个没有记录的月是一根零高柱（缺不缺一眼看得出）");
    eq(await ev('document.querySelectorAll(".gm-top .bar-fill").length'), 2,
      "两行榜单各有一条横条（一行都没漏）");

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
        path.basename(full).startsWith("小李-游戏图表-")) {
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
