/* 预算提醒的真浏览器回归测试：本月支出到 80% / 100% 时，那句话说没说、
 * 说的对不对、颜色跟没跟上档位 —— 记账页概览、分类预算那一行、首页三处各看一遍。
 *
 * 为什么单独有一份：那句话是「同一个来源、三处显示」（finance-calc 的 budgetNotice），
 * 单测能盯住它怎么算，盯不住「三处是不是都真的挂上去了、档位类名有没有写对」。
 *
 * 跑法：node tests\预算提醒.test.mjs
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

/** 记账页概览里那句提醒 */
const budgetAlertNow = () =>
  ev(`(()=>{
    const p=document.querySelector('#fin-overview .fin-budget-alert');
    return p ? { text: p.textContent.trim(), cls: p.className } : null;
  })()`);

/** 分类预算那一行的尾巴（「已用 85%」/「超 ¥5.00」/ 光一个百分比） */
const catBudgetNow = (category) =>
  ev(`(()=>{
    const li=[...document.querySelectorAll('#fin-overview .fin-catbudget-item')]
      .find(x=>x.textContent.includes(${JSON.stringify(category)}));
    if(!li) return null;
    const tail=li.querySelector('.fin-catbudget-used');
    const i=tail ? tail.querySelector('i') : null;
    return { text: tail ? tail.textContent.trim() : "", mark: i ? i.className : null };
  })()`);

/** 首页那条预算提醒 */
const homeAlertNow = () =>
  ev(`(()=>{
    const a=document.querySelector('.home-alert');
    return a ? { text: a.textContent.replace(/\\s+/g,' ').trim(), cls: a.className,
                 href: a.getAttribute('href') || "" } : null;
  })()`);

async function goFinance() {
  await ev("location.hash='#finance'");
  await waitFor("!!document.querySelector('#fin-overview .fin-budget')", 8000);
}

async function goHome() {
  await ev("location.hash='#home'");
  await waitFor("!!document.querySelector('.home-core')", 8000);
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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "小李-预算提醒-"));
  const dataDir = path.join(tmp, "数据");
  const profile = path.join(tmp, "浏览器");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(profile, { recursive: true });

  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const today = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  const dataFile = path.join(dataDir, "数据.json");

  // 月度总预算 ¥100、餐饮也设 ¥100：先花掉 ¥85（85%，提醒档），
  // 后面把它改成 ¥105（超支档）再看一遍。
  const writeData = (spentCents) => {
    fs.writeFileSync(
      dataFile,
      JSON.stringify({
        version: 1,
        rev: 0,
        memo: "",
        finance: {
          accounts: [{ id: "acc-wx", name: "微信", initialBalanceCents: 0 }],
          transactions: [
            {
              id: "tx-1", type: "expense", amountCents: spentCents, date: today,
              category: "餐饮", accountId: "acc-wx", note: "吃饭", imagePaths: [],
              createdAt: today + " 12:00",
            },
          ],
          transfers: [],
          budget: { monthlyTotalCents: 10000, categoryCents: { 餐饮: 10000 } },
        },
        trash: [],
      }),
      "utf8"
    );
  };
  writeData(8500);

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
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });

    await cdp.send("Page.navigate", { url: base });
    await waitFor('document.readyState === "complete"', 15000);
    ok(await waitFor("!!document.querySelector('.home-core')", 15000), "首页起来了");

    /* ---- 85%：提醒档 ---- */
    console.log("\n花掉 85%：三处都说那句话，颜色是「提醒」那一档");
    await goFinance();
    let alert = await budgetAlertNow();
    ok(Boolean(alert), "记账页概览里有预算提醒那一行");
    eq(alert && alert.text, "已用 85%，快到预算了", "文案带上真实百分比");
    eq(alert && alert.cls.indexOf("lv-warn") >= 0, true, "档位类名是 lv-warn（黄）");

    const cat = await catBudgetNow("餐饮");
    ok(Boolean(cat), "分类预算里有餐饮那一行");
    eq(cat && cat.text.indexOf("已用 85%") >= 0, true, "分类那一行也说了（" + (cat && cat.text) + "）");
    eq(cat && cat.mark, "warn", "分类那行的提示也是「提醒」档（不是红）");

    await goHome();
    let home = await homeAlertNow();
    ok(Boolean(home), "首页上也有那条提醒");
    eq(home && home.text, "本月预算已用 85%，快到预算了", "首页文案前面加了「本月预算」");
    eq(home && home.href, "#finance", "点它回记账页");
    eq(home && home.cls.indexOf("overdue") >= 0, false, "85% 不该是红的那一档");
    eq(home && home.cls.indexOf("home-alert") >= 0, true, "用的是首页那条预警的样式");

    /* ---- 105%：超支档 ---- */
    console.log("\n花到 105%：改成「超了多少」，颜色转红");
    writeData(10500);
    await cdp.send("Page.reload");
    await waitFor('document.readyState === "complete"', 15000);
    ok(await waitFor("!!document.querySelector('.home-core')", 15000), "刷新后首页还在");
    home = await homeAlertNow();
    eq(home && home.text, "本月预算已超 ¥5.00", "首页说清了超多少");
    eq(home && home.cls.indexOf("overdue") >= 0, true, "超支时首页那条转红");

    await goFinance();
    alert = await budgetAlertNow();
    eq(alert && alert.text, "已超 ¥5.00", "记账页那句也说清了超多少");
    eq(alert && alert.cls.indexOf("lv-over") >= 0, true, "档位类名是 lv-over（红）");
    const catOver = await catBudgetNow("餐饮");
    eq(catOver && catOver.text.indexOf("超 ¥5.00") >= 0, true,
      "分类那一行跟着说（" + (catOver && catOver.text) + "）");
    eq(catOver && catOver.mark, "over", "分类那行转红");

    /* ---- 没到 80% 就不打扰 ---- */
    console.log("\n只花了 50%：一句都不说");
    writeData(5000);
    await cdp.send("Page.reload");
    await waitFor('document.readyState === "complete"', 15000);
    await waitFor("!!document.querySelector('#fin-overview .fin-budget')", 15000);
    eq(await budgetAlertNow(), null, "记账页没有提醒那一行");
    const catHalf = await catBudgetNow("餐饮");
    eq(catHalf && catHalf.text.indexOf("50%") >= 0, true, "分类那行照旧只写个百分比");
    eq(await homeAlertNow(), null, "首页也没有那条提醒");

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
        path.basename(full).startsWith("小李-预算提醒-")) {
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
