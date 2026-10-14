/* 记账「支出日历」热力图的真浏览器回归测试：近 26 周 × 7 天 = 182 格、
 * 今天那格有标记、花得最多的一天在最深那一档、同一天的收入不算进来、
 * 新记一笔之后对应那格的颜色与悬停金额跟着变。
 *
 * 为什么单独有一份：纯逻辑那份（tests\图表计算.test.mjs）盯的是格子算法与分档，
 * 盯不住「网格真铺了 7 行 × 26 列没、那格的颜色类名对不对、悬停说明里的金额是不是
 * 从明细里现算的、记完一笔页面会不会跟着重画」。
 *
 * 跑法：node tests\记账热力图.test.mjs
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

/** 取某一格此刻的样子（类名 + 悬停说明） */
const cellAt = (date) => ev(`(()=>{
  const c=document.querySelector('.hm-cell[data-date="${date}"]');
  return c ? { cls: c.className, title: c.title } : null;
})()`);

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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "小李-记账热力图-"));
  const dataDir = path.join(tmp, "数据");
  const profile = path.join(tmp, "浏览器");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(profile, { recursive: true });

  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (x) => x.getFullYear() + "-" + pad(x.getMonth() + 1) + "-" + pad(x.getDate());
  const now = new Date();
  const TODAY = ymd(now);
  const daysAgo = (n) => ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - n));
  const YESTERDAY = daysAgo(1);

  const dataFile = path.join(dataDir, "数据.json");
  fs.writeFileSync(
    dataFile,
    JSON.stringify({
      version: 1, rev: 0, memo: "",
      finance: {
        accounts: [{ id: "acc-wx", name: "微信", initialBalanceCents: 0 }],
        transactions: [
          { id: "x-today", date: TODAY, type: "expense", amountCents: 100000,
            category: "餐饮", accountId: "acc-wx", note: "今天这顿",
            imagePaths: [], tags: [], createdAt: TODAY + " 12:00" },
          { id: "x-3d", date: daysAgo(3), type: "expense", amountCents: 5000,
            category: "交通", accountId: "acc-wx", note: "三天前",
            imagePaths: [], tags: [], createdAt: daysAgo(3) + " 08:00" },
          { id: "x-3d-in", date: daysAgo(3), type: "income", amountCents: 999999,
            category: "工资", accountId: "acc-wx", note: "同一天的收入",
            imagePaths: [], tags: [], createdAt: daysAgo(3) + " 09:00" },
          { id: "x-old", date: daysAgo(40), type: "expense", amountCents: 20000,
            category: "餐饮", accountId: "acc-wx", note: "更早的一笔",
            imagePaths: [], tags: [], createdAt: daysAgo(40) + " 19:00" },
        ],
        transfers: [], templates: [],
        budget: { monthlyTotalCents: 0, categoryCents: {} },
      },
      debt: { items: [] },
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

    await cdp.send("Page.navigate", { url: base + "#finance" });
    await waitFor('document.readyState === "complete"', 15000);
    ok(await waitFor('!!document.querySelector(".hm-grid")', 15000), "记账页的支出日历出来了");

    /* ---- 网格形状 ---- */
    console.log("\n近 26 周 × 7 天 = 182 格，一周一列");
    eq(await ev('document.querySelectorAll(".hm-cell").length'), 182, "182 格");
    eq(await ev(`(()=>{
      const g=document.querySelector('.hm-grid');
      return getComputedStyle(g).gridTemplateRows.split(' ').length;
    })()`), 7, "网格是 7 行（周一 → 周日）");
    eq(await ev('document.querySelectorAll(".hm-cell.today").length'), 1, "今天那格有标记");
    eq(await ev('document.querySelector(".hm-cell.today").dataset.date'), TODAY,
      "带 today 的就是今天（" + TODAY + "）");
    const todayIndex = await ev(`(()=>{
      const cells=[...document.querySelectorAll('.hm-cell')];
      return cells.findIndex(c=>c.dataset.date===${JSON.stringify(TODAY)});
    })()`);
    ok(todayIndex > 170, "今天是最后一列里的某一天（第 " + (todayIndex + 1) + " 格）");
    eq(await ev('document.querySelectorAll(".hm-cell:not(.out)").length'), todayIndex + 1,
      "到今天为止的格子数 = 今天在网格里的位置 + 1（后面的都是 out）");

    /* ---- 档位与悬停说明 ---- */
    console.log("\n档位对得上：花得最多最深、没花钱最浅");
    const todayCell = await cellAt(TODAY);
    ok(todayCell.cls.includes("hm-l4"), "今天花得最多 → 最高档（" + todayCell.cls + "）");
    ok(todayCell.title.includes("¥1,000") || todayCell.title.includes("¥1000"),
      "悬停说明写着今天的支出（" + todayCell.title + "）");
    const awayCell = await cellAt(daysAgo(3));
    ok(!awayCell.cls.includes("hm-l4"), "三天前那笔（50 元）不在最高档（" + awayCell.cls + "）");
    ok(awayCell.title.includes("50"), "三天前那格的金额是 50 元（同一天的收入不算进来）");
    const oldCell = await cellAt(daysAgo(40));
    ok(Boolean(oldCell), "40 天前那笔落在网格里（26 周够长）");
    ok(oldCell.title.includes("200"), "更早那笔 200 元也在（" + oldCell.title + "）");
    const emptyDay = await cellAt(YESTERDAY);
    ok(emptyDay.cls.includes("hm-l0"), "昨天没花钱 → 最浅那一档（" + emptyDay.cls + "）");

    /* ---- 新记一笔，那格跟着变 ---- */
    console.log("\n新记一笔支出：对应那格的颜色与金额跟着变");
    await ev('document.querySelector(\'[data-act="add"]\').click()');
    ok(await waitFor('!!document.getElementById("tx-amount")', 5000), "记一笔的弹窗开了");
    await ev(`(()=>{
      const set=(id,v)=>{const el=document.getElementById(id); if(el) el.value=v;};
      set('tx-amount', '300');
      set('tx-date', ${JSON.stringify(YESTERDAY)});
      set('tx-note', '昨天补记的');
      return true;
    })()`);
    await sleep(250);
    await ev('document.querySelector(\'[data-dlg-act="save"]\').click()');
    await sleep(600);
    const afterAdd = await cellAt(YESTERDAY);
    ok(!afterAdd.cls.includes("hm-l0"), "刚记的那天不再是「没花钱」那一档（" + afterAdd.cls + "）");
    ok(afterAdd.title.includes("300"), "悬停说明里的金额跟着变成 300（" + afterAdd.title + "）");
    eq((await cellAt(TODAY)).cls.includes("hm-l4"), true, "今天那格没受影响，还在最高档");

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
        path.basename(full).startsWith("小李-记账热力图-")) {
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
